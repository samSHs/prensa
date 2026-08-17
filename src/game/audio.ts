import { clamp } from '../core/rng';

/**
 * Tudo sintetizado — zero arquivos de áudio.
 *
 * Camadas permanentes: zumbido da esteira (dois serrotes batendo), tom de sala
 * (ruído filtrado), e um coração que só aparece quando o perigo passa de ~0.45.
 * Eventos: engatilhar, batida, bipes do terminal, chiado do alto-falante e a
 * "fala" do Zelador (blips graves, estilo terminal, com distorção).
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private beltGain!: GainNode;
  private beltFilter!: BiquadFilterNode;
  private roomGain!: GainNode;
  private heartGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private started = false;
  private heartTimer = 0;
  private whisperTimer = 0;
  /** true enquanto o abafamento pos-morte esta automatizado no master */
  private ducked = false;
  muted = false;

  /** Precisa ser chamado dentro de um gesto do usuário. */
  start(): void {
    if (this.started) return;
    this.started = true;

    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 7;
    this.master.connect(comp).connect(ctx.destination);

    // ---- buffer de ruído reaproveitado por tudo
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ---- esteira
    this.beltGain = ctx.createGain();
    this.beltGain.gain.value = 0.0;
    this.beltFilter = ctx.createBiquadFilter();
    this.beltFilter.type = 'lowpass';
    this.beltFilter.frequency.value = 220;
    this.beltFilter.Q.value = 3;
    this.beltGain.connect(this.beltFilter).connect(this.master);

    for (const [f, type] of [[47, 'sawtooth'], [70.5, 'sawtooth'], [23.5, 'square']] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = type === 'square' ? 0.5 : 0.28;
      o.connect(g).connect(this.beltGain);
      o.start();
    }

    // ---- tom de sala
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0.035;
    const roomSrc = ctx.createBufferSource();
    roomSrc.buffer = this.noiseBuf;
    roomSrc.loop = true;
    const roomFilter = ctx.createBiquadFilter();
    roomFilter.type = 'bandpass';
    roomFilter.frequency.value = 180;
    roomFilter.Q.value = 0.6;
    roomSrc.connect(roomFilter).connect(this.roomGain).connect(this.master);
    roomSrc.start();

    // ---- coração
    this.heartGain = ctx.createGain();
    this.heartGain.gain.value = 0;
    this.heartGain.connect(this.master);
  }

  private get t(): number {
    return this.ctx!.currentTime;
  }

  private noise(dur: number, dest: AudioNode, gain = 1): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, this.t);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + dur);
    s.connect(g).connect(dest);
    s.start();
    s.stop(this.t + dur + 0.05);
    return s;
  }

  /** Chamado todo frame. */
  update(dt: number, o: { beltSpeed: number; danger: number; alive: boolean }): void {
    if (!this.ctx || this.muted) {
      if (this.ctx) this.master.gain.value = this.muted ? 0 : 0.9;
      return;
    }
    // nao encostar no master enquanto o duck da morte esta rodando, senao a
    // automacao e sobrescrita a cada quadro e o silencio nunca acontece
    if (!this.ducked) this.master.gain.value = 0.9;

    const spd = clamp(Math.abs(o.beltSpeed), 0, 3);
    this.beltGain.gain.value = o.alive ? 0.10 + spd * 0.11 : 0.02;
    this.beltFilter.frequency.value = 170 + spd * 260 + o.danger * 180;
    this.roomGain.gain.value = 0.03 + o.danger * 0.05;

    // ---- coração
    if (o.alive && o.danger > 0.4) {
      const bpm = 58 + o.danger * 92;
      this.heartTimer -= dt;
      if (this.heartTimer <= 0) {
        this.heartTimer = 60 / bpm;
        this.thump(0.12 + o.danger * 0.28);
        window.setTimeout(() => this.thump(0.07 + o.danger * 0.16), 150);
      }
    }

    // ---- sussurros: só existem quando o perigo é alto. Você não tem certeza
    //      se ouviu.
    if (o.alive && o.danger > 0.55) {
      this.whisperTimer -= dt;
      if (this.whisperTimer <= 0) {
        this.whisperTimer = 2.5 + Math.random() * 6;
        this.whisper();
      }
    }
  }

  private thump(gain: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(72, this.t);
    o.frequency.exponentialRampToValueAtTime(34, this.t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, this.t);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + 0.22);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(this.t + 0.25);
  }

  private whisper(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(700 + Math.random() * 900, this.t);
    f.frequency.linearRampToValueAtTime(400 + Math.random() * 500, this.t + 0.9);
    f.Q.value = 9;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    g.connect(f).connect(pan).connect(this.master);
    this.noise(0.9, g, 1);
  }

  /** Prensa engatilhando: varredura ascendente + ar comprimido. */
  charge(dur: number): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(38, this.t);
    o.frequency.exponentialRampToValueAtTime(150, this.t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(300, this.t);
    f.frequency.exponentialRampToValueAtTime(1500, this.t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, this.t);
    g.gain.exponentialRampToValueAtTime(0.16, this.t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + dur + 0.05);
    o.connect(f).connect(g).connect(this.master);
    o.start();
    o.stop(this.t + dur + 0.1);
  }

  /** A batida. Golpe no peito + estilhaço metálico. */
  slam(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, this.t);
    o.frequency.exponentialRampToValueAtTime(22, this.t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.85, this.t);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + 0.55);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(this.t + 0.6);

    const hit = ctx.createGain();
    hit.gain.value = 0.5;
    const hf = ctx.createBiquadFilter();
    hf.type = 'highpass';
    hf.frequency.value = 900;
    hit.connect(hf).connect(this.master);
    this.noise(0.35, hit, 0.9);

    // ressonância do aço
    for (const f of [312, 487, 733, 1190]) {
      const r = ctx.createOscillator();
      r.type = 'triangle';
      r.frequency.value = f * (0.99 + Math.random() * 0.02);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.055, this.t + 0.005);
      rg.gain.exponentialRampToValueAtTime(0.0001, this.t + 1.4 + Math.random() * 0.6);
      r.connect(rg).connect(this.master);
      r.start();
      r.stop(this.t + 2.2);
    }
  }

  /**
   * O golpe que te mata. Não é a batida normal com o volume alto: é outra
   * coisa, em quatro camadas — sub que some para 12 Hz, esmagamento de chapa,
   * um estalo curto e molhado, e cauda longa de aço. No fim o mixer é
   * abafado até quase zero por dois segundos, porque o silêncio depois é o
   * que faz o som anterior parecer grande.
   */
  deathSlam(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = this.t;

    // 1. sub: a massa chegando
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(160, t0);
    sub.frequency.exponentialRampToValueAtTime(12, t0 + 1.1);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(1.6, t0);
    subG.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    sub.connect(subG).connect(this.master);
    sub.start(t0);
    sub.stop(t0 + 1.6);

    // 2. esmagamento: ruído por passa-baixa despencando
    const crush = ctx.createGain();
    crush.gain.value = 1.1;
    const cf = ctx.createBiquadFilter();
    cf.type = 'lowpass';
    cf.frequency.setValueAtTime(5200, t0);
    cf.frequency.exponentialRampToValueAtTime(120, t0 + 0.7);
    cf.Q.value = 6;
    crush.connect(cf).connect(this.master);
    this.noise(0.75, crush, 1);

    // 3. estalo: banda estreita e curta, o osso
    const snap = ctx.createGain();
    snap.gain.value = 0.7;
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 260;
    sf.Q.value = 14;
    snap.connect(sf).connect(this.master);
    this.noise(0.09, snap, 1);

    // 4. cauda: a estrutura inteira ressoando
    for (const f of [58, 143, 287, 431, 719, 1103]) {
      const r = ctx.createOscillator();
      r.type = 'triangle';
      r.frequency.value = f * (0.985 + Math.random() * 0.03);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.12, t0 + 0.01);
      rg.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.4 + Math.random());
      r.connect(rg).connect(this.master);
      r.start(t0);
      r.stop(t0 + 3.6);
    }

    // 5. o silêncio
    this.ducked = true;
    const g = this.master.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(1.35, t0);
    g.linearRampToValueAtTime(1.35, t0 + 0.5);
    g.exponentialRampToValueAtTime(0.05, t0 + 1.9);
    g.linearRampToValueAtTime(0.5, t0 + 4.2);
  }

  /** Devolve o mixer ao normal (reinicio de partida). */
  undock(): void {
    this.ducked = false;
    if (this.ctx) {
      this.master.gain.cancelScheduledValues(this.t);
      this.master.gain.setValueAtTime(0.9, this.t);
    }
  }

  /** Chiado de alto-falante antes da voz. */
  crackle(): void {
    if (!this.ctx || this.muted) return;
    const g = this.ctx.createGain();
    g.gain.value = 0.09;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 1.4;
    g.connect(f).connect(this.master);
    this.noise(0.22, g, 1);
  }

  /** Um "fonema" do Zelador. Grave, sujo, sem nenhuma vogal reconhecível. */
  say(index: number): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const base = 78 + ((index * 37) % 26);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(base, this.t);
    o.frequency.linearRampToValueAtTime(base * 0.86, this.t + 0.055);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 620 + ((index * 91) % 420);
    f.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10, this.t);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + 0.07);
    o.connect(f).connect(g).connect(this.master);
    o.start();
    o.stop(this.t + 0.09);
  }

  beep(freq = 880, dur = 0.05, gain = 0.06): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, this.t);
    g.gain.exponentialRampToValueAtTime(0.0001, this.t + dur);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(this.t + dur + 0.02);
  }

  good(): void {
    this.beep(660, 0.06, 0.07);
    window.setTimeout(() => this.beep(990, 0.09, 0.06), 70);
  }

  bad(): void {
    this.beep(180, 0.14, 0.10);
    window.setTimeout(() => this.beep(120, 0.22, 0.09), 90);
  }

  /** Ruptura hidráulica: golpe grave, metal cedendo e vapor que demora a morrer. */
  pipeBurst(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = this.t;

    const blast = ctx.createGain();
    blast.gain.setValueAtTime(0.95, t0);
    blast.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
    const blastFilter = ctx.createBiquadFilter();
    blastFilter.type = 'bandpass';
    blastFilter.frequency.setValueAtTime(780, t0);
    blastFilter.frequency.exponentialRampToValueAtTime(120, t0 + 0.32);
    blastFilter.Q.value = 0.7;
    blast.connect(blastFilter).connect(this.master);
    this.noise(0.38, blast, 1);

    const pressure = ctx.createOscillator();
    pressure.type = 'sawtooth';
    pressure.frequency.setValueAtTime(118, t0);
    pressure.frequency.exponentialRampToValueAtTime(24, t0 + 0.72);
    const pressureGain = ctx.createGain();
    pressureGain.gain.setValueAtTime(0.72, t0);
    pressureGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.82);
    pressure.connect(pressureGain).connect(this.master);
    pressure.start(t0);
    pressure.stop(t0 + 0.86);

    const steam = ctx.createGain();
    steam.gain.setValueAtTime(0.0001, t0);
    steam.gain.exponentialRampToValueAtTime(0.34, t0 + 0.08);
    steam.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.15);
    const steamFilter = ctx.createBiquadFilter();
    steamFilter.type = 'highpass';
    steamFilter.frequency.setValueAtTime(2600, t0);
    steamFilter.frequency.exponentialRampToValueAtTime(850, t0 + 2.0);
    steam.connect(steamFilter).connect(this.master);
    this.noise(2.2, steam, 1);

    for (const frequency of [184, 337, 611]) {
      const metal = ctx.createOscillator();
      metal.type = 'triangle';
      metal.frequency.value = frequency * (0.97 + Math.random() * 0.06);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.13, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2 + Math.random() * 0.7);
      metal.connect(gain).connect(this.master);
      metal.start(t0);
      metal.stop(t0 + 2.0);
    }
  }

  /** Arco atravessando a caixa e o corpo: estalos irregulares sobre um grave curto. */
  electrocution(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = this.t;

    const arc = ctx.createGain();
    arc.gain.setValueAtTime(0.0001, t0);
    const arcFilter = ctx.createBiquadFilter();
    arcFilter.type = 'highpass';
    arcFilter.frequency.value = 1750;
    arc.connect(arcFilter).connect(this.master);
    for (let i = 0; i < 8; i++) {
      const at = t0 + i * 0.075 + (i % 3) * 0.011;
      arc.gain.setValueAtTime(0.0001, at);
      arc.gain.exponentialRampToValueAtTime(i === 0 ? 0.82 : 0.38, at + 0.006);
      arc.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
    }
    this.noise(0.72, arc, 1);

    const body = ctx.createOscillator();
    body.type = 'square';
    body.frequency.setValueAtTime(92, t0);
    body.frequency.exponentialRampToValueAtTime(38, t0 + 0.58);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.46, t0);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7);
    body.connect(bodyGain).connect(this.master);
    body.start(t0);
    body.stop(t0 + 0.74);

    for (const frequency of [970, 1440, 2310]) {
      const whine = ctx.createOscillator();
      whine.type = 'sawtooth';
      whine.frequency.setValueAtTime(frequency, t0);
      whine.frequency.exponentialRampToValueAtTime(frequency * 0.58, t0 + 0.5);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.055, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
      whine.connect(gain).connect(this.master);
      whine.start(t0);
      whine.stop(t0 + 0.66);
    }
  }

  alarm(): void {
    if (!this.ctx || this.muted) return;
    for (let i = 0; i < 3; i++) {
      window.setTimeout(() => this.beep(1400, 0.11, 0.05), i * 160);
    }
  }

  /**
   * A morte de alguém no rádio precisa existir fisicamente no jogo.
   *
   * Não é uma fala limpa: a voz bate no limitador barato do transmissor,
   * rasga em duas formantes, derruba o microfone e vira estática. O compressor
   * do master segura o pico, mas a região média fica deliberadamente na frente
   * da esteira e da voz do Zelador.
   */
  victimScream(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t0 = this.t;

    const radio = ctx.createGain();
    radio.gain.setValueAtTime(0.0001, t0);
    radio.gain.exponentialRampToValueAtTime(0.58, t0 + 0.025);
    radio.gain.setValueAtTime(0.58, t0 + 0.46);
    radio.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.08);

    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 3.8);
    }
    clip.curve = curve;
    clip.oversample = '2x';

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1650, t0);
    band.frequency.linearRampToValueAtTime(760, t0 + 0.9);
    band.Q.value = 0.8;
    radio.connect(clip).connect(band).connect(this.master);

    for (const [base, amount] of [[230, 1], [455, 0.42], [710, 0.2]] as const) {
      const voice = ctx.createOscillator();
      voice.type = base === 230 ? 'sawtooth' : 'square';
      voice.frequency.setValueAtTime(base, t0);
      voice.frequency.exponentialRampToValueAtTime(base * 1.72, t0 + 0.24);
      voice.frequency.exponentialRampToValueAtTime(base * 0.54, t0 + 0.96);
      const vg = ctx.createGain();
      vg.gain.value = amount;
      voice.connect(vg).connect(radio);
      voice.start(t0);
      voice.stop(t0 + 1.12);
    }

    // Respiração/rasgo da garganta e, depois, o rádio sem ninguém nele.
    const breath = ctx.createGain();
    breath.gain.value = 0.36;
    breath.connect(radio);
    this.noise(1.02, breath, 1);

    const staticGain = ctx.createGain();
    staticGain.gain.setValueAtTime(0.0001, t0);
    staticGain.gain.setValueAtTime(0.0001, t0 + 0.72);
    staticGain.gain.exponentialRampToValueAtTime(0.26, t0 + 0.86);
    staticGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.62);
    const staticFilter = ctx.createBiquadFilter();
    staticFilter.type = 'highpass';
    staticFilter.frequency.value = 2100;
    staticGain.connect(staticFilter).connect(this.master);
    this.noise(1.65, staticGain, 1);

    window.setTimeout(() => this.beep(74, 0.16, 0.18), 1040);
  }
}
