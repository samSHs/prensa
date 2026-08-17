import { clamp } from '../core/rng';

/** Barra superior. Tudo que ela mostra é ruim; a questão é o quanto. */
export class Hud {
  private subject: HTMLElement;
  private belt: HTMLElement;
  private cycle: HTMLElement;
  private phase: HTMLElement;
  private keys: HTMLElement;
  private fill: HTMLElement;
  private dot: HTMLElement;

  constructor(private root: HTMLElement) {
    this.subject = root.querySelector('#hud-subject')!;
    this.belt = root.querySelector('#hud-belt')!;
    this.cycle = root.querySelector('#hud-cycle')!;
    this.phase = root.querySelector('#hud-phase')!;
    this.keys = root.querySelector('#hud-keys')!;
    this.fill = root.querySelector('#track-fill')!;
    this.dot = root.querySelector('#track-dot')!;
  }

  show(v: boolean): void {
    this.root.hidden = !v;
  }

  update(o: {
    distance: number;
    hatch: number;
    velocity: number;
    untilImpact: number;
    phase: number;
    danger: number;
    keys: number;
    keyTotal: number;
  }): void {
    const pct = clamp(o.distance / o.hatch, 0, 1) * 100;
    this.dot.style.left = `${pct}%`;
    this.fill.style.width = `${pct}%`;

    this.subject.textContent = `${o.distance.toFixed(1)} m`;
    this.subject.className = `val${o.danger > 0.62 ? ' hot' : ''}`;

    const v = o.velocity;
    this.belt.textContent = `${v >= 0 ? '▶' : '◀'} ${Math.abs(v).toFixed(2)} m/s`;
    this.belt.className = `val${v > 0.55 ? ' hot' : ''}`;

    this.cycle.textContent = `${o.untilImpact.toFixed(1)} s`;
    this.cycle.className = `val${o.untilImpact < 1.2 ? ' hot' : ''}`;

    this.phase.textContent = `0${Math.min(9, o.phase)}`;
    this.phase.className = `val${o.phase >= 3 ? ' hot' : ''}`;

    this.keys.textContent = `${o.keys}/${o.keyTotal}`;
    this.keys.className = 'val';
  }
}
