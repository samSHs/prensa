/**
 * RNG determinístico e *serializável*.
 *
 * As missões precisam poder ser simuladas para frente (para pontuar cada
 * alternativa) e depois voltar ao estado anterior. Por isso o estado do
 * gerador é um único número que vive dentro do estado da missão — clonar o
 * estado clona o acaso junto.
 */
export class Rng {
  constructor(public state: number) {
    this.state = (state >>> 0) || 0x9e3779b9;
  }

  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** inteiro em [0, n) */
  int(n: number): number {
    return Math.floor(this.next() * n) % Math.max(1, n);
  }

  /** float em [a, b) */
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Fisher-Yates in-place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = t;
    }
    return arr;
  }
}

/** Semente a partir de string — útil para reproduzir uma partida. */
export function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
