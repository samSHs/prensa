import { clamp, lerp } from '../core/rng';
import { pressImpactPhase } from '../world/world';

/**
 * A esteira é o relógio do jogo. Nunca para, nunca pergunta.
 *
 * `distance` = metros entre o sujeito e o prato. A esteira empurra com `base`
 * (que só cresce), e cada acerto injeta um `reverse` que decai — ou seja: você
 * nunca "ganha" velocidade permanente, só compra segundos. Isso mantém a
 * pressão mesmo numa sequência perfeita de acertos.
 */

export const KILL_ZONE = 1.05;

export interface BeltEvents {
  onImpact(crushed: boolean): void;
  onDeath(): void;
  onEscape(): void;
  onHatchBlocked(): void;
}

export class Belt {
  distance: number;
  readonly hatch: number;

  /** empurrão constante, em m/s, sempre para a prensa */
  base: number;
  /** velocidade contrária residual, decai exponencialmente */
  reverse = 0;

  phase = 0;
  slam = 0;
  elapsed = 0;
  dead = false;
  escaped = false;
  private exitUnlocked = false;

  /** 0..1, sobe com as missões concluídas — encurta o ciclo da prensa */
  pressure = 0;

  private prevPhase = 0;
  private hatchNoticeCooldown = 0;

  constructor(private ev: BeltEvents, opts: { start: number; hatch: number; base: number }) {
    this.distance = opts.start;
    this.hatch = opts.hatch;
    this.base = opts.base;
  }

  /** 0 (seguro) .. 1 (encostado na prensa) */
  get danger(): number {
    const byDist = 1 - clamp(this.distance / 9, 0, 1);
    return clamp(Math.max(byDist * byDist, this.pressure * 0.42), 0, 1);
  }

  get unlocked(): boolean {
    return this.exitUnlocked;
  }

  unlockExit(): void {
    this.exitUnlocked = true;
    this.hatchNoticeCooldown = 0;
  }

  /** m/s líquidos; positivo = sendo puxado para a prensa */
  get velocity(): number {
    return this.base - this.reverse;
  }

  /** segundos de ciclo da prensa */
  get cycle(): number {
    return lerp(5.0, 1.85, clamp(this.danger * 0.75 + this.pressure * 0.55, 0, 1));
  }

  /** segundos até a próxima batida */
  get untilImpact(): number {
    const cyc = this.cycle;
    let d = pressImpactPhase - this.phase;
    if (d < 0) d += 1;
    return d * cyc;
  }

  /** ganho de terreno: a esteira inverte por alguns segundos */
  gain(meters: number): void {
    // tau do decaimento é 1.1s, então o deslocamento total ≈ v * 1.1
    this.reverse = Math.min(4.2, this.reverse + meters / 1.1);
  }

  /** solavanco: perda imediata + a esteira fica mais rápida para sempre */
  shove(meters: number, escalate = 0): void {
    this.distance -= meters;
    this.base += escalate;
    this.reverse *= 0.35;
  }

  update(dt: number): void {
    if (this.dead || this.escaped) {
      this.slam = Math.max(0, this.slam - dt * 2.2);
      return;
    }

    this.elapsed += dt;
    this.hatchNoticeCooldown = Math.max(0, this.hatchNoticeCooldown - dt);

    // deriva lenta: mesmo parado, o mundo aperta
    // A versão curta subia 0,25 m/s por minuto. Com missões vivas de 1–2
    // minutos isso matava até uma rota perfeita antes do primeiro resgate.
    // A deriva continua inevitável, mas agora amadurece ao longo da campanha.
    this.base += dt * 0.00072 * (1 + this.pressure * 2.2);
    this.reverse *= Math.exp(-dt / 1.1);

    this.distance -= this.velocity * dt;

    if (!this.exitUnlocked && this.distance >= this.hatch) {
      // A escotilha é um limite físico enquanto as quatro travas estão ativas.
      // Descarta também a reversão excedente: acertar junto da porta não pode
      // armazenar um "estilingue" para o instante em que ela destrancar.
      this.distance = this.hatch - 0.15;
      this.reverse = 0;
      if (this.hatchNoticeCooldown <= 0) {
        this.hatchNoticeCooldown = 6;
        this.ev.onHatchBlocked();
      }
    } else {
      this.distance = Math.min(this.distance, this.hatch + 0.5);
    }

    this.slam = Math.max(0, this.slam - dt * 2.6);

    this.prevPhase = this.phase;
    this.phase += dt / this.cycle;
    if (this.phase >= 1) this.phase -= 1;

    const crossed =
      (this.prevPhase < pressImpactPhase && this.phase >= pressImpactPhase) ||
      (this.phase < this.prevPhase && pressImpactPhase >= this.prevPhase);

    if (crossed) {
      const crushed = this.distance <= KILL_ZONE;
      this.slam = 1;
      this.ev.onImpact(crushed);
      if (crushed) this.kill();
    }

    if (!this.dead && this.distance <= 0) this.kill();
    if (!this.dead && this.exitUnlocked && this.distance >= this.hatch) {
      this.escaped = true;
      this.ev.onEscape();
    }
  }

  private kill(): void {
    if (this.dead) return;
    this.dead = true;
    this.distance = Math.max(this.distance, 0);
    this.ev.onDeath();
  }
}
