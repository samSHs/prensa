import { Rng, clamp } from '../core/rng';
import type { Audio } from '../game/audio';
import type { MissionNode, Resolution } from '../missions/types';

/**
 * O terminal parafusado na esteira, na altura do seu ombro.
 *
 * Só existe uma regra: o cronômetro NUNCA para. Ele corre enquanto você lê,
 * enquanto o Zelador fala, enquanto a trava de segurança grita por uma tecla.
 * Nada aqui espera por você.
 */

type Phase = 'idle' | 'asking' | 'holding';

export interface TerminalHooks {
  onChoose(id: string | null): void;
  onAdvance(): void;
}

export class Terminal {
  private phase: Phase = 'idle';
  private node: MissionNode | null = null;
  private left = 0;
  private limit = 1;
  private hold = 0;
  private rng = new Rng(0x7e12);
  private glitchTimer = 3;

  private titleEl: HTMLElement;
  private nodeEl: HTMLElement;
  private bodyEl: HTMLElement;
  private promptEl: HTMLElement;
  private optionsEl: HTMLElement;
  private timerEl: HTMLElement;
  private feedbackEl: HTMLElement;

  constructor(
    private root: HTMLElement,
    private audio: Audio,
    private hooks: TerminalHooks,
  ) {
    this.titleEl = root.querySelector('#m-title')!;
    this.nodeEl = root.querySelector('#m-node')!;
    this.bodyEl = root.querySelector('#m-body')!;
    this.promptEl = root.querySelector('#m-prompt')!;
    this.optionsEl = root.querySelector('#m-options')!;
    this.timerEl = root.querySelector('#m-timer')!;
    this.feedbackEl = root.querySelector('#m-feedback')!;

    // Confirma no pointerdown, enquanto o item que o jogador viu ainda existe.
    // Missões vivas podem redesenhar o painel entre pointerdown e click; esperar
    // pelo click permitiria perder o gesto ou aplicá-lo ao item que ocupou o
    // mesmo lugar depois do refresh.
    this.optionsEl.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      const li = (e.target as HTMLElement).closest('li');
      if (li && this.phase === 'asking') {
        e.preventDefault();
        this.commit(li.dataset.id ?? null);
      }
    });

    // Mantém click como fallback para ativação programática e tecnologias
    // assistivas, que podem dispará-lo sem um PointerEvent anterior.
    this.optionsEl.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (li && this.phase === 'asking') this.commit(li.dataset.id ?? null);
    });
  }

  /** fração de tempo que ainda sobrava — vira bônus de distância */
  get remaining(): number {
    return clamp(this.left / this.limit, 0, 1);
  }

  get asking(): boolean {
    return this.phase === 'asking';
  }

  hide(): void {
    this.phase = 'idle';
    this.root.hidden = true;
  }

  present(node: MissionNode, missionName: string): void {
    this.node = node;
    this.phase = 'asking';
    this.limit = node.continuousTotal ?? node.timeLimit;
    this.left = node.timeLimit;

    this.root.hidden = false;
    this.titleEl.textContent = missionName;
    this.paintNode(node, true, true);
    this.feedbackEl.innerHTML = '';
    this.feedbackEl.className = '';
    this.timerEl.classList.remove('warn');

    this.audio.beep(1320, 0.04, 0.045);
  }

  /**
   * Atualiza uma missão viva sem reiniciar sua janela nem desbloquear uma
   * escolha já confirmada. Durante `holding`, só o mapa/status muda.
   */
  refresh(node: MissionNode, missionName?: string): void {
    if (this.phase === 'idle') {
      this.present(node, missionName ?? this.titleEl.textContent ?? '');
      return;
    }

    const oldLimit = this.limit;
    this.node = node;
    this.limit = Math.max(0.1, node.continuousTotal ?? node.timeLimit);
    if (node.continuous) {
      this.left = clamp(node.timeLimit, 0, this.limit);
    } else if (oldLimit > 0) {
      this.left = clamp((this.left / oldLimit) * this.limit, 0, this.limit);
    }
    if (missionName !== undefined) this.titleEl.textContent = missionName;
    this.paintNode(node, this.phase === 'asking');
  }

  private paintNode(node: MissionNode, allowOptions: boolean, forceOptions = false): void {
    this.nodeEl.textContent = node.nodeLabel;
    this.bodyEl.innerHTML = node.bodyHtml;
    this.promptEl.textContent = node.prompt;
    if (!allowOptions) return;

    const current = Array.from(this.optionsEl.children)
      .map((li) => {
        const el = li as HTMLElement;
        return `${el.dataset.id ?? ''}\u0000${el.querySelector('span')?.textContent ?? ''}`;
      })
      .join('\u0001');
    const next = node.options.map((o) => `${o.id}\u0000${o.label}`).join('\u0001');
    if (!forceOptions && current === next) return;

    this.optionsEl.innerHTML = node.options
      .map((o, i) => `<li data-id="${o.id}"><b>[${i + 1}]</b><span>${o.label}</span></li>`)
      .join('');
  }

  /** teclas 1..9 escolhem; devolve true se consumiu */
  key(raw: string): boolean {
    if (this.phase !== 'asking' || !this.node) return false;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > this.node.options.length) return false;
    this.commit(this.node.options[n - 1]!.id);
    return true;
  }

  private commit(id: string | null): void {
    if (this.phase !== 'asking') return;
    this.phase = 'holding';
    for (const li of Array.from(this.optionsEl.children) as HTMLElement[]) {
      li.classList.add('locked');
      if (li.dataset.id === id) li.classList.add('picked');
    }
    this.hooks.onChoose(id);
  }

  /** chamado pelo main logo depois do onChoose, com o resultado */
  resolve(res: Resolution, holdSeconds: number): void {
    if (this.phase === 'asking') {
      // Resolução assíncrona de missão viva: não houve commit() para travar.
      this.phase = 'holding';
      for (const li of Array.from(this.optionsEl.children) as HTMLElement[]) li.classList.add('locked');
    }
    this.hold = holdSeconds;
    // as missoes marcam nomes de fio/valvula com <span> coloridos na
    // explicacao, entao aqui e innerHTML (conteudo nosso, nao do usuario)
    this.feedbackEl.innerHTML = res.feedback;
    this.feedbackEl.className =
      res.verdict === 'GOOD' ? 'good' : res.verdict === 'NEUTRAL' ? '' : 'bad';

    if (res.verdict !== 'GOOD' && res.bestOptionId) {
      for (const li of Array.from(this.optionsEl.children) as HTMLElement[]) {
        if (li.dataset.id === res.bestOptionId) li.classList.add('was-best');
      }
    }
  }

  update(dt: number, danger: number): void {
    if (this.phase === 'asking') {
      this.left -= dt;
      if (this.node?.continuous && this.left <= 0) {
        // Relógio de pulso: a missão avança por update(), não por WAIT forçado.
        const cycles = Math.floor(-this.left / this.limit) + 1;
        this.left += cycles * this.limit;
      }
      const f = clamp(this.left / this.limit, 0, 1);
      (this.timerEl.firstElementChild as HTMLElement).style.transform = `scaleX(${f})`;
      this.timerEl.classList.toggle('warn', f < 0.34);

      if (f < 0.34 && Math.floor(this.left * 2) !== Math.floor((this.left + dt) * 2)) {
        this.audio.beep(1500, 0.03, 0.04);
      }

      if (this.left <= 0 && !this.node?.continuous) this.commit(null);

      // corrupção cosmética: nunca apaga informação por tempo suficiente para
      // trocar a sua resposta, mas destrói a sua calma
      this.glitchTimer -= dt;
      if (this.glitchTimer <= 0 && danger > 0.45) {
        this.glitchTimer = 1.6 + this.rng.next() * 4;
        this.corruptFlash();
      }
      return;
    }

    if (this.phase === 'holding') {
      this.hold -= dt;
      if (this.hold <= 0) {
        this.phase = 'idle';
        this.hooks.onAdvance();
      }
    }
  }

  private corruptFlash(): void {
    const items = Array.from(this.optionsEl.children) as HTMLElement[];
    if (!items.length) return;
    const li = items[this.rng.int(items.length)]!;
    const span = li.querySelector('span');
    if (!span) return;
    const original = span.textContent ?? '';
    const chars = original.split('');
    for (let i = 0; i < 3; i++) {
      const at = this.rng.int(chars.length);
      if (chars[at] !== ' ') chars[at] = '▓';
    }
    span.textContent = chars.join('');
    window.setTimeout(() => {
      if (span.isConnected) span.textContent = original;
    }, 110);
  }
}
