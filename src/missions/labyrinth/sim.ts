import { Rng, clamp } from '../../core/rng';

/**
 * O LABIRINTO — simulação completa, não roteiro.
 *
 * Você é o operador da CFTV. Não controla a pessoa lá dentro: dá intenções
 * persistentes pelo fone. Os dois corpos têm relógios próprios e o caçador é
 * uma máquina de estados
 * honesta (patrulha → investiga ruído → caça no campo de visão), então toda
 * alternativa oferecida é avaliada simulando o futuro de verdade — nada de
 * "resposta certa" escrita à mão. Se você morrer, foi você que errou a conta.
 */

export const WALL = 0;
export const FLOOR = 1;
export const CLOSET = 2;
export const EXIT = 3;
export const KEY = 4;
export const PHONE = 5;

export const PATROL = 0;
export const INVESTIGATE = 1;
export const HUNT = 2;
export const SEARCH = 3;

export type LabIntent =
  | { k: 'MOVE'; dx: number; dy: number }
  | { k: 'HIDE'; x: number; y: number }
  | { k: 'WAIT' };

export interface RadioTraceSample {
  x: number;
  y: number;
  /** segundos até esta amostra deixar de poder ser correlacionada */
  left: number;
}

export interface RadioTraceState {
  /** somente o transmissor de ordens; o retorno de áudio permanece aberto */
  txOpen: boolean;
  samples: RadioTraceSample[];
  /** tempo desde o início do último burst contado */
  sinceBurst: number;
  /** tempo contínuo com o transmissor cortado */
  cutFor: number;
}

export interface LabState {
  w: number;
  h: number;
  tiles: Uint8Array;
  /** ordinal estável de armários/telefones; 1 = A, 2 = B... */
  labels: Uint8Array;
  cams: Uint8Array;
  lights: [boolean, boolean, boolean, boolean];
  difficulty: number;
  rng: number;
  turn: number;
  maxTurns: number;
  visionLit: number;
  visionDark: number;
  investigateSpeed: number;
  /** células extras que ele ganha por turno enquanto caça */
  huntEdge: number;
  radio: RadioTraceState;
  sur: {
    x: number;
    y: number;
    hidden: boolean;
    key: boolean;
    alive: boolean;
    out: boolean;
    intent: LabIntent;
    pending: LabIntent | null;
    hesitate: number;
    refusePending: boolean;
    trust: number;
    panic: number;
  };
  kil: {
    x: number;
    y: number;
    mode: number;
    tx: number;
    ty: number;
    searchLeft: number;
    /** um pulso para a rede calcular a primeira triangulação */
    traceDelay: number;
  };
  /** última posição do caçador que você conseguiu confirmar */
  seen: { x: number; y: number; turn: number } | null;
  events: string[];
  lastEvent: string;
}

export type LabAction =
  | { k: 'MOVE'; dx: number; dy: number; steps: number }
  | { k: 'HIDE'; x: number; y: number }
  | { k: 'WAIT' }
  | { k: 'LURE'; x: number; y: number }
  | { k: 'LIGHT'; s: number };

/** Teto de células por ordem. Passar disso vira "sumiu do rádio". */
export const MAX_RUN = 5;

export const DIRS: ReadonlyArray<{ dx: number; dy: number; name: string }> = [
  { dx: 0, dy: -1, name: 'NORTE' },
  { dx: 1, dy: 0, name: 'LESTE' },
  { dx: 0, dy: 1, name: 'SUL' },
  { dx: -1, dy: 0, name: 'OESTE' },
];

export const SECTOR_NAMES = ['NOROESTE', 'NORDESTE', 'SUDOESTE', 'SUDESTE'] as const;

export const idx = (s: LabState, x: number, y: number): number => y * s.w + x;

export function inBounds(s: LabState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.w && y < s.h;
}

export function walkable(s: LabState, x: number, y: number): boolean {
  return inBounds(s, x, y) && s.tiles[idx(s, x, y)] !== WALL;
}

export function sectorOf(s: LabState, x: number, y: number): number {
  return (y < s.h / 2 ? 0 : 2) + (x < s.w / 2 ? 0 : 1);
}

export function isLit(s: LabState, x: number, y: number): boolean {
  return s.lights[sectorOf(s, x, y)]!;
}

export function tileLabel(s: LabState, tileIndex: number): string {
  const n = s.labels[tileIndex] ?? 0;
  if (n <= 0) return '??';
  return `${s.tiles[tileIndex] === PHONE ? 'F' : 'A'}${n}`;
}

export function clone(s: LabState): LabState {
  return {
    w: s.w,
    h: s.h,
    tiles: s.tiles.slice(),
    labels: s.labels,
    cams: s.cams,
    lights: [...s.lights] as [boolean, boolean, boolean, boolean],
    difficulty: s.difficulty,
    rng: s.rng,
    turn: s.turn,
    maxTurns: s.maxTurns,
    visionLit: s.visionLit,
    visionDark: s.visionDark,
    investigateSpeed: s.investigateSpeed,
    huntEdge: s.huntEdge,
    radio: {
      ...s.radio,
      samples: s.radio.samples.map((sample) => ({ ...sample })),
    },
    sur: {
      ...s.sur,
      intent: { ...s.sur.intent },
      pending: s.sur.pending ? { ...s.sur.pending } : null,
    },
    kil: { ...s.kil },
    seen: s.seen ? { ...s.seen } : null,
    events: [],
    lastEvent: s.lastEvent,
  };
}

// ---------------------------------------------------------------- geração

/** Backtracker recursivo + laços extras. Labirinto perfeito é armadilha mortal:
 *  sem ciclos, fugir de um perseguidor é impossível por construção. */
export function generate(seed: number, difficulty: number): LabState {
  const rng = new Rng(seed);
  const w = 19;
  const h = 11;
  const tiles = new Uint8Array(w * h); // tudo WALL

  const carve = (x: number, y: number) => {
    tiles[y * w + x] = FLOOR;
  };

  const stack: Array<[number, number]> = [[1, 1]];
  carve(1, 1);
  const visited = new Set<number>([1 * w + 1]);

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1]!;
    const opts: Array<[number, number]> = [];
    for (const d of DIRS) {
      const nx = cx + d.dx * 2;
      const ny = cy + d.dy * 2;
      if (nx > 0 && ny > 0 && nx < w - 1 && ny < h - 1 && !visited.has(ny * w + nx)) {
        opts.push([nx, ny]);
      }
    }
    if (!opts.length) {
      stack.pop();
      continue;
    }
    const [nx, ny] = rng.pick(opts);
    carve((cx + nx) >> 1, (cy + ny) >> 1);
    carve(nx, ny);
    visited.add(ny * w + nx);
    stack.push([nx, ny]);
  }

  // laços: rotas alternativas são o que torna o jogo jogável
  const loops = Math.round(14 + (1 - clamp(difficulty, 0, 1)) * 8);
  for (let i = 0; i < loops; i++) {
    const x = 1 + rng.int(w - 2);
    const y = 1 + rng.int(h - 2);
    if (tiles[y * w + x] !== WALL) continue;
    const horiz = tiles[y * w + x - 1] !== WALL && tiles[y * w + x + 1] !== WALL;
    const vert = y > 0 && y < h - 1 && tiles[(y - 1) * w + x] !== WALL && tiles[(y + 1) * w + x] !== WALL;
    if (horiz || vert) carve(x, y);
  }

  const s: LabState = {
    w,
    h,
    tiles,
    labels: new Uint8Array(w * h),
    cams: new Uint8Array(w * h),
    lights: [true, true, true, true],
    difficulty,
    rng: (seed * 2654435761) >>> 0,
    turn: 1,
    maxTurns: 14,
    visionLit: Math.round(6 + Math.min(difficulty, 2) * 1.5),
    visionDark: 3,
    investigateSpeed: difficulty >= 1.6 ? 2 : 1,
    huntEdge: difficulty >= 1.3 ? 1 : 0,
    radio: {
      txOpen: true,
      samples: [],
      sinceBurst: 999,
      cutFor: 0,
    },
    sur: {
      x: 1,
      y: 1,
      hidden: false,
      key: false,
      alive: true,
      out: false,
      intent: { k: 'WAIT' },
      pending: null,
      hesitate: 0,
      refusePending: false,
      trust: 3,
      panic: 0,
    },
    kil: { x: 1, y: 1, mode: PATROL, tx: 1, ty: 1, searchLeft: 0, traceDelay: 0 },
    seen: null,
    events: [],
    lastEvent: 'O rádio abriu. Ela está esperando sua voz.',
  };

  const floors: number[] = [];
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === FLOOR) floors.push(i);

  // sobrevivente num canto, saída no ponto mais distante dele
  s.sur.x = 1;
  s.sur.y = 1;
  const distFromStart = bfs(s, 1, 1);

  let far = 0;
  for (const i of floors) if (distFromStart[i]! > far) far = distFromStart[i]!;

  // A saída NÃO vai no ponto mais distante: o orçamento de turnos é curto e o
  // labirinto precisa ser atravessável. Fica na faixa 60–90% do diâmetro.
  const exitZone = floors.filter((i) => distFromStart[i]! >= far * 0.5 && distFromStart[i]! <= far * 0.72);
  const exitIdx = exitZone.length ? rng.pick(exitZone) : floors[floors.length - 1]!;
  tiles[exitIdx] = EXIT;

  // chave num desvio: perto o bastante para caber no tempo, longe o bastante
  // para você ter que escolher a ordem das coisas
  const distFromExit = bfs(s, exitIdx % w, (exitIdx / w) | 0);
  const keyCandidates = floors
    .filter((i) => tiles[i] === FLOOR)
    .filter((i) => distFromStart[i]! >= 3 && distFromExit[i]! >= 2);
  let keyIdx = keyCandidates.length ? keyCandidates[0]! : floors[(floors.length / 2) | 0]!;
  let bestDetour = Infinity;
  for (const i of rng.shuffle(keyCandidates.slice())) {
    const total = distFromStart[i]! + distFromExit[i]!;
    const detour = Math.abs(total - distFromStart[exitIdx]! * 1.08);
    if (detour < bestDetour) {
      bestDetour = detour;
      keyIdx = i;
    }
  }
  tiles[keyIdx] = KEY;

  // No modo vivo, um pulso autônomo percorre UMA célula. O teto precisa cobrir
  // o caminho físico, não a antiga média de 1.9 células por clique.
  const optimal = distFromStart[keyIdx]! + distFromExit[keyIdx]!;
  // A esteira já pune hesitação em tempo real. O teto interno existe para
  // impedir esconderijo infinito, não para encerrar uma fuga competente no
  // primeiro desvio. A folga cai no late game, mas deixa espaço para SEARCH,
  // confiança quebrada e uma rota de recuperação.
  const slack = Math.max(16, Math.round(30 - difficulty * 4));
  s.maxTurns = Math.max(16, optimal + slack);

  // armários nos becos sem saída
  const deadEnds = floors.filter((i) => {
    if (tiles[i] !== FLOOR) return false;
    const x = i % w;
    const y = (i / w) | 0;
    let n = 0;
    for (const d of DIRS) if (walkable(s, x + d.dx, y + d.dy)) n++;
    return n === 1;
  });
  const closetCount = Math.max(2, Math.round(6 - difficulty * 2.5));
  rng.shuffle(deadEnds).slice(0, closetCount).forEach((i) => (tiles[i] = CLOSET));

  // telefones para atrair
  const phoneCount = Math.max(1, Math.round(3 - difficulty));
  const phoneCandidates = floors.filter((i) => tiles[i] === FLOOR && distFromStart[i]! > 5);
  rng.shuffle(phoneCandidates).slice(0, phoneCount).forEach((i) => (tiles[i] = PHONE));

  let closetLabel = 0;
  let phoneLabel = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === CLOSET) s.labels[i] = ++closetLabel;
    else if (tiles[i] === PHONE) s.labels[i] = ++phoneLabel;
  }

  // caçador: a meio caminho, entre você e a saída
  // O primeiro rastreamento já consegue virar a patrulha rumo à refém. Ela
  // precisa ter atravessado alguns corredores antes disso para a triangulação
  // ser uma ameaça recuperável, não uma sentença na segunda fala. A vantagem
  // desaparece até dificuldade 1, onde a faixa volta aos mesmos 48%.
  const hunterStartBand = 0.86 - clamp(difficulty, 0, 1) * 0.38;
  const mid = floors
    .filter((i) => tiles[i] === FLOOR)
    .filter((i) => distFromStart[i]! > distFromStart[exitIdx]! * hunterStartBand);
  const kIdx = mid.length ? rng.pick(mid) : exitIdx;
  s.kil.x = kIdx % w;
  s.kil.y = (kIdx / w) | 0;
  s.kil.tx = s.kil.x;
  s.kil.ty = s.kil.y;

  // câmeras: a cobertura encolhe com a dificuldade — é assim que o jogo
  // deixa de ser tático e vira aposta
  const coverage = clamp(0.92 - difficulty * 0.28, 0.28, 0.95);
  const camCount = Math.max(2, Math.round(floors.length * coverage * 0.06));
  const camSpots = rng.shuffle(floors.slice()).slice(0, camCount);
  for (const c of camSpots) {
    const cx = c % w;
    const cy = (c / w) | 0;
    for (const i of floors) {
      const x = i % w;
      const y = (i / w) | 0;
      if (Math.abs(x - cx) + Math.abs(y - cy) <= 6 && hasLos(s, cx, cy, x, y)) s.cams[i] = 1;
    }
  }

  // Sem câmera não existe contato grátis. O primeiro `?` só nasce quando
  // alguma fonte realmente confirma a posição dele.
  s.seen = null;
  return s;
}

// ---------------------------------------------------------------- utilidades

export function bfs(s: LabState, sx: number, sy: number): Int16Array {
  const d = new Int16Array(s.w * s.h).fill(-1);
  if (!walkable(s, sx, sy)) return d;
  const q = [sy * s.w + sx];
  d[q[0]!] = 0;
  for (let head = 0; head < q.length; head++) {
    const cur = q[head]!;
    const x = cur % s.w;
    const y = (cur / s.w) | 0;
    for (const dir of DIRS) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      if (!walkable(s, nx, ny)) continue;
      const ni = ny * s.w + nx;
      if (d[ni] !== -1) continue;
      d[ni] = d[cur]! + 1;
      q.push(ni);
    }
  }
  return d;
}

export function hasLos(s: LabState, x0: number, y0: number, x1: number, y1: number): boolean {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 200; guard++) {
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    if (!inBounds(s, x, y)) return false;
    if (s.tiles[idx(s, x, y)] === WALL) return false;
  }
  return false;
}

function nextStepToward(s: LabState, fx: number, fy: number, tx: number, ty: number): [number, number] | null {
  const field = bfs(s, tx, ty);
  const here = field[idx(s, fx, fy)]!;
  if (here <= 0) return null;
  let best: [number, number] | null = null;
  let bestD = here;
  for (const d of DIRS) {
    const nx = fx + d.dx;
    const ny = fy + d.dy;
    if (!walkable(s, nx, ny)) continue;
    const v = field[idx(s, nx, ny)]!;
    if (v >= 0 && v < bestD) {
      bestD = v;
      best = [nx, ny];
    }
  }
  return best;
}

export const RADIO_TRACE_SECONDS = 6;
export const RADIO_BURST_SECONDS = 0.9;
export const RADIO_SCRUB_SECONDS = 2;

export type RadioEmission = 'BLOCKED' | 'GROUPED' | 'SAMPLED' | 'TRIANGULATED';

/** Quantidade de informação espacial que a rede ainda consegue correlacionar. */
export function radioTraceLoad(s: LabState): 0 | 1 | 2 {
  return Math.min(2, s.radio.samples.length) as 0 | 1 | 2;
}

/**
 * Entrega ao caçador somente uma posição antiga. Visão real continua sendo a
 * única transição possível para HUNT; rastreamento eletrônico nunca caça por
 * conta própria.
 */
export function investigateLastKnown(
  s: LabState,
  x: number,
  y: number,
  processingDelay = false,
): boolean {
  if (s.kil.mode === HUNT || !walkable(s, x, y)) return false;
  const changed = s.kil.mode !== INVESTIGATE || s.kil.tx !== x || s.kil.ty !== y;
  s.kil.mode = INVESTIGATE;
  s.kil.tx = x;
  s.kil.ty = y;
  s.kil.searchLeft = 0;
  // A primeira triangulação da campanha precisa ser um aviso acionável, não
  // uma sentença: no início a rede leva dois pulsos para entregar o ponto.
  // Em chamadas avançadas o processamento cai para um pulso.
  if (processingDelay) s.kil.traceDelay = s.difficulty < 0.35 ? 2 : 1;
  if (changed) s.events.push('A rede entregou a ele o último ponto do rádio.');
  return changed;
}

/** Liga/desliga apenas o transmissor de ordens; não toca no retorno de áudio. */
export function setRadioTx(s: LabState, open: boolean): boolean {
  if (s.radio.txOpen === open) return false;
  s.radio.txOpen = open;
  s.radio.cutFor = 0;
  return true;
}

/**
 * Envelhece assinaturas em segundos reais. Silêncio aberto apaga uma amostra
 * em seis segundos; cortar TX acelera a limpeza para dois sem desfazer um alvo
 * que o caçador já recebeu.
 */
export function advanceRadioTrace(s: LabState, dt: number): boolean {
  const elapsed = Math.max(0, dt);
  if (elapsed <= 0) return false;
  const before = radioTraceLoad(s);

  s.radio.sinceBurst = Math.min(999, s.radio.sinceBurst + elapsed);
  for (const sample of s.radio.samples) sample.left -= elapsed;
  s.radio.samples = s.radio.samples.filter((sample) => sample.left > 0);

  if (s.radio.txOpen) {
    s.radio.cutFor = 0;
  } else {
    s.radio.cutFor += elapsed;
    if (s.radio.cutFor >= RADIO_SCRUB_SECONDS) {
      s.radio.samples = [];
      s.radio.sinceBurst = 999;
    }
  }
  return before !== radioTraceLoad(s);
}

/**
 * Registra uma nova fala válida. Comandos no mesmo burst não multiplicam
 * amostras; após a segunda, a posição atual vira apenas um destino de
 * INVESTIGATE.
 */
export function emitRadioTrace(s: LabState): RadioEmission {
  if (!s.radio.txOpen) return 'BLOCKED';
  if (s.radio.sinceBurst <= RADIO_BURST_SECONDS) return 'GROUPED';

  s.radio.sinceBurst = 0;
  const alreadyTriangulated = s.radio.samples.length >= 2;
  s.radio.samples.push({ x: s.sur.x, y: s.sur.y, left: RADIO_TRACE_SECONDS });
  while (s.radio.samples.length > 2) s.radio.samples.shift();

  if (s.radio.samples.length < 2) {
    s.events.push('A rede captou a portadora. Ainda não tem uma posição.');
    s.lastEvent = s.events.join(' ');
    return 'SAMPLED';
  }

  investigateLastKnown(s, s.sur.x, s.sur.y, !alreadyTriangulated);
  s.lastEvent = s.events.join(' ');
  return 'TRIANGULATED';
}

function makeNoise(s: LabState, x: number, y: number, strength: number, what: string): void {
  if (s.kil.mode === HUNT) return;
  const d = bfs(s, x, y)[idx(s, s.kil.x, s.kil.y)]!;
  if (d >= 0 && d <= strength) {
    const announce = s.kil.mode !== INVESTIGATE;
    s.kil.mode = INVESTIGATE;
    s.kil.tx = x;
    s.kil.ty = y;
    s.kil.searchLeft = 0;
    s.kil.traceDelay = 0;
    if (announce) s.events.push(`O caçador ouviu ${what}.`);
  }
}

function killerSees(s: LabState): boolean {
  if (s.sur.hidden) return false;
  const radius = isLit(s, s.kil.x, s.kil.y) ? s.visionLit : s.visionDark;
  const dx = s.sur.x - s.kil.x;
  const dy = s.sur.y - s.kil.y;
  if (dx * dx + dy * dy > radius * radius) return false;
  return hasLos(s, s.kil.x, s.kil.y, s.sur.x, s.sur.y);
}

function setHuntIfVisible(s: LabState): boolean {
  if (!killerSees(s)) return false;
  if (s.kil.mode !== HUNT) s.events.push('Ele viu ela.');
  s.kil.mode = HUNT;
  s.kil.tx = s.sur.x;
  s.kil.ty = s.sur.y;
  s.kil.searchLeft = 0;
  s.kil.traceDelay = 0;
  return true;
}

function observerSeesKiller(s: LabState): boolean {
  if (s.sur.hidden) return false;
  const radius = isLit(s, s.kil.x, s.kil.y) ? 8 : 3;
  const dx = s.sur.x - s.kil.x;
  const dy = s.sur.y - s.kil.y;
  return dx * dx + dy * dy <= radius * radius && hasLos(s, s.sur.x, s.sur.y, s.kil.x, s.kil.y);
}

function updateSeen(s: LabState): void {
  const camSees = isLit(s, s.kil.x, s.kil.y) && s.cams[idx(s, s.kil.x, s.kil.y)] === 1;
  if (camSees || observerSeesKiller(s)) {
    s.seen = { x: s.kil.x, y: s.kil.y, turn: s.turn };
  }
}

function beginSearch(s: LabState): void {
  if (s.kil.mode !== SEARCH) s.events.push('Ele perdeu o rastro, mas começou a procurar.');
  s.kil.mode = SEARCH;
  s.kil.searchLeft = s.difficulty >= 1.2 ? 3 : 2;
  s.kil.traceDelay = 0;
}

function choosePatrolTarget(s: LabState, rng: Rng): void {
  const alert = clamp(s.turn / Math.max(1, s.maxTurns), 0, 1);
  const strategic: number[] = [];
  for (let i = 0; i < s.tiles.length; i++) {
    const t = s.tiles[i]!;
    if (t === EXIT || t === KEY || t === PHONE) strategic.push(i);
  }

  if (strategic.length && rng.next() < alert * 0.48) {
    const target = rng.pick(strategic);
    s.kil.tx = target % s.w;
    s.kil.ty = (target / s.w) | 0;
    return;
  }

  for (let tries = 0; tries < 12; tries++) {
    const tx = 1 + rng.int(s.w - 2);
    const ty = 1 + rng.int(s.h - 2);
    if (walkable(s, tx, ty)) {
      s.kil.tx = tx;
      s.kil.ty = ty;
      return;
    }
  }
}

function chooseSearchTarget(s: LabState, rng: Rng): void {
  const candidates: number[] = [];
  const closets: number[] = [];
  for (let y = Math.max(1, s.kil.y - 2); y <= Math.min(s.h - 2, s.kil.y + 2); y++) {
    for (let x = Math.max(1, s.kil.x - 2); x <= Math.min(s.w - 2, s.kil.x + 2); x++) {
      if (Math.abs(x - s.kil.x) + Math.abs(y - s.kil.y) > 2 || !walkable(s, x, y)) continue;
      const i = idx(s, x, y);
      candidates.push(i);
      if (s.tiles[i] === CLOSET) closets.push(i);
    }
  }

  // Procura armários porque são armários, nunca porque sabe onde ela está.
  const pool = closets.length && rng.next() < 0.28 + clamp(s.difficulty, 0, 2) * 0.12 ? closets : candidates;
  if (!pool.length) {
    s.kil.mode = PATROL;
    return;
  }
  const target = rng.pick(pool);
  s.kil.tx = target % s.w;
  s.kil.ty = (target / s.w) | 0;
  s.kil.searchLeft--;
}

/** Um passo real do caçador. Retorna true quando matou a refém. */
function advanceKillerOne(s: LabState, rng: Rng): boolean {
  if (s.kil.mode === INVESTIGATE && s.kil.traceDelay > 0) {
    s.kil.traceDelay--;
    return false;
  }
  if (s.kil.mode === PATROL && s.kil.x === s.kil.tx && s.kil.y === s.kil.ty) {
    choosePatrolTarget(s, rng);
  }

  if (s.kil.mode === INVESTIGATE && s.kil.x === s.kil.tx && s.kil.y === s.kil.ty) {
    if (s.sur.hidden && s.sur.x === s.kil.x && s.sur.y === s.kil.y) {
      s.sur.alive = false;
      s.events.push('Ele abriu o armário.');
      return true;
    }
    beginSearch(s);
  }

  if (s.kil.mode === HUNT) {
    if (killerSees(s)) {
      s.kil.tx = s.sur.x;
      s.kil.ty = s.sur.y;
    } else if (s.kil.x === s.kil.tx && s.kil.y === s.kil.ty) {
      beginSearch(s);
    }
  }

  if (s.kil.mode === SEARCH && s.kil.x === s.kil.tx && s.kil.y === s.kil.ty) {
    if (s.kil.searchLeft <= 0) {
      s.kil.mode = PATROL;
      s.events.push('Os passos se afastaram.');
      choosePatrolTarget(s, rng);
    } else {
      chooseSearchTarget(s, rng);
    }
  }

  const nxt = nextStepToward(s, s.kil.x, s.kil.y, s.kil.tx, s.kil.ty);
  if (nxt) {
    s.kil.x = nxt[0];
    s.kil.y = nxt[1];
  }

  if (s.kil.x === s.sur.x && s.kil.y === s.sur.y) {
    if (s.sur.hidden && s.kil.mode === PATROL) {
      // Patrulha sem pista não abre armários ao acaso.
    } else {
      s.sur.alive = false;
      s.events.push(s.sur.hidden ? 'Ele abriu o armário.' : 'Ele a alcançou.');
      return true;
    }
  }

  if (setHuntIfVisible(s)) {
    const adjacent = Math.abs(s.kil.x - s.sur.x) + Math.abs(s.kil.y - s.sur.y) <= 1;
    if (adjacent) {
      s.sur.alive = false;
      s.events.push('Ele a alcançou.');
      return true;
    }
  }
  return false;
}

function hunterStepsForSlice(s: LabState): number {
  if (s.kil.mode === HUNT) return 1;
  if (s.kil.mode === INVESTIGATE) return Math.max(1, s.investigateSpeed);
  return 1;
}

function recordEndOfSlice(s: LabState, rng: Rng): void {
  updateSeen(s);
  s.rng = rng.state;
  s.turn++;
  if (s.events.length) s.lastEvent = s.events.join(' ');
}

function collectAtSurvivor(s: LabState): boolean {
  const i = idx(s, s.sur.x, s.sur.y);
  const t = s.tiles[i]!;
  if (t === KEY) {
    s.sur.key = true;
    s.tiles[i] = FLOOR;
    s.events.push('Chave recolhida.');
  }
  return t === EXIT && s.sur.key;
}

function moveSurvivorCell(s: LabState, nx: number, ny: number, noise: number): boolean {
  if (!walkable(s, nx, ny)) return false;
  if (nx === s.kil.x && ny === s.kil.y) {
    s.sur.x = nx;
    s.sur.y = ny;
    s.sur.alive = false;
    s.events.push('Ela virou a esquina e deu de frente com ele.');
    return true;
  }
  s.sur.x = nx;
  s.sur.y = ny;
  if (noise > 0) makeNoise(s, nx, ny, noise, noise >= 4 ? 'passos correndo' : 'os passos dela');
  return true;
}

function advanceHunterSlice(s: LabState, rng: Rng): boolean {
  setHuntIfVisible(s);
  const n = hunterStepsForSlice(s);
  for (let i = 0; i < n; i++) if (advanceKillerOne(s, rng)) return true;
  return false;
}

function trustAfterDanger(s: LabState, beforeMode: number, beforeDistance: number): void {
  const d = bfs(s, s.kil.x, s.kil.y)[idx(s, s.sur.x, s.sur.y)]!;
  if (!s.sur.alive) {
    s.sur.trust = 0;
    s.sur.panic = 3;
    return;
  }
  if (s.kil.mode === HUNT) {
    s.sur.panic = Math.min(3, s.sur.panic + 1);
    if (beforeMode !== HUNT || (d >= 0 && d < beforeDistance)) s.sur.trust = Math.max(0, s.sur.trust - 1);
  } else if (beforeMode === HUNT || (s.sur.hidden && d >= 3)) {
    s.sur.trust = Math.min(3, s.sur.trust + 1);
    s.sur.panic = Math.max(0, s.sur.panic - 1);
  } else if (d >= 0 && d <= 4) {
    s.sur.panic = Math.min(3, s.sur.panic + 1);
  } else {
    s.sur.panic = Math.max(0, s.sur.panic - 1);
  }
}

// ---------------------------------------------------------------- turno

/**
 * Devolve a única continuação possível depois de entrar numa célula de
 * corredor. O ponto de onde ela veio não conta como escolha: grau 2 significa
 * uma saída obrigatória, mesmo quando o corredor faz uma curva.
 *
 * `null` é deliberadamente ambíguo: pode ser bifurcação, beco ou ponto de
 * interesse. Em todos esses casos a pessoa precisa parar e devolver a decisão
 * ao operador.
 */
function corridorContinuationAt(
  s: LabState,
  x: number,
  y: number,
  fromX: number,
  fromY: number,
): { dx: number; dy: number } | null {
  const tile = s.tiles[idx(s, x, y)]!;
  if (tile === KEY || tile === EXIT || tile === CLOSET) return null;

  const exits = DIRS.filter((dir) => walkable(s, x + dir.dx, y + dir.dy));
  if (exits.length !== 2) return null;

  const onward = exits.filter((dir) => x + dir.dx !== fromX || y + dir.dy !== fromY);
  if (onward.length !== 1) return null;
  return { dx: onward[0]!.dx, dy: onward[0]!.dy };
}

/** Continuação obrigatória a partir da posição atual da refém. */
export function forcedCorridorTurn(
  s: LabState,
  fromX: number,
  fromY: number,
): { dx: number; dy: number } | null {
  return corridorContinuationAt(s, s.sur.x, s.sur.y, fromX, fromY);
}

/**
 * Quantas células uma ordem alcança antes da próxima decisão real. Curvas
 * obrigatórias fazem parte do mesmo corredor; bifurcação, beco, chave,
 * saída ou armário encerram a corrida. O limite estrutural só protege contra
 * mapas corrompidos; não cria uma parada artificial no meio do corredor.
 */
export function corridorRun(s: LabState, dx: number, dy: number): number {
  let x = s.sur.x;
  let y = s.sur.y;
  let n = 0;
  while (n < s.w * s.h) {
    const nx = x + dx;
    const ny = y + dy;
    if (!walkable(s, nx, ny)) break;
    const fromX = x;
    const fromY = y;
    x = nx;
    y = ny;
    n++;

    const continuation = corridorContinuationAt(s, x, y, fromX, fromY);
    if (!continuation) break;
    dx = continuation.dx;
    dy = continuation.dy;
  }
  return n;
}

function actionIntent(a: LabAction): LabIntent | null {
  if (a.k === 'MOVE') return { k: 'MOVE', dx: a.dx, dy: a.dy };
  if (a.k === 'HIDE') return { k: 'HIDE', x: a.x, y: a.y };
  if (a.k === 'WAIT') return { k: 'WAIT' };
  return null;
}

function applyConsoleAction(s: LabState, a: Extract<LabAction, { k: 'LURE' | 'LIGHT' }>, rng: Rng): void {
  if (a.k === 'LURE') {
    const phone = idx(s, a.x, a.y);
    if (s.tiles[phone] !== PHONE) {
      s.events.push('Esse telefone já está mudo.');
      return;
    }
    const name = tileLabel(s, phone);
    s.tiles[phone] = FLOOR;
    makeNoise(s, a.x, a.y, 14, `o telefone ${name} tocando`);
    s.events.push(`${name} está chamando.`);
    return;
  }

  const on = !s.lights[a.s]!;
  s.lights[a.s] = on;
  const kSec = sectorOf(s, s.kil.x, s.kil.y);
  if (on && kSec !== a.s) {
    const cx = a.s % 2 === 0 ? ((s.w / 4) | 0) : ((s.w * 3) / 4) | 0;
    const cy = a.s < 2 ? ((s.h / 4) | 0) : ((s.h * 3) / 4) | 0;
    let bx = cx;
    let by = cy;
    for (let r = 0; r < 6 && !walkable(s, bx, by); r++) {
      bx = clamp(cx + rng.int(5) - 2, 1, s.w - 2);
      by = clamp(cy + rng.int(5) - 2, 1, s.h - 2);
    }
    if (walkable(s, bx, by)) makeNoise(s, bx, by, 30, 'o disjuntor estalar');
  }
  s.events.push(`Setor ${SECTOR_NAMES[a.s]}: energia ${on ? 'restaurada' : 'cortada'}.`);
}

/**
 * Ordem de rádio em jogo contínuo. Ela vira intenção persistente; confiança
 * baixa gera uma hesitação inteira e ordens perigosas são recusadas depois.
 */
export function issueCommand(s: LabState, a: LabAction, risky = false): void {
  if (!s.sur.alive || s.sur.out) return;
  s.events = [];
  const rng = new Rng(s.rng);

  if (a.k === 'LURE' || a.k === 'LIGHT') {
    applyConsoleAction(s, a, rng);
    s.rng = rng.state;
    if (s.events.length) s.lastEvent = s.events.join(' ');
    return;
  }

  const next = actionIntent(a)!;
  const old = s.sur.intent;
  const contradicts =
    old.k === 'MOVE' &&
    next.k === 'MOVE' &&
    old.dx === -next.dx &&
    old.dy === -next.dy;
  if (contradicts) {
    s.sur.trust = Math.max(0, s.sur.trust - 1);
    s.sur.panic = Math.min(3, s.sur.panic + 1);
    s.events.push('Ela trava ao ouvir você mandar voltar.');
  }

  if (s.sur.trust <= 1) {
    s.sur.pending = next;
    s.sur.hesitate = 1;
    s.sur.refusePending = s.sur.trust <= 0 && risky;
    s.events.push(s.sur.refusePending ? 'Ela demora a responder. A respiração tomou o rádio.' : 'Ela hesita, mas ouviu.');
  } else {
    s.sur.intent = next;
    s.sur.pending = null;
    s.sur.refusePending = false;
    s.events.push(next.k === 'HIDE' ? `Ela procura o ${tileLabel(s, idx(s, next.x, next.y))}.` : 'Ela confirmou a ordem.');
  }

  if (risky) {
    s.sur.trust = Math.max(0, s.sur.trust - 1);
    s.sur.panic = Math.min(3, s.sur.panic + 1);
  }
  if (s.events.length) s.lastEvent = s.events.join(' ');
}

/** Executa somente o próximo passo da intenção persistente da refém. */
function advanceSurvivorIntentOne(s: LabState): boolean {
  let reachedExit = false;

  if (s.sur.hesitate > 0) {
    s.sur.hesitate--;
    if (s.sur.hesitate === 0 && s.sur.pending) {
      if (s.sur.refusePending) {
        s.events.push('“Não. Eu não vou por aí.” Ela não responde ao resto.');
      } else {
        s.sur.intent = s.sur.pending;
        s.events.push('“Tá. Estou indo.”');
      }
      s.sur.pending = null;
      s.sur.refusePending = false;
    } else {
      s.events.push('Ela perdeu um passo tentando decidir se ainda confia em você.');
    }
    return false;
  }

  if (s.sur.hidden && s.sur.intent.k === 'WAIT') return false;

  const intent = s.sur.intent;
  let next: [number, number] | null = null;
  if (intent.k === 'MOVE') {
    next = [s.sur.x + intent.dx, s.sur.y + intent.dy];
    if (!walkable(s, next[0], next[1])) {
      s.sur.intent = { k: 'WAIT' };
      s.events.push('“Parede. Preciso de outra direção.”');
      return false;
    }
  } else if (intent.k === 'HIDE') {
    if (s.sur.x === intent.x && s.sur.y === intent.y) {
      s.sur.hidden = true;
      s.sur.intent = { k: 'WAIT' };
      s.events.push(`Ela entrou no ${tileLabel(s, idx(s, intent.x, intent.y))}.`);
      return false;
    }
    next = nextStepToward(s, s.sur.x, s.sur.y, intent.x, intent.y);
  }

  if (!next) return false;

  const fromX = s.sur.x;
  const fromY = s.sur.y;
  const arrivedTile = s.tiles[idx(s, next[0], next[1])]!;
  s.sur.hidden = false;
  moveSurvivorCell(s, next[0], next[1], intent.k === 'HIDE' ? 2 : 3);
  if (!s.sur.alive) return false;

  // A continuação precisa ser calculada antes de recolher a chave, pois a
  // coleta transforma a célula em FLOOR.
  const continuation =
    intent.k === 'MOVE' ? forcedCorridorTurn(s, fromX, fromY) : null;
  const hadKey = s.sur.key;
  reachedExit = collectAtSurvivor(s);

  if (intent.k === 'HIDE' && s.sur.x === intent.x && s.sur.y === intent.y) {
    // Ele ainda pode vê-la entrando; esconder antes deste teste tornaria o
    // armário um teleporte invisível.
    setHuntIfVisible(s);
    s.sur.hidden = true;
    s.sur.intent = { k: 'WAIT' };
    s.events.push(`Ela entrou no ${tileLabel(s, idx(s, intent.x, intent.y))}.`);
    return reachedExit;
  }

  if (intent.k !== 'MOVE') return reachedExit;

  if (!hadKey && s.sur.key) {
    s.sur.intent = { k: 'WAIT' };
    s.events.push('“Peguei a chave. Para onde agora?”');
  } else if (reachedExit) {
    s.sur.intent = { k: 'WAIT' };
  } else if (arrivedTile === EXIT) {
    s.sur.intent = { k: 'WAIT' };
    s.events.push('“A saída está trancada. Preciso da chave.”');
  } else if (arrivedTile === CLOSET) {
    s.sur.intent = { k: 'WAIT' };
    s.events.push(`“Armário ${tileLabel(s, idx(s, s.sur.x, s.sur.y))}. Quer que eu entre?”`);
  } else if (continuation) {
    // Reta ou curva de grau 2: não existe uma decisão nova, portanto ela
    // conserva a ordem e acompanha o único corredor possível.
    s.sur.intent = { k: 'MOVE', dx: continuation.dx, dy: continuation.dy };
  } else {
    const exits = DIRS.reduce(
      (open, dir) => open + (walkable(s, s.sur.x + dir.dx, s.sur.y + dir.dy) ? 1 : 0),
      0,
    );
    s.sur.intent = { k: 'WAIT' };
    s.events.push(
      exits >= 3
        ? '“Cruzamento. Qual caminho?”'
        : '“Fim do corredor. Preciso de outra direção.”',
    );
  }

  return reachedExit;
}

/** Pulso autônomo: refém e caçador executam um passo intercalado. */
/**
 * Passo independente da refém.
 *
 * A direção começa a ser executada no instante da ordem e continua no relógio
 * dela. `keepEvents` permite conservar a confirmação que acabou de chegar no
 * rádio durante o primeiro passo imediato.
 */
export function advanceSurvivorTick(s: LabState, keepEvents = false): boolean {
  if (!s.sur.alive || s.sur.out) return false;
  if (!keepEvents) s.events = [];
  const beforeX = s.sur.x;
  const beforeY = s.sur.y;
  const beforeHidden = s.sur.hidden;
  const beforeKey = s.sur.key;
  const beforeAlive = s.sur.alive;
  const beforeOut = s.sur.out;
  const beforeHesitate = s.sur.hesitate;
  const beforePending = s.sur.pending;
  const beforeIntent = s.sur.intent;
  const reachedExit = advanceSurvivorIntentOne(s);

  if (s.sur.alive) setHuntIfVisible(s);
  if (s.sur.alive && reachedExit) {
    s.sur.out = true;
    s.events.push('Porta destrancada. Ela está fora.');
  }
  updateSeen(s);
  if (s.events.length) s.lastEvent = s.events.join(' ');

  return (
    beforeX !== s.sur.x ||
    beforeY !== s.sur.y ||
    beforeHidden !== s.sur.hidden ||
    beforeKey !== s.sur.key ||
    beforeAlive !== s.sur.alive ||
    beforeOut !== s.sur.out ||
    beforeHesitate !== s.sur.hesitate ||
    beforePending !== s.sur.pending ||
    beforeIntent !== s.sur.intent ||
    s.events.length > 0
  );
}

/**
 * Passo independente do caçador. Só este relógio consome a exposição total da
 * sala; a refém pode ser mais rápida no começo, mas nunca congela o inimigo.
 */
export function advanceKillerTick(s: LabState, keepEvents = false): boolean {
  if (!s.sur.alive || s.sur.out) return false;
  if (!keepEvents) s.events = [];
  const rng = new Rng(s.rng);
  const beforeMode = s.kil.mode;
  const beforeDistanceRaw = bfs(s, s.kil.x, s.kil.y)[idx(s, s.sur.x, s.sur.y)]!;
  const beforeDistance = beforeDistanceRaw < 0 ? 99 : beforeDistanceRaw;
  const beforeX = s.kil.x;
  const beforeY = s.kil.y;

  setHuntIfVisible(s);
  const hunterSteps =
    s.kil.mode === HUNT
      ? 1 + s.huntEdge
      : s.kil.mode === INVESTIGATE
        ? Math.max(1, s.investigateSpeed)
        : 1;
  for (let i = 0; i < hunterSteps; i++) {
    if (advanceKillerOne(s, rng)) break;
  }

  trustAfterDanger(s, beforeMode, beforeDistance);
  recordEndOfSlice(s, rng);
  return beforeX !== s.kil.x || beforeY !== s.kil.y || beforeMode !== s.kil.mode || s.events.length > 0;
}

export function pulse(s: LabState): void {
  if (!s.sur.alive || s.sur.out) return;
  s.events = [];
  const rng = new Rng(s.rng);
  const beforeMode = s.kil.mode;
  const beforeDistanceRaw = bfs(s, s.kil.x, s.kil.y)[idx(s, s.sur.x, s.sur.y)]!;
  const beforeDistance = beforeDistanceRaw < 0 ? 99 : beforeDistanceRaw;
  const reachedExit = advanceSurvivorIntentOne(s);

  if (s.sur.alive) {
    setHuntIfVisible(s);
    const hunterSteps =
      s.kil.mode === HUNT
        ? 1 + s.huntEdge
        : s.kil.mode === INVESTIGATE
          ? Math.max(1, s.investigateSpeed)
          : 1;
    for (let i = 0; i < hunterSteps; i++) {
      if (advanceKillerOne(s, rng)) break;
    }
  }

  if (s.sur.alive && reachedExit) {
    s.sur.out = true;
    s.events.push('Porta destrancada. Ela está fora.');
  }
  trustAfterDanger(s, beforeMode, beforeDistance);
  recordEndOfSlice(s, rng);
}

/**
 * Caminho discreto preservado para o oráculo/harness. Cada célula agora é
 * realmente intercalada com a IA: não existe atravessar o caçador nem sair
 * antes de ele reagir.
 */
export function step(s: LabState, a: LabAction): void {
  if (!s.sur.alive || s.sur.out) return;
  s.events = [];
  const rng = new Rng(s.rng);
  const beforeMode = s.kil.mode;
  const beforeDistanceRaw = bfs(s, s.kil.x, s.kil.y)[idx(s, s.sur.x, s.sur.y)]!;
  const beforeDistance = beforeDistanceRaw < 0 ? 99 : beforeDistanceRaw;
  let reacted = false;

  const react = (): boolean => {
    reacted = true;
    return advanceHunterSlice(s, rng);
  };

  switch (a.k) {
    case 'MOVE': {
      s.sur.intent = { k: 'MOVE', dx: a.dx, dy: a.dy };
      s.sur.hidden = false;
      // Uma escolha discreta representa a ordem inteira. O jogo vivo percorre
      // as mesmas células em ticks; o harness as executa de uma vez, sempre
      // intercalando uma reação real do caçador entre elas.
      const steps = corridorRun(s, a.dx, a.dy);
      let headingX = a.dx;
      let headingY = a.dy;
      let moved = 0;
      for (let i = 0; i < steps && s.sur.alive; i++) {
        const fromX = s.sur.x;
        const fromY = s.sur.y;
        const nx = fromX + headingX;
        const ny = fromY + headingY;
        if (!walkable(s, nx, ny)) break;
        const arrivedTile = s.tiles[idx(s, nx, ny)]!;
        moved++;
        moveSurvivorCell(s, nx, ny, steps >= 3 ? 4 : 2);
        if (!s.sur.alive) break;
        const continuation = forcedCorridorTurn(s, fromX, fromY);
        const hadKey = s.sur.key;
        const reachedExit = collectAtSurvivor(s);

        let stopHere = false;
        if (!hadKey && s.sur.key) {
          stopHere = true;
          s.events.push('“Peguei a chave. Para onde agora?”');
        } else if (reachedExit) {
          stopHere = true;
        } else if (arrivedTile === EXIT) {
          stopHere = true;
          s.events.push('“A saída está trancada. Preciso da chave.”');
        } else if (arrivedTile === CLOSET) {
          stopHere = true;
          s.events.push(`“Armário ${tileLabel(s, idx(s, s.sur.x, s.sur.y))}. Quer que eu entre?”`);
        } else if (continuation) {
          headingX = continuation.dx;
          headingY = continuation.dy;
          s.sur.intent = { k: 'MOVE', dx: headingX, dy: headingY };
        } else {
          const exits = DIRS.reduce(
            (open, dir) => open + (walkable(s, s.sur.x + dir.dx, s.sur.y + dir.dy) ? 1 : 0),
            0,
          );
          stopHere = true;
          s.events.push(
            exits >= 3
              ? '“Cruzamento. Qual caminho?”'
              : '“Fim do corredor. Preciso de outra direção.”',
          );
        }
        if (stopHere) s.sur.intent = { k: 'WAIT' };

        setHuntIfVisible(s);
        if (react()) break;
        if (reachedExit && s.sur.alive) {
          s.sur.out = true;
          s.events.push('Porta destrancada. Ela está fora.');
          break;
        }
        if (stopHere) break;
      }
      if (moved === 0 && s.sur.alive) {
        s.sur.intent = { k: 'WAIT' };
        s.events.push('“Parede. Preciso de outra direção.”');
        react();
      }
      break;
    }
    case 'HIDE': {
      s.sur.intent = { k: 'HIDE', x: a.x, y: a.y };
      const distance = bfs(s, a.x, a.y)[idx(s, s.sur.x, s.sur.y)]!;
      const steps = Math.max(0, Math.min(distance, MAX_RUN));
      for (let i = 0; i < steps && s.sur.alive; i++) {
        const nxt = nextStepToward(s, s.sur.x, s.sur.y, a.x, a.y);
        if (!nxt) break;
        s.sur.hidden = false;
        moveSurvivorCell(s, nxt[0], nxt[1], 2);
        if (!s.sur.alive) break;
        collectAtSurvivor(s);
        if (s.sur.x === a.x && s.sur.y === a.y) {
          setHuntIfVisible(s);
          s.sur.hidden = true;
          s.sur.intent = { k: 'WAIT' };
          s.events.push(`Ela entrou no ${tileLabel(s, idx(s, a.x, a.y))}.`);
        }
        if (react()) break;
      }
      if (steps === 0 && s.sur.x === a.x && s.sur.y === a.y) {
        setHuntIfVisible(s);
        s.sur.hidden = true;
        s.sur.intent = { k: 'WAIT' };
        s.events.push(`Ela se encolheu no ${tileLabel(s, idx(s, a.x, a.y))}.`);
      }
      if (!reacted && s.sur.alive) react();
      break;
    }
    case 'WAIT':
      s.sur.intent = { k: 'WAIT' };
      react();
      break;
    case 'LURE':
    case 'LIGHT':
      applyConsoleAction(s, a, rng);
      react();
      break;
  }

  if (s.sur.alive && s.kil.mode === HUNT) {
    for (let i = 0; i < s.huntEdge; i++) if (advanceKillerOne(s, rng)) break;
  }
  trustAfterDanger(s, beforeMode, beforeDistance);
  recordEndOfSlice(s, rng);
}

// ---------------------------------------------------------------- avaliação

/**
 * Quanto vale este estado para quem está tentando sobreviver.
 *
 * O peso do progresso é deliberadamente ALTO e o do medo é hiperbólico: cair
 * de 12 para 11 células de distância do caçador quase não importa, cair de 3
 * para 2 importa muitíssimo. Com o medo linear (a primeira versão disso aqui)
 * a política gulosa fugia em círculos para sempre e nunca chegava na saída —
 * o oráculo de "resposta certa" tem que ser, ele mesmo, uma política que
 * ganha o jogo.
 */
export function evaluate(s: LabState): number {
  if (s.sur.out) return 100000;
  if (!s.sur.alive) return -100000;

  let score = 0;
  // O caçador em tempo real torna qualquer corredor visualmente assustador.
  // Se o progresso pesar pouco, o próprio oráculo aprende a esperar até o
  // limite em vez de aceitar um risco calculado — cautela que parece segura,
  // mas produz uma missão insolúvel. O peso alto preserva rotas agressivas de
  // especialista sem tornar uma aproximação letal atraente (penalizada abaixo).
  score -= remainingPath(s) * 60;

  const kField = bfs(s, s.kil.x, s.kil.y);
  const kdRaw = kField[idx(s, s.sur.x, s.sur.y)]!;
  const kd = kdRaw < 0 ? 30 : kdRaw;
  const reach = s.kil.mode === HUNT ? 3 : s.investigateSpeed + 1;

  if (!s.sur.hidden && kd <= reach) {
    score -= 1200; // ele te pega no próximo turno
  } else {
    score -= 250 / Math.max(1, kd - 1);
  }

  // esconder só vale quando ele está por perto; senão é turno jogado fora
  if (s.sur.hidden) score += kd <= 5 ? 120 : -25;

  if (s.kil.mode === HUNT) score -= 150;
  else if (s.kil.mode === INVESTIGATE) score -= 20;

  // lookahead de 1 turno parado: pega "você entrou na rota dele"
  const peek = clone(s);
  step(peek, { k: 'WAIT' });
  if (!peek.sur.alive) score -= 700;

  // turno é recurso: quem enrola perde por tempo
  score -= s.turn * 6;
  if (s.turn > s.maxTurns) score -= 4000;

  return score;
}

/**
 * Células que ainda faltam percorrer: `sobrevivente → chave → saída`, ou
 * `sobrevivente → saída` se a chave já está com ela.
 *
 * Tem que ser UMA função contínua. A primeira versão media "distância ao
 * objetivo atual", e o objetivo trocava de chave para saída no instante em que
 * ela pegava a chave — o potencial saltava de 1 para 35 e a política gulosa
 * simplesmente ficava parada ao lado da chave até o tempo acabar, para não
 * pagar o salto. Somar o trecho restante elimina o degrau.
 */
export function remainingPath(s: LabState): number {
  const exitIdx = findTile(s, EXIT);
  if (exitIdx < 0) return 60;

  const exitField = bfs(s, exitIdx % s.w, (exitIdx / s.w) | 0);
  const here = idx(s, s.sur.x, s.sur.y);

  if (s.sur.key) {
    const d = exitField[here]!;
    return d < 0 ? 60 : d;
  }

  const keyIdx = findTile(s, KEY);
  if (keyIdx < 0) return 60;

  const keyField = bfs(s, keyIdx % s.w, (keyIdx / s.w) | 0);
  const toKey = keyField[here]!;
  const keyToExit = exitField[keyIdx]!;
  if (toKey < 0 || keyToExit < 0) return 60;
  return toKey + keyToExit;
}

export function findTile(s: LabState, t: number): number {
  for (let i = 0; i < s.tiles.length; i++) if (s.tiles[i] === t) return i;
  return -1;
}

export function killerVisible(s: LabState): boolean {
  return (
    (isLit(s, s.kil.x, s.kil.y) && s.cams[idx(s, s.kil.x, s.kil.y)] === 1) ||
    observerSeesKiller(s)
  );
}
