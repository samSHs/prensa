import './style.css';

import { Audio } from './game/audio';
import { Belt } from './game/belt';
import { TensionDirector } from './game/director';
import { Interrupts, type AttentionKind } from './game/interrupts';
import { DEATH_LINES, ESCAPE_LINES, Voice, introFor } from './game/voice';
import { interferenceKind } from './missions/interference';
import {
  labyrinthKind,
  MissionDeck,
  valveKind,
  wireKind,
  type TransmissionOffer,
} from './missions/registry';
import type { Mission, Resolution } from './missions/types';
import { AsciiRenderer, QUALITY_HIGH, QUALITY_LOW } from './render/renderer';
import { Hud } from './ui/hud';
import { DOOR, MASK_FRAMES, SKULL } from './ui/mask';
import { Terminal } from './ui/terminal';
import { Training } from './ui/training';
import { World } from './world/world';

/* ---------------------------------------------------------------- balanço
 *
 * Regra de ouro: acertar tudo faz você ganhar terreno DEVAGAR; errar tira
 * metros e acelera a linha. A esteira deriva sozinha o tempo inteiro, então
 * "jogar seguro" é matematicamente impossível — só existe jogar rápido e
 * certo. É daqui que vem a pressão, não de enigmas injustos.
 */
const START_DISTANCE = 11;
const HATCH = 26;
const EXIT_KEYS = 4;
const BASE_SPEED = 0.16;

const GOOD_BASE = 0.95;
const GOOD_SPEED_BONUS = 0.65;
const NEUTRAL_GAIN = 0.2;
const BAD_SHOVE = 1.7;
const BAD_ESCALATE = 0.032;
const FATAL_SHOVE = 3.6;
const FATAL_ESCALATE = 0.09;
const MISSION_WIN_GAIN = 2.9;
const LOCK_HIT_GAIN = 0.45;
const LOCK_MISS_SHOVE = 1.35;
const INSPECTION_HIT_GAIN = 0.25;
const INSPECTION_MISS_SHOVE = 1.15;
const RIPPED_KEY_GAIN = 3.9;
const RIPPED_KEY_ACCELERATE = 0.075;
const RIPPED_KEY_PRESSURE = 0.08;
const RIP_HOLD = 2.3;

type Phase = 'title' | 'training' | 'intro' | 'playing' | 'dead' | 'won';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

class Game {
  private renderer: AsciiRenderer;
  private world: World;
  private audio = new Audio();
  private voice: Voice;
  private terminal: Terminal;
  private training: Training;
  private hud: Hud;
  private interrupts: Interrupts;
  private director!: TensionDirector;

  /** exposto só com ?debug — ver o gancho no fim do arquivo */
  belt!: Belt;
  private deck!: MissionDeck;
  private mission: Mission | null = null;
  private pending: Resolution | null = null;
  private offers: readonly [TransmissionOffer, TransmissionOffer] | null = null;
  private selectedOffer: TransmissionOffer | null = null;
  private rippedPending = false;
  private ripping = false;
  private ripHeld = 0;
  private ripPaintClock = 0;

  private phase: Phase = 'title';
  private introIndex = 0;
  private introLines: readonly string[] = introFor(0);
  /** quantas vezes esta aba já começou uma partida */
  private runCount = 0;
  private elapsed = 0;
  private missionsDone = 0;
  private keys = 0;
  private earnedKeys = 0;
  private rippedKeys = 0;
  private streak = 0;
  private escalationPhase = 0;
  private glitch = 0;
  private shake = 0;
  private chargedFor = 0;
  private nearTaunt = 0;
  private subliminalTimer = 6;
  /** segundos desde o esmagamento; -1 enquanto vivo */
  private deathT = -1;
  private deathScreenShown = false;
  /** telas de fim ignoram teclado ate aqui — quem morre com o dedo no [1]
   *  pulava a tela de morte antes de ela aparecer */
  private screenArmedAt = 0;
  /** suprime o click sintetizado que costuma vir depois de um pointerdown já
   * consumido por uma trava/inspeção. */
  private suppressPointerUntil = 0;
  /** ESC durante a partida arma a saída; o segundo ESC confirma */
  private abandonArmedUntil = 0;
  private last = performance.now();

  // --- vigia de desempenho: mede os primeiros quadros e cai para o modo leve
  //     sozinho se a maquina nao aguentar. GPU velha nao devia exigir que o
  //     jogador descubra um menu de opcoes.
  private frameSamples: number[] = [];
  private perfChecked = false;

  private screen = $('#screen');
  private screenArt = $('#screen-art');
  private screenTitle = $('#screen-title');
  private screenText = $('#screen-text');
  private screenBtn = $<HTMLButtonElement>('#screen-btn');
  private screenTraining = $<HTMLButtonElement>('#screen-training');
  private screenHint = $('#screen-hint');
  private flashEl = $('#flash');
  private sublimEl = $('#subliminal');
  private sublimArt = $('#subliminal-art');
  private introHint = $('#intro-hint');
  private inspectionEl = $('#inspection');
  constructor() {
    this.renderer = new AsciiRenderer($<HTMLCanvasElement>('#view'));
    this.world = new World(this.renderer.aspect, HATCH);

    this.voice = new Voice($('#voice'), $('#voice-who'), $('#voice-line'), this.audio);

    this.terminal = new Terminal($('#terminal'), this.audio, {
      onChoose: (id) => this.onChoose(id),
      onAdvance: () => this.onAdvance(),
    });

    this.training = new Training(
      $('#training'),
      [labyrinthKind, valveKind, wireKind, interferenceKind],
      this.audio,
      () => {
        this.resetRun();
        this.showTitle();
      },
    );

    this.hud = new Hud($('#hud'));

    this.interrupts = new Interrupts($('#lock'), $('#lock-keys'), $('#lock-bar'), this.audio, {
      onHit: (kind: AttentionKind) => {
        this.belt?.gain(kind === 'INSPECTION' ? INSPECTION_HIT_GAIN : LOCK_HIT_GAIN);
        this.director?.interruptFinished(kind, true);
      },
      onMiss: (kind: AttentionKind) => {
        this.belt?.shove(
          kind === 'INSPECTION' ? INSPECTION_MISS_SHOVE : LOCK_MISS_SHOVE,
          kind === 'INSPECTION' ? 0.025 : 0.035,
        );
        this.punch(0.35);
        if (kind === 'INSPECTION') this.voice.say('Eu vi.', { urgent: true, hold: 1.1 });
        else this.voice.interruptFail();
        this.director?.interruptFinished(kind, false);
      },
    });

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (this.phase === 'playing' && this.interrupts.pointer()) {
          this.suppressPointerUntil = performance.now() + 900;
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    for (const eventName of ['pointerup', 'click', 'contextmenu'] as const) {
      window.addEventListener(eventName, (event) => {
        if (performance.now() > this.suppressPointerUntil) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (eventName === 'click' || eventName === 'contextmenu') this.suppressPointerUntil = 0;
      }, true);
    }
    this.screenBtn.addEventListener('click', () => this.onScreenButton());
    this.screenTraining.addEventListener('click', () => this.openTraining());

    this.resetRun();
    this.showTitle();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ ciclo

  private resetRun(): void {
    const runSeed = (Math.random() * 0x7fffffff) | 0;
    this.belt = new Belt(
      {
        onImpact: (crushed) => this.onImpact(crushed),
        onDeath: () => this.onDeath(),
        onEscape: () => this.onEscape(),
        onHatchBlocked: () => this.onHatchBlocked(),
      },
      { start: START_DISTANCE, hatch: HATCH, base: BASE_SPEED },
    );
    this.deck = new MissionDeck(runSeed ^ 0x2f6e2b1);
    this.director = new TensionDirector(runSeed ^ 0x6a09e667);
    this.mission = null;
    this.pending = null;
    this.offers = null;
    this.selectedOffer = null;
    this.rippedPending = false;
    this.ripping = false;
    this.ripHeld = 0;
    this.ripPaintClock = 0;
    this.elapsed = 0;
    this.missionsDone = 0;
    this.keys = 0;
    this.earnedKeys = 0;
    this.rippedKeys = 0;
    this.streak = 0;
    this.escalationPhase = 0;
    this.introIndex = 0;
    this.glitch = 0;
    this.shake = 0;
    this.chargedFor = 0;
    this.nearTaunt = 0;
    this.subliminalTimer = 6;
    this.deathT = -1;
    this.deathScreenShown = false;
    this.audio.undock();
    this.interrupts.reset(runSeed ^ 0x0badc0de);
    this.voice.clear();
    this.terminal.hide();
    this.hud.show(false);
    this.introHint.hidden = true;
    this.training.close();
  }

  private get difficulty(): number {
    return this.missionsDone * 0.18 + this.keys * 0.1 + this.elapsed / 420;
  }

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    if (this.phase === 'intro') this.tickIntro(dt);
    if (this.phase === 'playing') this.tickPlaying(dt);
    if (this.phase === 'training') this.training.update(dt);
    if (this.phase === 'dead' && this.deathT >= 0) this.tickDeath(dt);
    this.syncInspectionVisual();

    const danger = this.belt.danger;

    this.voice.update(dt, danger);
    // A esteira corre cheia durante a PERGUNTA e a 55% durante o retorno.
    const beltScale =
      this.phase === 'intro' ? 1
      : this.phase === 'playing' ? (this.terminal.asking ? 1 : 0.55)
      : 0;
    this.belt.update(dt * beltScale);

    // a prensa avisa antes de cair. Trava por ciclo — o período muda o tempo
    // todo, então contar ciclos por tempo decorrido dispararia repetido.
    const upcoming = this.belt.untilImpact;
    if (upcoming > 1.5) this.chargedFor = 0;
    else if (this.chargedFor === 0) {
      this.chargedFor = 1;
      this.audio.charge(Math.max(0.2, upcoming));
    }

    this.shake = Math.max(0, this.shake - dt * 1.8);
    this.glitch = Math.max(danger * 0.42, this.glitch - dt * 1.1);
    document.documentElement.style.setProperty('--shake', `${(Math.random() - 0.5) * this.shake * 14}px`);

    this.world.update(dt, {
      distance: this.belt.distance,
      hatch: HATCH,
      beltVel: this.belt.velocity,
      pressPhase: this.belt.phase,
      danger,
      time: now / 1000,
      slam: this.belt.slam,
      voice: this.voice.active,
      shake: this.shake,
      dead: this.belt.dead,
      escaped: this.belt.escaped,
      crush: this.deathT >= 0 ? Math.max(0.001, this.deathT) : 0,
      keys: this.keys,
      keysNeeded: EXIT_KEYS,
    });

    this.audio.update(dt, {
      beltSpeed: this.belt.velocity,
      danger,
      alive: this.phase === 'playing' || this.phase === 'intro',
    });

    if (this.phase === 'playing') {
      this.hud.update({
        distance: this.belt.distance,
        hatch: HATCH,
        velocity: this.belt.velocity,
        untilImpact: this.belt.untilImpact,
        phase: 1 + Math.floor(this.difficulty),
        danger,
        keys: this.keys,
        keyTotal: EXIT_KEYS,
      });
    }

    this.renderer.render(this.world.scene, this.world.camera, now / 1000, danger, this.glitch);
    this.watchPerf(dt);
    requestAnimationFrame((t) => this.frame(t));
  }

  private tickIntro(dt: number): void {
    this.elapsed += dt * 0.2;
    if (!this.voice.busy) {
      if (this.introIndex < this.introLines.length) {
        // a abertura só anda com ENTER; ninguém perde uma fala por piscar
        this.voice.say(this.introLines[this.introIndex]!, { hold: 1.5, gate: true });
        this.introIndex++;
      } else {
        this.beginPlaying();
      }
    }
  }

  private tickPlaying(dt: number): void {
    this.elapsed += dt;
    this.terminal.update(dt, this.belt.danger);

    if (this.offers && this.terminal.asking && this.ripping) {
      this.ripHeld = Math.min(RIP_HOLD, this.ripHeld + dt);
      this.ripPaintClock -= dt;
      if (this.ripPaintClock <= 0) {
        this.ripPaintClock = 0.06;
        this.terminal.refresh(this.tuningNode(), 'VARREDURA DE TRANSMISSÕES');
      }
      if (this.ripHeld >= RIP_HOLD) this.completeRippedKey();
    }

    // Missões vivas não esperam o jogador clicar. O labirinto move os dois
    // corpos em pulsos próprios e pode terminar entre duas ordens de rádio.
    const live = this.mission?.update?.(dt);
    if (live?.beltGain) this.belt.gain(live.beltGain);
    if (live?.resolution) {
      this.acceptResolution(live.resolution);
    } else if (live?.changed && this.mission) {
      this.terminal.refresh(this.mission.node(), this.mission.name);
    }

    this.interrupts.update(dt);
    const attention = this.mission?.attention?.() ?? {
      load: 0 as const,
      inputRequired: false,
      safeSilenceSeconds: 99,
    };
    const decision = this.director.update(dt, {
      missionsDone: this.missionsDone + this.rippedKeys,
      keys: this.keys,
      difficulty: this.difficulty,
      elapsed: this.elapsed,
      danger: this.belt.danger,
      running: this.terminal.asking && this.mission !== null && this.offers === null,
      interruptActive: this.interrupts.active,
      attentionLoad: attention.load,
      inputRequired: attention.inputRequired,
      safeSilenceSeconds: attention.safeSilenceSeconds,
      decisionFraction: this.terminal.remaining,
      untilImpact: this.belt.untilImpact,
      voiceBusy: this.voice.busy,
    });
    if (decision.event) this.interrupts.start(decision.event, decision.macro);

    // marcos de fase: ele avisa, e a prensa acelera junto
    const target = Math.min(4, Math.floor(this.difficulty));
    if (target > this.escalationPhase && !this.interrupts.active) {
      this.escalationPhase = target;
      this.voice.escalation(this.escalationPhase);
      this.belt.pressure = Math.min(1, this.belt.pressure + 0.06);
      this.punch(0.3);
    }

    // provocação de proximidade
    this.nearTaunt -= dt;
    if (this.belt.distance < 3.2 && this.nearTaunt <= 0 && !this.interrupts.active) {
      this.nearTaunt = 9;
      this.voice.near();
    }

    // flashes subliminares — 4 quadros de máscara, o suficiente para você
    // não ter certeza de que viu
    this.subliminalTimer -= dt;
    if (this.subliminalTimer <= 0) {
      this.subliminalTimer = 14 + Math.random() * 26 - this.belt.danger * 8;
      if (this.belt.danger > 0.35 && !this.interrupts.active) this.flashMask();
    }
  }

  // ------------------------------------------------------------- missões

  private beginPlaying(): void {
    if (this.phase !== 'intro') return; // Enter repetido não inicia doze missões
    this.phase = 'playing';
    this.introHint.hidden = true;
    this.voice.clear(); // se pulou no meio, a fala não invade a primeira missão
    this.hud.show(true);
    this.belt.base = BASE_SPEED;
    this.startTuning();
  }

  /** entra na abertura — a partir da segunda partida, o Zelador encurta */
  private beginIntro(): void {
    this.phase = 'intro';
    this.introLines = introFor(this.runCount);
    this.introIndex = 0;
    this.runCount++;
    this.introHint.hidden = false;
    this.belt.base = 0; // durante o discurso a esteira fica parada. Só o martelo trabalha.
  }

  private startTuning(): void {
    if (this.phase !== 'playing') return;
    this.mission = null;
    this.pending = null;
    this.selectedOffer = null;
    this.rippedPending = false;
    this.ripping = false;
    this.ripHeld = 0;
    this.offers = this.deck.offer(this.difficulty);
    this.terminal.present(this.tuningNode(), 'VARREDURA DE TRANSMISSÕES');
  }

  private offerName(offer: TransmissionOffer): string {
    return offer.kindId === 'labirinto'
      ? 'CÂMERAS DE CONTENÇÃO'
      : offer.kindId === 'purga'
        ? 'REDE HIDRÁULICA'
        : 'CAIXA DE ALTA TENSÃO';
  }

  private tuningNode() {
    const offers = this.offers;
    if (!offers) {
      return { nodeLabel: 'CANAL ENCERRADO', bodyHtml: '', prompt: '', options: [], timeLimit: 1 };
    }
    const channel = (offer: TransmissionOffer, label: string) =>
      `<span class="hl">CANAL ${label}</span>  ${this.offerName(offer)}\n` +
      `PERIGO: <span class="bad">${offer.danger}</span>   JANELA: ${offer.window}   ` +
      `SINAL: <span class="${offer.signal === 'LIMPO' ? 'ok' : 'key'}">${offer.signal}</span>`;
    const filled = Math.round((this.ripHeld / RIP_HOLD) * 18);
    const extraction =
      this.keys >= EXIT_KEYS
        ? '<span class="ok">QUATRO CHAVES · EXTRAÇÃO MANUAL BLOQUEADA</span>'
        : this.ripHeld > 0
        ? `<span class="bad">EXTRAÇÃO [${'█'.repeat(filled)}${'░'.repeat(18 - filled)}]</span>`
        : '<span class="ghost">SEGURE [0] PARA ARRANCAR UMA CHAVE · O CANAL MAIS FRACO SERÁ SELADO</span>';
    return {
      nodeLabel: `ESCUTA ${String(this.missionsDone + this.rippedKeys + 1).padStart(2, '0')}`,
      bodyHtml:
        '<span class="ghost">DUAS PESSOAS. UMA LINHA DISPONÍVEL.</span>\n\n' +
        `${channel(offers[0], 'A')}\n\n${channel(offers[1], 'B')}\n\n${extraction}`,
      prompt: 'Escolha qual transmissão atender. Se o tempo acabar, o painel abre o sinal mais forte.',
      options: [
        { id: offers[0].token, label: `ATENDER CANAL A — ${this.offerName(offers[0])}` },
        { id: offers[1].token, label: `ATENDER CANAL B — ${this.offerName(offers[1])}` },
      ],
      timeLimit: 6.2,
    };
  }

  private startMission(offer: TransmissionOffer): void {
    this.offers = null;
    this.selectedOffer = null;
    this.mission = this.deck.accept(offer.token, this.difficulty);
    this.voice.say(this.mission.brief, { hold: 2.0 });
    this.terminal.present(this.mission.node(), this.mission.name);
  }

  private onChoose(id: string | null): void {
    if (this.offers) {
      const selected =
        this.offers.find((offer) => offer.token === id) ??
        [...this.offers].sort((a, b) => b.strength - a.strength)[0]!;
      this.ripping = false;
      this.ripHeld = 0;
      this.selectedOffer = selected;
      this.terminal.resolve(
        {
          verdict: 'NEUTRAL',
          feedback:
            id === null
              ? `TEMPO ESGOTADO · sinal ${selected.signal.toLowerCase()} sintonizado automaticamente.`
              : `CANAL FIXADO · ${this.offerName(selected)}.`,
          bestOptionId: null,
          finished: false,
          success: false,
        },
        0.72,
      );
      return;
    }
    if (!this.mission) return;
    this.acceptResolution(this.mission.choose(id));
  }

  private completeRippedKey(): void {
    if (!this.offers || !this.terminal.asking || this.keys >= EXIT_KEYS) return;
    const sealed = [...this.offers].sort((a, b) => a.strength - b.strength)[0]!;
    this.deck.discard();
    this.ripping = false;
    this.ripHeld = 0;
    this.rippedPending = true;
    this.offers = null;
    this.rippedKeys++;
    this.keys++;
    this.belt.gain(RIPPED_KEY_GAIN);
    this.belt.base += RIPPED_KEY_ACCELERATE;
    this.belt.pressure = Math.min(1, this.belt.pressure + RIPPED_KEY_PRESSURE);
    if (this.keys === EXIT_KEYS) this.belt.unlockExit();

    this.audio.victimScream();
    this.punch(1.05);
    this.glitch = 1;
    this.flashEl.style.background = '#9b0000';
    this.flashEl.style.transition = 'opacity 1300ms ease-out';
    this.flashEl.style.opacity = '0.82';
    window.setTimeout(() => (this.flashEl.style.opacity = '0'), 45);
    window.setTimeout(() => (this.flashEl.style.background = ''), 1400);
    this.voice.say('Canal selado. Chave recuperada.', { urgent: true, hold: 2.5 });
    this.director.missionFinished('SACRIFICED');
    this.terminal.resolve(
      {
        verdict: 'BAD',
        feedback:
          `EXTRAÇÃO CONCLUÍDA · ${this.offerName(sealed)} foi selada com a portadora ainda dentro. ` +
          'A chave veio molhada.',
        bestOptionId: null,
        finished: true,
        success: false,
      },
      3.5,
    );
  }

  private acceptResolution(res: Resolution): void {
    if (res.finished && this.interrupts.active) this.interrupts.cancel();
    this.pending = res;
    const liveCommand = this.mission?.live === true && !res.finished;

    // No labirinto, apertar botões só muda a intenção da refém. O crédito da
    // esteira vem de progresso físico nos pulsos, então spam nunca rende fuga.
    if (!liveCommand) {
      this.applyVerdict(res);
    } else {
      this.audio.beep(res.verdict === 'BAD' ? 260 : 620, 0.055, 0.04);
    }

    const hold = this.mission?.live
      ? !res.finished ? 0.35
      : res.verdict === 'FATAL' ? 4.8
      : res.verdict === 'GOOD' ? 2.8
      : 3.4
      : (res.verdict === 'GOOD' ? 1.5 : res.verdict === 'FATAL' ? 4.2 : 3.4) + (res.finished ? 0.8 : 0);
    this.terminal.resolve(res, hold);
  }

  private onAdvance(): void {
    if (this.selectedOffer) {
      const selected = this.selectedOffer;
      this.startMission(selected);
      return;
    }
    if (this.rippedPending) {
      this.rippedPending = false;
      if (this.phase === 'playing') this.startTuning();
      return;
    }
    const res = this.pending;
    this.pending = null;
    if (!res || !this.mission) return;

    if (res.finished) {
      this.missionsDone++;
      this.director.missionFinished(res.verdict);
      if (res.success) {
        const gainedKey = this.keys < EXIT_KEYS;
        if (gainedKey) {
          this.keys++;
          this.earnedKeys++;
          if (this.keys === EXIT_KEYS) this.belt.unlockExit();
        }
        this.belt.gain(MISSION_WIN_GAIN);
        this.belt.pressure = Math.min(1, this.belt.pressure + 0.11);
        if (gainedKey) this.voice.keyAcquired(this.keys, EXIT_KEYS);
        else this.voice.missionWin();
      } else {
        // O nó final já aplicou BAD/FATAL em `applyVerdict`; somar a antiga
        // punição genérica cobrava duas vezes pelo mesmo erro.
        this.punch(0.3);
        this.voice.missionLose();
      }
      if (res.epilogue) this.voice.say(res.epilogue, { hold: 2.4 });
      if (this.phase === 'playing') this.startTuning();
      return;
    }

    this.terminal.present(this.mission.node(), this.mission.name);
  }

  private applyVerdict(res: Resolution): void {
    const speed = this.terminal.remaining;

    switch (res.verdict) {
      case 'GOOD': {
        this.streak++;
        const mult = 1 + Math.min(this.streak, 6) * 0.067;
        let gain = (GOOD_BASE + speed * GOOD_SPEED_BONUS) * mult;
        // rede de segurança discreta: colado na prensa, um acerto vale mais
        if (this.belt.distance < 1.8) gain += 1.5;
        this.belt.gain(gain);
        this.audio.good();
        this.voice.good();
        break;
      }
      case 'NEUTRAL': {
        this.streak = 0;
        this.belt.gain(NEUTRAL_GAIN);
        this.audio.beep(520, 0.06, 0.05);
        break;
      }
      case 'BAD': {
        this.streak = 0;
        this.director.commonError();
        this.belt.shove(BAD_SHOVE, BAD_ESCALATE);
        this.audio.bad();
        this.voice.bad();
        this.punch(0.45);
        this.glitch = 0.85;
        break;
      }
      case 'FATAL': {
        this.streak = 0;
        this.belt.shove(FATAL_SHOVE, FATAL_ESCALATE);
        const delayedFatal = (delay: number) => {
          const run = this.runCount;
          window.setTimeout(() => {
            if (this.runCount === run && this.phase === 'playing') this.voice.fatal();
          }, delay);
        };
        if (res.cue === 'VICTIM_SCREAM') {
          this.audio.victimScream();
          this.flashEl.style.transition = 'opacity 900ms ease-out';
          this.flashEl.style.opacity = '0.58';
          window.setTimeout(() => (this.flashEl.style.opacity = '0'), 35);
          delayedFatal(1450);
        } else if (res.cue === 'PIPE_BURST') {
          this.audio.pipeBurst();
          this.flashEl.style.background = '#ff5a1f';
          this.flashEl.style.transition = 'opacity 1250ms ease-out';
          this.flashEl.style.opacity = '0.72';
          window.setTimeout(() => (this.flashEl.style.opacity = '0'), 55);
          window.setTimeout(() => (this.flashEl.style.background = ''), 1350);
          delayedFatal(900);
        } else if (res.cue === 'ELECTROCUTION') {
          this.audio.electrocution();
          this.flashEl.style.background = '#dffcff';
          this.flashEl.style.transition = 'opacity 25ms linear';
          for (let i = 0; i < 7; i++) {
            window.setTimeout(() => (this.flashEl.style.opacity = i % 2 === 0 ? '0.82' : '0'), i * 52);
          }
          window.setTimeout(() => {
            this.flashEl.style.opacity = '0';
            this.flashEl.style.background = '';
          }, 410);
          delayedFatal(650);
        } else {
          this.audio.bad();
          this.voice.fatal();
        }
        this.punch(res.cue === 'PIPE_BURST' || res.cue === 'ELECTROCUTION' ? 1.25 : 0.9);
        this.glitch = 1;
        this.flashMask(res.cue === 'PIPE_BURST' || res.cue === 'ELECTROCUTION' ? 360 : 240);
        break;
      }
    }
  }

  // ------------------------------------------------------------- eventos

  private onImpact(crushed: boolean): void {
    this.world.onSlam();
    // quando esmaga, o som do golpe é o `deathSlam` — dois estrondos
    // empilhados viravam papelão
    if (!crushed) {
      this.audio.slam();
      this.punch(0.55);
      this.flashEl.style.transition = 'opacity 90ms linear';
      this.flashEl.style.opacity = '0.12';
      window.setTimeout(() => (this.flashEl.style.opacity = '0'), 90);
    }
  }

  private onHatchBlocked(): void {
    if (this.phase === 'dead' || this.phase === 'won') return;
    this.audio.bad();
    this.punch(0.35);
    this.glitch = Math.max(this.glitch, 0.55);
    this.voice.hatchLocked(this.keys, EXIT_KEYS);
  }

  private onDeath(): void {
    this.phase = 'dead';
    this.terminal.hide();
    this.hud.show(false);
    this.interrupts.reset();
    this.voice.clear();

    this.deathT = 0;
    this.deathScreenShown = false;
    this.glitch = 1;
    this.punch(3.2);
    this.world.onSlam();
    this.audio.deathSlam();

    // clarão longo, não pisca: a tela fica lavada e desce devagar
    this.flashEl.style.transition = 'opacity 1400ms ease-out';
    this.flashEl.style.opacity = '0.95';
    window.setTimeout(() => (this.flashEl.style.opacity = '0'), 60);
  }

  /** A morte é uma cena de ~3s, não um corte. */
  private tickDeath(dt: number): void {
    const before = this.deathT;
    this.deathT += dt;

    // segundo estalo quando a estrutura assenta
    if (before < 0.55 && this.deathT >= 0.55) {
      this.world.onSlam();
      this.punch(0.9);
    }
    if (before < 1.9 && this.deathT >= 1.9) {
      this.voice.say(DEATH_LINES[Math.floor(Math.random() * DEATH_LINES.length)]!, { urgent: true, hold: 3 });
    }

    if (!this.deathScreenShown && this.deathT >= 3.4) {
      this.deathScreenShown = true;
      this.showScreen({
        art: SKULL,
        title: 'FIM',
        text:
          `Você aguentou ${this.fmtTime(this.elapsed)} e ${this.missionsDone} ${this.missionsDone === 1 ? 'missão' : 'missões'}.\n` +
          `${this.earnedKeys} chaves conquistadas · ${this.rippedKeys} arrancadas.\n` +
          `A esteira estava a ${this.belt.base.toFixed(2)} m/s quando parou de importar.\n\n` +
          'A linha foi lavada. A próxima carga já está sendo descarregada.',
        btn: 'DE NOVO',
        hint: `as ${EXIT_KEYS} travas voltaram ao lugar`,
      });
    }
  }

  private onEscape(): void {
    this.phase = 'won';
    this.terminal.hide();
    this.hud.show(false);
    this.interrupts.reset();
    this.voice.say(ESCAPE_LINES[Math.floor(Math.random() * ESCAPE_LINES.length)]!, { urgent: true, hold: 3 });

    window.setTimeout(() => {
      const title = this.rippedKeys === 0 ? 'FORA' : this.rippedKeys === EXIT_KEYS ? 'PROMOVIDO' : 'LIBERADO';
      const ending =
        this.rippedKeys === 0
          ? 'A escotilha dá num corredor. O corredor dá em outra sala.\n' +
            'A luz da cabine continuou acesa depois que você saiu.'
          : this.rippedKeys === EXIT_KEYS
            ? 'A escotilha não dá na rua. Dá na cabine do Zelador.\n' +
              'Há uma cadeira vazia, dois canais pedindo ajuda e um microfone esperando sua voz.'
            : 'Do outro lado da escotilha, os canais que você selou continuam abertos.\n' +
              'Você reconhece cada voz. Nenhuma delas reconhece a sua.';
      this.showScreen({
        art: DOOR,
        title,
        text:
          `Vinte e seis metros em ${this.fmtTime(this.elapsed)}, ${this.missionsDone} ${this.missionsDone === 1 ? 'missão' : 'missões'}.\n` +
          `${this.earnedKeys} chaves conquistadas · ${this.rippedKeys} arrancadas.\n` +
          `Velocidade final da esteira: ${this.belt.base.toFixed(2)} m/s.\n\n` +
          ending,
        btn: 'OUTRA VEZ',
        hint: this.rippedKeys === 0 ? 'ele disse que todos voltam' : 'a cabine já sabe o seu nome',
      });
    }, 2200);
  }

  private onKey(e: KeyboardEvent): void {
    // Saída para o menu. Vem antes de tudo — travas e inspeções sequestram o
    // teclado de propósito, e a porta de saída não pode ser sequestrável.
    if (e.key === 'Escape' && (this.phase === 'playing' || this.phase === 'dead' || this.phase === 'won')) {
      e.preventDefault();
      this.abandonRun();
      return;
    }
    if (this.phase === 'playing' && this.interrupts.key(e.key, e.repeat)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (this.phase === 'training' && this.training.key(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      this.audio.muted = !this.audio.muted;
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      this.perfChecked = true; // escolha manual manda no detector
      this.setQuality(!this.renderer.isHigh);
      this.toast(this.renderer.isHigh ? 'QUALIDADE ALTA' : 'MODO DESEMPENHO');
      return;
    }
    if (this.phase === 'title' || this.phase === 'dead' || this.phase === 'won') {
      if ((e.key === 'Enter' || e.key === ' ') && performance.now() >= this.screenArmedAt) {
        e.preventDefault();
        this.onScreenButton();
      }
      return;
    }
    if (this.phase === 'intro') {
      if (e.key === 'Escape') {
        this.beginPlaying();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.voice.advance();
      }
      return;
    }
    if (this.offers && this.keys < EXIT_KEYS && e.key === '0') {
      e.preventDefault();
      this.ripping = true;
      return;
    }
    const shortcut = !e.repeat ? this.mission?.shortcut?.(e.key) : null;
    if (shortcut) {
      e.preventDefault();
      this.acceptResolution(shortcut);
      return;
    }
    // Autorepeat não pode atravessar o breve feedback e escolher de novo no
    // painel seguinte. Interferências continuam recebendo repeat no início do
    // handler, onde possuem suas próprias regras.
    if (!e.repeat && this.terminal.key(e.key)) e.preventDefault();
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key !== '0' || !this.ripping) return;
    this.ripping = false;
    this.ripHeld = 0;
    if (this.offers && this.terminal.asking) {
      this.terminal.refresh(this.tuningNode(), 'VARREDURA DE TRANSMISSÕES');
    }
  }

  private onResize(): void {
    this.renderer.resize();
    this.world.setAspect(this.renderer.aspect);
  }

  // ------------------------------------------------------------- telas

  private showTitle(): void {
    this.phase = 'title';
    this.showScreen({
      art: MASK_FRAMES[0],
      title: 'PRENSA',
      text:
        'Você não vai conseguir pensar com calma. Esse é o ponto.\n\n' +
        '[1]…[6] respondem   ·   missão vencida libera uma das quatro chaves\n' +
        '[0] controla o transmissor quando o rádio está aberto\n' +
        'travas e inspeções tomam o controle da entrada\n' +
        '[ENTER] avança a fala   ·   [ESC] pula a abertura\n' +
        '[ESC] duas vezes na partida volta para este menu\n' +
        '[M] silencia   ·   fones de ouvido são recomendados',
      btn: 'JOGAR',
      hint: 'TREINAMENTO ensina cada protocolo fora da campanha',
      training: true,
    });
  }

  private syncInspectionVisual(): void {
    const visible =
      this.phase === 'playing' &&
      this.interrupts.active &&
      this.interrupts.kind === 'INSPECTION';
    this.inspectionEl.hidden = !visible;
    if (visible) this.inspectionEl.dataset.stage = this.interrupts.stage.toLowerCase();
    else delete this.inspectionEl.dataset.stage;
  }

  private showScreen(o: {
    art: string;
    title: string;
    text: string;
    btn: string;
    hint: string;
    training?: boolean;
  }): void {
    this.screenArmedAt = performance.now() + 1200;
    this.screenArt.textContent = o.art;
    this.screenTitle.textContent = o.title;
    this.screenText.textContent = o.text;
    this.screenBtn.textContent = o.btn;
    this.screenTraining.hidden = !o.training;
    this.screenHint.textContent = o.hint;
    this.screen.hidden = false;
    this.screen.classList.remove('fade');
    document.body.classList.add('show-cursor');
  }

  private hideScreen(): void {
    this.screen.classList.add('fade');
    document.body.classList.remove('show-cursor');
    window.setTimeout(() => (this.screen.hidden = true), 420);
  }

  private onScreenButton(): void {
    if (performance.now() < this.screenArmedAt) return;
    this.audio.start();
    if (this.phase === 'title') {
      this.hideScreen();
      this.beginIntro();
      return;
    }
    if (this.phase === 'dead' || this.phase === 'won') {
      this.hideScreen();
      this.resetRun();
      this.beginIntro();
    }
  }

  /**
   * Volta ao menu. Durante a partida o primeiro ESC só avisa: perder uma
   * corrida de vinte minutos por um toque na tecla errada seria pior do que
   * não ter saída nenhuma. Nas telas de fim a corrida já acabou, então vai
   * direto.
   */
  private abandonRun(): void {
    if (this.phase === 'playing' && performance.now() > this.abandonArmedUntil) {
      this.abandonArmedUntil = performance.now() + 3000;
      this.toast('[ESC] de novo para abandonar e voltar ao menu');
      return;
    }
    this.abandonArmedUntil = 0;
    this.resetRun();
    this.showTitle();
  }

  private openTraining(): void {
    if (this.phase !== 'title' || performance.now() < this.screenArmedAt) return;
    this.audio.start();
    this.hideScreen();
    this.phase = 'training';
    this.training.open();
  }

  // ------------------------------------------------------------- efeitos

  /**
   * Coleta 90 quadros depois que o jogo comeca de fato e, se a mediana passar
   * de ~26 ms (≈38 fps), liga o modo desempenho e avisa. Mediana, nao media:
   * um travamento de GC nao deve rebaixar a maquina inteira.
   */
  private watchPerf(dt: number): void {
    if (this.perfChecked || this.phase !== 'playing') return;
    this.frameSamples.push(dt * 1000);
    if (this.frameSamples.length < 90) return;

    this.perfChecked = true;
    const sorted = [...this.frameSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median > 26) {
      this.setQuality(false);
      this.toast('MODO DESEMPENHO LIGADO AUTOMATICAMENTE — [P] alterna');
    }
  }

  private setQuality(high: boolean): void {
    this.renderer.setQuality(high ? QUALITY_HIGH : QUALITY_LOW);
    this.world.setAspect(this.renderer.aspect);
    this.world.setDetail(high);
  }

  private toast(msg: string): void {
    this.screenHint.textContent = msg;
    const el = this.introHint;
    el.textContent = msg;
    el.hidden = false;
    window.setTimeout(() => {
      if (this.phase !== 'intro') el.hidden = true;
    }, 4200);
  }

  /** so para o smoke test (?debug) */
  debug(): Record<string, unknown> {
    return {
      phase: this.phase,
      deathT: this.deathT,
      deathScreenShown: this.deathScreenShown,
      distance: this.belt.distance,
      dead: this.belt.dead,
      missionsDone: this.missionsDone,
      keys: this.keys,
      earnedKeys: this.earnedKeys,
      rippedKeys: this.rippedKeys,
      tuning: this.offers !== null,
      unlocked: this.belt.unlocked,
    };
  }

  /** Atalho exclusivo do smoke test; `Game` só é exposto com `?debug`. */
  debugUnlockExit(): void {
    if (!location.search.includes('debug')) return;
    this.keys = EXIT_KEYS;
    this.belt.unlockExit();
  }

  private punch(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  private flashMask(ms = 130): void {
    this.sublimArt.textContent = MASK_FRAMES[Math.random() < 0.5 ? 0 : 1]!;
    this.sublimEl.style.opacity = '0.42';
    window.setTimeout(() => (this.sublimEl.style.opacity = '0'), ms);
  }

  private fmtTime(s: number): string {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  }
}

const game = new Game();

// Gancho de depuração: só existe com ?debug na URL. Serve para o smoke test
// alcançar os finais sem esperar três minutos de esteira.
if (location.search.includes('debug')) {
  (window as unknown as { prensa: Game }).prensa = game;
}
