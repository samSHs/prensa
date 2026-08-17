import { Rng, clamp, lerp } from '../core/rng';
import type { Audio } from './audio';
import type { AttentionKind } from './director';

// Consumidores normalmente precisam do tipo junto do executor; reexportá-lo
// evita que a camada de integração conheça onde o diretor o declarou.
export type { AttentionKind } from './director';

export const ATTENTION_KEYSET = ['Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'] as const;

export type LockKeyCount = 2 | 3 | 4;

export interface LockSpec {
  sequence: string[];
  window: number;
}

/**
 * Escala comum à campanha e à sala de prática. Mesmo a primeira trava exige
 * uma troca real de atenção; intensidade só aumenta memória e velocidade.
 */
export function lockKeyCount(intensity: number): LockKeyCount {
  const level = clamp(intensity, 0, 1);
  return level >= 0.7 ? 4 : level >= 0.35 ? 3 : 2;
}

/** Tempo total, não tempo por tecla. */
export function lockWindow(count: LockKeyCount): number {
  return count === 2 ? 2.2 : count === 3 ? 2.6 : 3;
}

/** Sequência reproduzível, sem letras repetidas dentro da mesma trava. */
export function makeLockSpec(
  rng: Rng,
  intensity: number,
  forcedCount?: LockKeyCount,
): LockSpec {
  const count = forcedCount ?? lockKeyCount(intensity);
  const pool = rng.shuffle([...ATTENTION_KEYSET]);
  return {
    sequence: pool.slice(0, count),
    window: lockWindow(count),
  };
}

export type AttentionStage = 'IDLE' | 'LOCK' | 'APPROACH' | 'WATCH' | 'CLEAR';

export interface InterruptHooks {
  onHit(kind: AttentionKind): void;
  onMiss(kind: AttentionKind): void;
}

/**
 * Executor de eventos de atenção.
 *
 * Frequência, justiça e escolha do tipo pertencem ao TensionDirector. Esta
 * classe só apresenta uma sequência já autorizada, captura input e informa o
 * resultado. Assim ela também não pode mais ser anulada escolhendo uma opção
 * do terminal no meio da trava.
 */
export class Interrupts {
  private rng: Rng;
  private readonly initialSeed: number;
  private seq: string[] = [];
  private at = 0;
  private left = 0;
  private window = 1;
  private intensity = 0;

  active = false;
  kind: AttentionKind | null = null;
  stage: AttentionStage = 'IDLE';

  private labelEl: HTMLElement | null;

  constructor(
    private root: HTMLElement,
    private keysEl: HTMLElement,
    private barEl: HTMLElement,
    private audio: Audio,
    private hooks: InterruptHooks,
    seed = 0x0badc0de,
  ) {
    this.initialSeed = seed >>> 0;
    this.rng = new Rng(this.initialSeed);
    this.labelEl = root.querySelector('#lock-label');
  }

  reset(seed = this.initialSeed): void {
    this.rng = new Rng(seed >>> 0);
    this.cancel();
  }

  start(kind: AttentionKind, intensity: number): boolean {
    if (this.active) return false;
    this.active = true;
    this.kind = kind;
    this.intensity = clamp(intensity, 0, 1);
    this.at = 0;
    this.seq = [];
    this.root.dataset.kind = kind.toLowerCase();

    if (kind === 'LOCK') {
      this.startLock();
    } else {
      this.startInspection();
    }
    return true;
  }

  private startLock(): void {
    const spec = makeLockSpec(this.rng, this.intensity);
    this.seq = spec.sequence;

    this.stage = 'LOCK';
    this.window = spec.window;
    this.left = this.window;
    if (this.labelEl) this.labelEl.textContent = 'TRAVA DE SEGURANÇA';
    this.keysEl.innerHTML = this.seq.map((key) => `<kbd>${key}</kbd>`).join('');
    this.root.hidden = false;
    this.paintBar();
    this.audio.alarm();
  }

  private startInspection(): void {
    this.stage = 'APPROACH';
    this.window = 1.4;
    this.left = this.window;
    this.keysEl.innerHTML = '';

    // A apresentação da inspeção é diegética (cabine/luz), dirigida por
    // kind/stage no integrador. Não reaproveita o cartão vermelho da trava,
    // que ensinaria visualmente a reação oposta.
    this.root.hidden = true;
    this.paintBar();
    this.audio.crackle();
  }

  cancel(): void {
    this.active = false;
    this.kind = null;
    this.stage = 'IDLE';
    this.seq = [];
    this.at = 0;
    this.left = 0;
    this.window = 1;
    this.root.hidden = true;
    delete this.root.dataset.kind;
    delete this.root.dataset.stage;
  }

  /**
   * Devolve true quando o evento consumiu a tecla.
   *
   * Na trava, absolutamente qualquer tecla diferente da esperada é erro —
   * inclusive números. Na aproximação da inspeção o jogador ainda está livre;
   * WATCH falha com qualquer tecla e CLEAR apenas segura o input até a luz sair.
   */
  key(raw: string, repeat = false): boolean {
    if (!this.active || !this.kind) return false;

    // Autorepeat iniciado antes de uma mudança de fase não é uma nova decisão.
    // Ignorá-lo também impede que segurar a primeira letra erre a segunda.
    if (repeat) return true;

    if (this.kind === 'INSPECTION') {
      if (this.stage === 'APPROACH') return false;
      if (this.stage === 'WATCH') {
        this.finish(false);
        return true;
      }
      return this.stage === 'CLEAR';
    }

    if (this.stage !== 'LOCK') return true;
    const key = raw.toUpperCase();
    if (key === this.seq[this.at]) {
      const kbd = this.keysEl.children[this.at];
      if (kbd) kbd.classList.add('done');
      this.at++;
      this.audio.beep(1180, 0.04, 0.06);
      if (this.at >= this.seq.length) this.finish(true);
    } else {
      this.finish(false);
    }
    return true;
  }

  /** Captura clique/toque antes que ele alcance uma opção do terminal. */
  pointer(): boolean {
    if (!this.active || !this.kind) return false;
    if (this.kind === 'INSPECTION' && this.stage === 'APPROACH') return false;
    if (this.kind === 'INSPECTION' && this.stage === 'CLEAR') return true;
    this.finish(false);
    return true;
  }

  /** O segundo argumento opcional mantém a transição compatível com chamadas antigas. */
  update(dt: number, _legacyContext?: unknown): void {
    if (!this.active || !this.kind) return;
    const elapsed = Math.max(0, dt);
    this.left -= elapsed;

    if (this.kind === 'LOCK') {
      this.paintBar();
      if (this.left <= 0) this.finish(false);
      return;
    }

    // Um dt grande pode atravessar mais de uma fase; carregar o excedente
    // preserva a duração total e torna o executor testável sem requestAnimationFrame.
    for (let guard = 0; guard < 4 && this.active && this.left <= 0; guard++) {
      const overshoot = -this.left;
      if (this.stage === 'APPROACH') {
        this.stage = 'WATCH';
        this.window = lerp(2.2, 3.1, this.intensity);
        this.left = this.window - overshoot;
        // Clique seco que marca com precisão o começo da imobilidade. A camada
        // audiovisual completa pode usar `stage` sem acoplar-se ao executor.
        this.audio.beep(185, 0.12, 0.075);
      } else if (this.stage === 'WATCH') {
        this.stage = 'CLEAR';
        this.window = 0.5;
        this.left = this.window - overshoot;
        this.audio.beep(720, 0.045, 0.035);
      } else if (this.stage === 'CLEAR') {
        this.finish(true);
      } else {
        break;
      }
    }
    if (this.active) this.root.dataset.stage = this.stage.toLowerCase();
  }

  private paintBar(): void {
    const fill = this.barEl.firstElementChild as HTMLElement | null;
    if (fill) fill.style.transform = `scaleX(${clamp(this.left / this.window, 0, 1)})`;
    this.root.dataset.stage = this.stage.toLowerCase();
  }

  private finish(success: boolean): void {
    const finishedKind = this.kind;
    if (!finishedKind) return;
    this.cancel();
    if (success) {
      this.audio.good();
      this.hooks.onHit(finishedKind);
    } else {
      this.audio.bad();
      this.hooks.onMiss(finishedKind);
    }
  }
}
