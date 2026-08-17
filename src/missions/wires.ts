import { Rng, clamp } from '../core/rng';
import type { Mission, MissionKind, MissionNode, MissionUpdate, Resolution } from './types';

/**
 * CÓDIGO MORTO — programação de uma ordem de corte.
 *
 * O painel nunca confirma um fio isolado. O jogador monta a ordem inteira e
 * só então a executa; portanto não é possível descobrir a solução sondando a
 * caixa. Todo enigma de campanha é conferido por força bruta (no máximo 6! =
 * 720 ordens) e só é aceito quando as leituras descrevem uma única solução.
 */

interface Wire {
  name: string;
  cls: string;
}

const PALETTE: readonly Wire[] = [
  { name: 'VERMELHO', cls: 'bad' },
  { name: 'AZUL', cls: 'me' },
  { name: 'VERDE', cls: 'ok' },
  { name: 'AMARELO', cls: 'key' },
  { name: 'BRANCO', cls: 'hl' },
  { name: 'CINZA', cls: 'ghost' },
];

const ORDINAL = ['1º', '2º', '3º', '4º', '5º', '6º'];

type ClueKind =
  | 'BEFORE'
  | 'DIRECT_AFTER'
  | 'ADJACENT'
  | 'GAP'
  | 'PARITY'
  | 'EDGE'
  | 'BETWEEN'
  | 'XOR';

interface Clue {
  kind: ClueKind;
  signature: string;
  /** impede duas formulações da mesma relação de adjacência no painel */
  family?: string;
  text: string;
  test: (order: number[]) => boolean;
}

const permutationCache = new Map<number, number[][]>();

function permutations(n: number): number[][] {
  const cached = permutationCache.get(n);
  if (cached) return cached;

  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = () => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  permutationCache.set(n, out);
  return out;
}

const posOf = (order: number[], wire: number): number => order.indexOf(wire);

function buildPool(wires: Wire[], secret: number[], includeCompound: boolean): Clue[] {
  const n = wires.length;
  const nm = (i: number) => `<span class="${wires[i]!.cls}">${wires[i]!.name}</span>`;
  const rank = new Array<number>(n);
  secret.forEach((wire, position) => (rank[wire] = position));
  const pool = new Map<string, Clue>();
  const add = (clue: Clue) => pool.set(clue.signature, clue);

  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const first = rank[a]! < rank[b]! ? a : b;
      const last = first === a ? b : a;
      const gap = Math.abs(rank[a]! - rank[b]!) - 1;
      const family = `adj:${Math.min(a, b)}:${Math.max(a, b)}`;

      add({
        kind: 'BEFORE',
        signature: `before:${first}:${last}`,
        family: gap === 0 ? family : undefined,
        text: `${nm(first)} sai antes de ${nm(last)}`,
        test: (order) => posOf(order, first) < posOf(order, last),
      });

      if (gap === 0) {
        add({
          kind: 'DIRECT_AFTER',
          signature: `direct:${first}:${last}`,
          family,
          text: `${nm(last)} sai imediatamente depois de ${nm(first)}`,
          test: (order) => posOf(order, last) - posOf(order, first) === 1,
        });
        add({
          kind: 'ADJACENT',
          signature: `adjacent:${a}:${b}`,
          family,
          text: `${nm(a)} e ${nm(b)} são consecutivos; a direção não foi registrada`,
          test: (order) => Math.abs(posOf(order, a) - posOf(order, b)) === 1,
        });
      } else {
        add({
          kind: 'GAP',
          signature: `gap:${a}:${b}:${gap}`,
          text: `há exatamente ${gap} ${gap === 1 ? 'fio' : 'fios'} entre ${nm(a)} e ${nm(b)}`,
          test: (order) => Math.abs(posOf(order, a) - posOf(order, b)) - 1 === gap,
        });
      }
    }
  }

  for (let wire = 0; wire < n; wire++) {
    const position = rank[wire]!;
    add({
      kind: 'PARITY',
      signature: `parity:${wire}:${position % 2}`,
      text: `${nm(wire)} sai em posição ${position % 2 === 0 ? 'ímpar' : 'par'}`,
      test: (order) => posOf(order, wire) % 2 === position % 2,
    });

    if (position === 0 || position === n - 1) {
      add({
        kind: 'EDGE',
        signature: `edge:${wire}:yes`,
        text: `${nm(wire)} ocupa uma das pontas da ordem`,
        test: (order) => {
          const p = posOf(order, wire);
          return p === 0 || p === n - 1;
        },
      });
    } else {
      add({
        kind: 'EDGE',
        signature: `edge:${wire}:no`,
        text: `${nm(wire)} não ocupa nenhuma das pontas`,
        test: (order) => {
          const p = posOf(order, wire);
          return p !== 0 && p !== n - 1;
        },
      });
    }
  }

  // Relação de três termos: uma leitura, duas desigualdades que precisam ser
  // cruzadas com o resto. A frase contém toda a regra; não exige decorar lore.
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = secret[i]!;
        const b = secret[j]!;
        const c = secret[k]!;
        add({
          kind: 'BETWEEN',
          signature: `between:${a}:${b}:${c}`,
          text: `${nm(b)} sai depois de ${nm(a)} e antes de ${nm(c)}`,
          test: (order) => posOf(order, a) < posOf(order, b) && posOf(order, b) < posOf(order, c),
        });
      }
    }
  }

  // O operador aparece apenas no tier tardio e explica a própria semântica.
  if (includeCompound) {
    for (let pivot = 0; pivot < n; pivot++) {
      for (let a = 0; a < n; a++) {
        if (a === pivot) continue;
        for (let b = a + 1; b < n; b++) {
          if (b === pivot) continue;
          const truth = rank[a]! < rank[pivot]!;
          const other = rank[b]! < rank[pivot]!;
          if (truth === other) continue;
          add({
            kind: 'XOR',
            signature: `xor:${a}:${b}:${pivot}`,
            text: `exatamente um entre ${nm(a)} e ${nm(b)} sai antes de ${nm(pivot)}`,
            test: (order) =>
              (posOf(order, a) < posOf(order, pivot)) !== (posOf(order, b) < posOf(order, pivot)),
          });
        }
      }
    }
  }

  return [...pool.values()];
}

const KIND_CAP: Readonly<Record<ClueKind, number>> = {
  BEFORE: 2,
  DIRECT_AFTER: 1,
  ADJACENT: 1,
  GAP: 2,
  PARITY: 2,
  EDGE: 1,
  BETWEEN: 2,
  XOR: 1,
};

function solutions(perms: readonly number[][], clues: readonly Clue[]): number[][] {
  return perms.filter((order) => clues.every((clue) => clue.test(order)));
}

/**
 * Verdadeiro quando uma única leitura já entrega a próxima posição. Os dois
 * primeiros cortes de uma missão real rejeitam esse atalho: precisam do
 * cruzamento de pelo menos duas linhas do painel.
 */
function hasSingleClueAnswer(
  perms: readonly number[][],
  clues: readonly Clue[],
  prefix: readonly number[],
  wanted: number,
): boolean {
  const base = perms.filter((order) => prefix.every((wire, i) => order[i] === wire));
  return clues.some((clue) => {
    const left = base.filter((order) => clue.test(order));
    return left.length > 0 && left.every((order) => order[prefix.length] === wanted);
  });
}

function typeCount(clues: readonly Clue[]): number {
  return new Set(clues.map((clue) => clue.kind)).size;
}

function directedCount(clues: readonly Clue[]): number {
  return clues.filter((clue) => clue.kind === 'DIRECT_AFTER').length;
}

function isRealPuzzle(
  clues: readonly Clue[],
  perms: readonly number[][],
  secret: readonly number[],
): boolean {
  if (typeCount(clues) < 3 || directedCount(clues) > 1) return false;
  const only = solutions(perms, clues);
  if (only.length !== 1 || only[0]!.some((wire, i) => wire !== secret[i])) return false;

  // Sem “X é o primeiro”, nenhuma linha deve conseguir substituí-la por uma
  // resposta igualmente direta, nem no primeiro nem no segundo corte.
  if (hasSingleClueAnswer(perms, clues, [], secret[0]!)) return false;
  if (hasSingleClueAnswer(perms, clues, [secret[0]!], secret[1]!)) return false;
  return true;
}

/** Remove redundância fácil sem destruir variedade nem a inferência cruzada. */
function prune(
  source: Clue[],
  perms: readonly number[][],
  secret: readonly number[],
  minimum: number,
  rng: Rng,
): Clue[] {
  const chosen = [...source];
  const order = rng.shuffle(chosen.map((_, i) => i));
  for (const originalIndex of order) {
    if (chosen.length <= minimum) break;
    const clue = source[originalIndex];
    const currentIndex = chosen.indexOf(clue!);
    if (currentIndex < 0) continue;
    const without = chosen.filter((_, i) => i !== currentIndex);
    if (isRealPuzzle(without, perms, secret)) chosen.splice(currentIndex, 1);
  }
  return chosen;
}

function fallbackClues(pool: readonly Clue[], secret: number[], rng: Rng): Clue[] {
  const out: Clue[] = [];
  // Uma cadeia de relações “antes de” exige ordenar o grafo, mas não escreve
  // a solução como a antiga cadeia de “imediatamente depois”.
  for (let i = 0; i < secret.length - 1; i++) {
    const signature = `before:${secret[i]}:${secret[i + 1]}`;
    const clue = pool.find((candidate) => candidate.signature === signature);
    if (clue) out.push(clue);
  }
  const parity = pool.find((clue) => clue.kind === 'PARITY');
  const gap = pool.find((clue) => clue.kind === 'GAP');
  if (parity) out.push(parity);
  if (gap) out.push(gap);
  return rng.shuffle(out);
}

function buildClues(wires: Wire[], secret: number[], rng: Rng, difficulty: number): Clue[] {
  const n = wires.length;
  const perms = permutations(n);
  const pool = buildPool(wires, secret, difficulty >= 0.9);
  const minimum = n;
  const maximum = n === 5 ? 7 : 9;
  let best: Clue[] | null = null;
  let bestScore = -Infinity;

  // Amostragem determinística. Conferir 720 ordens é barato e permite julgar
  // o resultado, em vez de presumir que “mais pistas” significa mais difícil.
  for (let attempt = 0; attempt < 1200; attempt++) {
    const target = minimum + rng.int(maximum - minimum + 1);
    const counts = new Map<ClueKind, number>();
    const families = new Set<string>();
    const candidate: Clue[] = [];

    for (const clue of rng.shuffle([...pool])) {
      if (candidate.length >= target) break;
      if ((counts.get(clue.kind) ?? 0) >= KIND_CAP[clue.kind]) continue;
      if (clue.family && families.has(clue.family)) continue;
      candidate.push(clue);
      counts.set(clue.kind, (counts.get(clue.kind) ?? 0) + 1);
      if (clue.family) families.add(clue.family);
    }

    if (!isRealPuzzle(candidate, perms, secret)) continue;
    const reduced = prune(candidate, perms, secret, minimum, rng);
    const redundant = reduced.filter((_, i) => solutions(perms, reduced.filter((__, j) => j !== i)).length === 1)
      .length;
    const score = typeCount(reduced) * 12 - redundant * 3 - Math.abs(reduced.length - (n + 1));
    if (score > bestScore) {
      best = reduced;
      bestScore = score;
    }
    if (bestScore >= 58) break;
  }

  return rng.shuffle(best ?? fallbackClues(pool, secret, rng));
}

/** Uma demonstração curta; nunca é usada por uma missão jogável da campanha. */
function buildDemonstrationClues(wires: Wire[], secret: number[]): Clue[] {
  const nm = (i: number) => `<span class="${wires[i]!.cls}">${wires[i]!.name}</span>`;
  const clues: Clue[] = [
    {
      kind: 'EDGE',
      signature: `demo:first:${secret[0]}`,
      text: `${nm(secret[0]!)} é o primeiro`,
      test: (order) => order[0] === secret[0],
    },
  ];
  for (let i = 1; i < secret.length; i++) {
    const before = secret[i - 1]!;
    const after = secret[i]!;
    clues.push({
      kind: 'DIRECT_AFTER',
      signature: `demo:after:${before}:${after}`,
      text: `${nm(after)} sai imediatamente depois de ${nm(before)}`,
      test: (order) => posOf(order, after) - posOf(order, before) === 1,
    });
  }
  return clues;
}

class WireMission implements Mission {
  readonly id = 'codigo';
  readonly name = 'CÓDIGO MORTO';
  readonly live = true;
  readonly brief =
    'Uma caixa de junção com fios e nenhuma etiqueta. Programe todos os cortes antes de executar. ' +
    'A caixa não confirma tentativas.';

  readonly howTo = [
    '<span class="hl">UMA CAIXA DE FIOS E UMA ORDEM DE CORTE SECRETA.</span>',
    '',
    'As <span class="hl">LEITURAS DO PAINEL</span> são todas verdadeiras e, juntas, descrevem',
    'exatamente <span class="hl">UMA</span> ordem possível. A regra está escrita em cada leitura;',
    'cor de fio nunca possui significado secreto.',
    '',
    '  <span class="key">PROGRAMAR</span>  escolha fios até preencher todos os slots',
    '  <span class="key">DESFAZER</span>   remove o último fio da fila',
    '  <span class="bad">EXECUTAR</span>   corta a fila inteira sem confirmar cada etapa',
    '',
    'Um programa incompatível acumula carga e apaga a fila. Três cargas fecham',
    'o circuito através de você. Durante a montagem nenhum fio foi cortado ainda.',
    '',
    '<span class="ghost">“Consecutivos; direção não registrada” exige descobrir também quem vem antes.</span>',
    '<span class="ghost">“Exatamente um” significa que uma das duas relações é verdadeira e a outra é falsa.</span>',
  ].join('\n');

  private wires: Wire[];
  private secret: number[];
  private clues: Clue[];
  private queue: number[] = [];
  private charge = 0;
  private mistakes = 0;
  private ended = false;
  private readonly timeTotal: number;
  private timeLeft: number;
  private noiseLine: string;

  constructor(seed: number, difficulty: number) {
    const rng = new Rng(seed);
    const demonstration = difficulty < 0;
    const n = demonstration ? 4 : difficulty < 0.9 ? 5 : 6;
    this.wires = rng.shuffle([...PALETTE]).slice(0, n);
    this.secret = rng.shuffle(this.wires.map((_, i) => i));
    this.clues = demonstration
      ? buildDemonstrationClues(this.wires, this.secret)
      : buildClues(this.wires, this.secret, rng, difficulty);

    // Uma única janela cobre a programação inteira; adicionar um fio não
    // reinicia o relógio. A demonstração segura usa um relógio praticamente
    // inerte e continua compatível com a sala de treinamento atual.
    this.timeTotal = demonstration
      ? 3600
      : n === 5
        ? clamp(58 - difficulty * 7, 43, 58)
        : clamp(52 - difficulty * 6, 32, 48);
    this.timeLeft = this.timeTotal;

    const noise = rng.pick(['CRC ▓7-▓2', 'PORTADORA ▓▓.4', 'CANAL 0▓/AUX']);
    this.noiseLine =
      difficulty >= 0.9
        ? `\n   <span class="bad">!</span> <span class="ghost">${noise} — RUÍDO AUXILIAR, SEM DADO LÓGICO</span>`
        : '';
  }

  node(): MissionNode {
    const rows = this.wires
      .map((wire, i) => {
        const queuedAt = this.queue.indexOf(i);
        const state =
          queuedAt >= 0
            ? `<span class="key">FILA ${ORDINAL[queuedAt]}</span>`
            : '<span class="ok">ÍNTEGRO</span>';
        return `   ${String(i + 1).padStart(2)}  <span class="${wire.cls}">════════════</span>  ` +
          `<span class="${wire.cls}">${wire.name.padEnd(9)}</span>  ${state}`;
      })
      .join('\n');

    const program = this.wires
      .map((_, position) => {
        const wireIndex = this.queue[position];
        return wireIndex === undefined
          ? `${ORDINAL[position]} <span class="ghost">[_________]</span>`
          : `${ORDINAL[position]} <span class="${this.wires[wireIndex]!.cls}">[${this.wires[wireIndex]!.name.padEnd(9)}]</span>`;
      })
      .join('   ');
    const readings = this.clues.map((clue, i) => `   ${String(i + 1).padStart(2)} · ${clue.text}`).join('\n');
    const chargeBar = `<span class="${this.charge >= 2 ? 'bad' : 'key'}">${'#'.repeat(this.charge)}${'·'.repeat(3 - this.charge)}</span>`;

    const options =
      this.queue.length === this.wires.length
        ? [
            { id: 'EXECUTE', label: 'EXECUTAR PROGRAMA COMPLETO' },
            { id: 'UNDO', label: 'DESFAZER ÚLTIMO SLOT' },
          ]
        : [
            ...this.wires
              .map((wire, i) => ({ id: `WIRE:${i}`, label: `PROGRAMAR ${wire.name}`, i }))
              .filter(({ i }) => !this.queue.includes(i))
              .map(({ id, label }) => ({ id, label })),
            ...(this.queue.length > 0 ? [{ id: 'UNDO', label: 'DESFAZER ÚLTIMO SLOT' }] : []),
          ];

    return {
      nodeLabel: `PROGRAMA ${this.queue.length}/${this.wires.length}`,
      bodyHtml:
        `<span class="hl">OBJETIVO:</span> deduza e programe a ordem completa antes de executar\n\n` +
        `<span class="hl">CAIXA DE JUNÇÃO — nenhum corte executado</span>\n\n${rows}\n\n` +
        `<span class="hl">PROGRAMA DE CORTE</span>\n   ${program}\n\n` +
        `   CARGA RESIDUAL ${chargeBar}  ${this.charge}/3   <span class="ghost">(3 = morte)</span>\n\n` +
        `<span class="hl">LEITURAS DO PAINEL</span>  <span class="ghost">— cruze as linhas; existe UMA ordem</span>\n` +
        `${readings}${this.noiseLine}`,
      prompt:
        this.queue.length === this.wires.length
          ? 'Revise a fila. EXECUTAR corta todos os fios sem pausa nem confirmação.'
          : 'Adicione o próximo slot do programa. Isto ainda não corta nem valida o fio.',
      options,
      timeLimit: this.timeLeft,
      continuous: true,
      continuousTotal: this.timeTotal,
    };
  }

  peekBest(): string | null {
    const wrongAt = this.queue.findIndex((wire, i) => wire !== this.secret[i]);
    if (wrongAt >= 0) return 'UNDO';
    if (this.queue.length === this.wires.length) return 'EXECUTE';
    return `WIRE:${this.secret[this.queue.length]}`;
  }

  attention(): { load: 0 | 1 | 2; inputRequired: boolean; safeSilenceSeconds: number } {
    return {
      load: this.queue.length === this.wires.length ? 2 : 1,
      inputRequired: true,
      safeSilenceSeconds: Math.max(0, this.timeLeft),
    };
  }

  update(dt: number): MissionUpdate | null {
    if (this.ended) return null;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft > 0) return null;
    return { changed: true, resolution: this.timeout() };
  }

  choose(optionId: string | null): Resolution {
    if (this.ended) {
      return {
        verdict: 'NEUTRAL',
        feedback: 'O circuito já foi encerrado.',
        bestOptionId: null,
        finished: true,
        success: false,
      };
    }
    if (optionId === null) return this.timeout();

    if (optionId === 'UNDO') {
      const removed = this.queue.pop();
      const name = removed === undefined ? 'nenhum slot' : this.wires[removed]!.name;
      return {
        verdict: 'NEUTRAL',
        feedback: `${name} removido da fila. Nenhum fio foi cortado.`,
        bestOptionId: null,
        finished: false,
        success: false,
      };
    }

    if (optionId.startsWith('WIRE:')) {
      const wire = Number(optionId.slice(5));
      if (!Number.isInteger(wire) || !this.wires[wire] || this.queue.includes(wire)) {
        return {
          verdict: 'NEUTRAL',
          feedback: 'Esse fio já ocupa um slot. A caixa não alterou o programa.',
          bestOptionId: null,
          finished: false,
          success: false,
        };
      }
      this.queue.push(wire);
      return {
        verdict: 'NEUTRAL',
        feedback: `${this.wires[wire]!.name} carregado no ${ORDINAL[this.queue.length - 1]}. Ainda não houve corte.`,
        bestOptionId: null,
        finished: false,
        success: false,
      };
    }

    if (optionId !== 'EXECUTE' || this.queue.length !== this.wires.length) {
      return {
        verdict: 'NEUTRAL',
        feedback: 'O programa está incompleto. A caixa recusou a execução sem tocar nos fios.',
        bestOptionId: null,
        finished: false,
        success: false,
      };
    }

    const correct = this.queue.every((wire, i) => wire === this.secret[i]);
    if (correct) {
      this.ended = true;
      return {
        verdict: 'GOOD',
        feedback: `PROGRAMA ACEITO. ${this.wires.length} cortes, nenhum arco. A caixa apagou.`,
        bestOptionId: 'EXECUTE',
        finished: true,
        success: true,
        epilogue:
          this.mistakes === 0
            ? 'Você enviou a ordem inteira sem pedir confirmação. O painel obedeceu em silêncio.'
            : 'A caixa guardou as tentativas rejeitadas. A última ordem, pelo menos, estava limpa.',
      };
    }

    return this.rejectProgram();
  }

  private rejectProgram(): Resolution {
    const violated = this.clues.filter((clue) => !clue.test(this.queue)).slice(0, 2);
    this.charge++;
    this.mistakes++;
    const explanation = violated.length
      ? `\nCONFLITO DETECTADO:\n${violated.map((clue) => `· ${clue.text}`).join('\n')}`
      : '\nCONFLITO ENTRE AS LEITURAS E A FILA ENVIADA.';
    this.queue = [];

    if (this.charge >= 3) {
      this.ended = true;
      return {
        verdict: 'FATAL',
        feedback: `TERCEIRO PROGRAMA REJEITADO.${explanation}\nA carga fechou o circuito.`,
        bestOptionId: null,
        finished: true,
        success: false,
        cue: 'ELECTROCUTION',
        epilogue: 'A caixa não revelou a resposta. Revelou apenas por onde a corrente atravessa um corpo.',
      };
    }

    this.timeLeft = this.timeTotal;
    return {
      verdict: 'BAD',
      feedback: `PROGRAMA REJEITADO.${explanation}\nFila apagada. Carga residual ${this.charge}/3.`,
      bestOptionId: null,
      finished: false,
      success: false,
    };
  }

  private timeout(): Resolution {
    this.charge++;
    this.mistakes++;
    const programmed = this.queue.length;
    this.queue = [];

    if (this.charge >= 3) {
      this.ended = true;
      return {
        verdict: 'FATAL',
        feedback: `Terceira janela encerrada com ${programmed}/${this.wires.length} slots. A carga fechou o circuito.`,
        bestOptionId: null,
        finished: true,
        success: false,
        cue: 'ELECTROCUTION',
        epilogue: 'A caixa cansou de esperar uma ordem. Escolheu o caminho da corrente sozinha.',
      };
    }

    this.timeLeft = this.timeTotal;
    return {
      verdict: 'BAD',
      feedback: `JANELA ENCERRADA · programa ${programmed}/${this.wires.length}. Fila apagada; carga ${this.charge}/3.`,
      bestOptionId: null,
      finished: false,
      success: false,
    };
  }
}

export const wireKind: MissionKind = {
  id: 'codigo',
  name: 'CÓDIGO MORTO',
  create: (seed, difficulty) => new WireMission(seed, difficulty),
};
