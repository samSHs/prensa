import { Rng, clamp } from '../core/rng';
import type { Mission, MissionKind, MissionNode, Resolution } from './types';

/**
 * PROTOCOLO DE PURGA — rede de pressão hidráulica.
 *
 * A prensa que vai te matar é alimentada por essa rede. Você tem acesso ao
 * painel de válvulas. Fechar tudo não resolve: pressão que não sai arrebenta
 * o nó onde ficou presa, e um nó arrebentado é o fim da missão.
 *
 * A rede é um DAG de topologia fixa (para o painel caber na tela) com
 * capacidades sorteadas. Todas as 2^15 configurações são resolvidas na
 * geração, então o jogo sabe exatamente quais estados são "vitória" — e
 * mede cada alternativa pela distância de Hamming até a vitória mais próxima.
 */

const NODES = ['FONTE', 'A', 'B', 'C', 'D', 'E', 'F', 'PRENSA', 'DESCARGA', 'QUEIMADOR'] as const;
type NodeId = (typeof NODES)[number];

interface Edge {
  id: string;
  from: NodeId;
  to: NodeId;
}

const EDGES: readonly Edge[] = [
  { id: 'V1', from: 'FONTE', to: 'A' },
  { id: 'V2', from: 'FONTE', to: 'B' },
  { id: 'V3', from: 'FONTE', to: 'C' },
  { id: 'V4', from: 'A', to: 'D' },
  { id: 'V5', from: 'A', to: 'E' },
  { id: 'V6', from: 'B', to: 'E' },
  { id: 'V7', from: 'B', to: 'F' },
  { id: 'V8', from: 'C', to: 'D' },
  { id: 'V9', from: 'C', to: 'F' },
  { id: 'VA', from: 'D', to: 'PRENSA' },
  { id: 'VB', from: 'D', to: 'DESCARGA' },
  { id: 'VC', from: 'E', to: 'PRENSA' },
  { id: 'VD', from: 'E', to: 'QUEIMADOR' },
  { id: 'VE', from: 'F', to: 'DESCARGA' },
  { id: 'VF', from: 'F', to: 'QUEIMADOR' },
];

const ORDER: NodeId[] = ['FONTE', 'A', 'B', 'C', 'D', 'E', 'F', 'PRENSA', 'DESCARGA', 'QUEIMADOR'];
const TOTAL = 12;
const FATAL_SCORE = -1_000_000;
const WIN_SCORE = 1_000_000;

/** arestas de saída por nó, pré-calculadas: a geração varre 2^15 configurações
 *  e um `filter` por nó por configuração custaria caro à toa */
const OUT: Record<NodeId, number[]> = (() => {
  const m = {} as Record<NodeId, number[]>;
  for (const n of NODES) m[n] = [];
  EDGES.forEach((e, i) => m[e.from].push(i));
  return m;
})();

type Caps = Record<NodeId, number>;
type Loads = Record<NodeId, number>;

function solve(caps: Caps, open: boolean[]): { loads: Loads; burst: NodeId | null } {
  const loads = {} as Loads;
  for (const n of NODES) loads[n] = 0;
  loads.FONTE = TOTAL;

  let burst: NodeId | null = null;

  for (const n of ORDER) {
    const incoming = loads[n];
    const outs = OUT[n];
    let openCount = 0;
    for (const i of outs) if (open[i]) openCount++;

    if (burst === null) {
      // excesso de vazão
      if (incoming > caps[n] + 1e-9) burst = n;
      // pressão sem para onde ir. Sem esta regra, fechar as três válvulas da
      // fonte seria vitória instantânea — a rede inteira ficaria em zero.
      else if (outs.length > 0 && openCount === 0 && incoming > 1e-9) burst = n;
    }

    if (!openCount) continue;

    const share = incoming / openCount;
    for (const i of outs) if (open[i]) loads[EDGES[i]!.to] += share;
  }

  return { loads, burst };
}

/** Medidor em ASCII puro: `▓`/`░` são glifos de altura cheia e invadiam a
 *  linha de cima com o entrelinhamento apertado do terminal. */
const bar = (v: number, max: number): string => {
  const n = 10;
  const filled = clamp(Math.round((v / Math.max(1, max)) * n), 0, n);
  const over = v > max + 1e-9;
  const cls = over ? 'bad' : v > max * 0.8 ? 'key' : 'ok';
  return `<span class="${cls}">${'#'.repeat(filled)}${'·'.repeat(n - filled)}</span>`;
};

const SHORT: Record<string, string> = {
  PRENSA: 'PRE',
  DESCARGA: 'DES',
  QUEIMADOR: 'QUE',
};
const short = (n: NodeId): string => SHORT[n] ?? n;

class ValveMission implements Mission {
  readonly id = 'purga';
  readonly name = 'PROTOCOLO DE PURGA';
  readonly brief =
    'A rede hidráulica que alimenta a prensa acima de você tem painel de manutenção. ' +
    'Eles deixaram você chegar nele de propósito.';

  readonly howTo = [
    '<span class="hl">A PRENSA ACIMA DE VOCÊ É HIDRÁULICA. VOCÊ VAI CORTAR A FORÇA DELA.</span>',
    '',
    'Seu único objetivo é levar <span class="bad">PRENSA</span> até <span class="ok">0.0</span>.',
    'Você abre ou fecha <span class="hl">UMA</span> válvula por vez.',
    '',
    '<span class="key">RASTREIE O FLUXO, NÃO APENAS O NÚMERO DA PRENSA:</span>',
    '  1. Comece na <span class="hl">FONTE</span> e veja quais saídas estão ABR.',
    '  2. Cada nó divide sua carga igualmente entre todas as saídas abertas.',
    '  3. Siga D, E e F até descobrir quais ramos ainda alimentam a PRENSA.',
    '  4. Preserve uma rota para DESCARGA ou QUEIMADOR antes de cortar um ramo.',
    '',
    '<span class="key">MAPA FIXO DA REDE</span> — cada linha é uma rota completa até um ralo:',
    '',
    '  <span class="hl">FONTE(12)</span> ┬─V1→ A ┬─V4→ D ┬─VA→ <span class="bad">PRENSA</span>',
    '            │       │       └─VB→ <span class="ok">DESCARGA</span>',
    '            │       └─V5→ E ┬─VC→ <span class="bad">PRENSA</span>',
    '            │               └─VD→ <span class="ok">QUEIMADOR</span>',
    '            ├─V2→ B ┬─V6→ E ┬─VC→ <span class="bad">PRENSA</span>',
    '            │       │       └─VD→ <span class="ok">QUEIMADOR</span>',
    '            │       └─V7→ F ┬─VE→ <span class="ok">DESCARGA</span>',
    '            │               └─VF→ <span class="ok">QUEIMADOR</span>',
    '            └─V3→ C ┬─V8→ D ┬─VA→ <span class="bad">PRENSA</span>',
    '                    │       └─VB→ <span class="ok">DESCARGA</span>',
    '                    └─V9→ F ┬─VE→ <span class="ok">DESCARGA</span>',
    '                            └─VF→ <span class="ok">QUEIMADOR</span>',
    '',
    '  A <span class="bad">PRENSA</span> só bebe de D (VA) e E (VC): zere essas duas entradas —',
    '  fechando as válvulas ou secando o que chega em D e E. Antes disso,',
    '  abra respiro para os nós carregados e confira a folga dos ralos.',
    '',
    'CARGA/CAP mostra o que o nó recebe agora e o máximo que ele suporta.',
    'Um nó arrebenta se recebe mais que a capacidade ou retém carga sem saída.',
    'As alternativas mostram apenas a válvula, seu estado atual e os dois nós',
    'conectados. O painel não prevê a consequência: faça o percurso antes de agir.',
    '',
    'No treinamento, um <span class="key">FUSÍVEL</span> desfaz a primeira manobra que romperia a rede.',
    '<span class="ghost">Depois da manobra, o relatório explica a consequência observada.</span>',
  ].join('\n');

  private caps: Caps;
  private open: boolean[];
  /** distância de Hamming de CADA configuração até a vitória mais próxima */
  private distField: Uint8Array;
  private turn = 1;
  private maxTurns: number;
  private lastBurst: string | null = null;
  /** leitura causal que permanece no painel depois de o feedback desaparecer */
  private lastReport: string | null = null;
  private fuseAvailable: boolean;
  private optionCache: {
    key: number;
    value: Array<{ id: string; label: string; index: number; score: number; distance: number; safe: boolean }>;
  } | null = null;

  constructor(seed: number, private difficulty: number) {
    const rng = new Rng(seed);
    const training = difficulty < 0;
    const targetDistance = training ? 4 : difficulty < 0.8 ? 3 : difficulty < 1.6 ? 4 : 5;
    this.maxTurns = training ? 7 : difficulty < 0.8 ? 8 : difficulty < 1.6 ? 7 : 6;
    this.fuseAvailable = training || difficulty < 0.8;

    let caps!: Caps;
    let solutions: number[] = [];
    let safe = new Uint8Array(0);

    // Sorteia capacidades até existir pelo menos um estado de vitória, com as
    // faixas afrouxando a cada tentativa: garante terminação e nunca entrega
    // um painel insolúvel. A FONTE nunca estoura por vazão — ela é a origem;
    // o que a mata é não ter para onde mandar (regra em `solve`).
    const openBuf = new Array<boolean>(EDGES.length);
    for (let attempt = 0; attempt < 40; attempt++) {
      const slack = Math.floor(attempt / 8);
      const mid = () => 5 + slack + rng.int(4);
      caps = {
        FONTE: TOTAL,
        A: mid(),
        B: mid(),
        C: mid(),
        D: mid(),
        E: mid(),
        F: mid(),
        PRENSA: 999,
        DESCARGA: 7 + slack + rng.int(3),
        QUEIMADOR: 7 + slack + rng.int(3),
      } as Caps;

      solutions = [];
      const total = 1 << EDGES.length;
      safe = new Uint8Array(total);
      for (let mask = 0; mask < total; mask++) {
        for (let i = 0; i < EDGES.length; i++) openBuf[i] = (mask & (1 << i)) !== 0;
        const { loads, burst } = solve(caps, openBuf);
        if (burst) continue;
        safe[mask] = 1;
        if (loads.PRENSA <= 1e-6) solutions.push(mask);
      }
      if (solutions.length > 0) break;
    }

    this.caps = caps;

    // BFS no hipercubo de 15 bits partindo de todas as configurações de
    // vitória — mas **só atravessando estados sem ruptura**. Uma ruptura
    // encerra a missão, então o caminho até a vitória tem que ser seguro em
    // cada passo intermediário; contar Hamming puro produzia painéis que só
    // podiam ser resolvidos explodindo no meio do caminho.
    const total = 1 << EDGES.length;
    this.distField = new Uint8Array(total).fill(255);
    const queue = solutions.slice();
    for (const m of queue) this.distField[m] = 0;
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      const d = this.distField[cur]! + 1;
      for (let b = 0; b < EDGES.length; b++) {
        const nxt = cur ^ (1 << b);
        if (!safe[nxt] || this.distField[nxt]! <= d) continue;
        this.distField[nxt] = d;
        queue.push(nxt);
      }
    }

    // Estado inicial escolhido PELO campo de distância, não por embaralhamento
    // cego: precisa estar a exatamente N manobras seguras da vitória, com N
    // dentro do orçamento. Assim o painel é sempre resolvível sem estourar.
    const want = Math.min(this.maxTurns - 1, targetDistance);
    let pool: number[] = [];
    for (let d = want; d >= 1 && !pool.length; d--) {
      for (let mask = 0; mask < this.distField.length; mask++) {
        if (this.distField[mask] === d) pool.push(mask);
      }
    }
    const start = pool.length ? pool[rng.int(pool.length)]! : (solutions[0] ?? 0);
    this.open = EDGES.map((_, i) => (start & (1 << i)) !== 0);
  }

  private mask(open: boolean[] = this.open): number {
    let m = 0;
    for (let i = 0; i < open.length; i++) if (open[i]) m |= 1 << i;
    return m;
  }

  private distanceToWin(open: boolean[]): number {
    return this.distField[this.mask(open)]!;
  }

  private score(open: boolean[]): number {
    const { loads, burst } = solve(this.caps, open);
    if (burst) return FATAL_SCORE;
    if (loads.PRENSA <= 1e-6) return WIN_SCORE;

    // Prioridade lexicográfica: primeiro encurta a menor rota segura; só
    // desempata pela pressão imediata. Uma unidade de distância vale muito
    // mais que toda a faixa possível de carga (0..12).
    return -this.distanceToWin(open) * 1000 - loads.PRENSA;
  }

  node(): MissionNode {
    const { loads } = solve(this.caps, this.open);

    // Uma linha por nó, com as válvulas de saída inline. A versão anterior
    // gastava 25 linhas e engolia o mundo 3D inteiro — sob cronômetro, o olho
    // não tem para onde subir.
    const line = (n: NodeId): string => {
      const cap = n === 'PRENSA' ? '  —' : String(this.caps[n]).padStart(3);
      const gauge = n === 'PRENSA' ? '<span class="bad">ALVO 0.0 </span>' : bar(loads[n], this.caps[n]);
      const name =
        n === 'PRENSA'
          ? `<span class="bad">${n.padEnd(9)}</span>`
          : `<span class="hl">${n.padEnd(9)}</span>`;

      const valves = OUT[n]
        .map((i) => {
          const e = EDGES[i]!;
          const st = this.open[i]
            ? '<span class="ok">ABR</span>'
            : '<span class="ghost">FEC</span>';
          return `<span class="key">${e.id}</span>→${short(e.to).padEnd(3)} ${st}`;
        })
        .join('  ');

      return `  ${name}${loads[n].toFixed(1).padStart(5)}/${cap} ${gauge}  ${valves}`;
    };

    const grid = ORDER.map((n) => line(n)).join('\n');

    const warn = this.lastBurst ? `\n<span class="bad">ÚLTIMA FALHA: ${this.lastBurst}</span>` : '';
    const fuse =
      this.difficulty < 0.8
        ? `\n<span class="${this.fuseAvailable ? 'key' : 'ghost'}">FUSÍVEL DE CONTENÇÃO: ${
            this.fuseAvailable ? 'PRONTO' : 'QUEIMADO'
          }</span>`
        : '';

    const guided =
      this.difficulty < 0
        ? `<span class="key">  PRÁTICA DE DIAGNÓSTICO · PREVISÃO AUTOMÁTICA DESLIGADA</span>\n` +
          `  Trace as válvulas ABR desde a FONTE. Confira CARGA/CAP e preserve uma saída de alívio.\n` +
          (this.lastReport ? `  <span class="key">DEPOIS DA ÚLTIMA:</span> ${this.lastReport}\n` : '') +
          '\n'
        : '';

    return {
      nodeLabel: `MANOBRA ${this.turn}/${this.maxTurns}`,
      bodyHtml:
        `${guided}<span class="f">  NÓ         CARGA/CAP            VÁLVULAS DE SAÍDA</span>\n${grid}${warn}${fuse}\n` +
        `<span class="f">  pressão que não escoa arrebenta o nó · a prensa precisa chegar a 0.0</span>`,
      prompt:
        this.difficulty < 0
          ? 'Qual válvula desvia a carga sem prender nem sobrecarregar o fluxo?'
          : 'Qual válvula você aciona?',
      options: this.options().map(({ id, label }) => ({ id, label })),
      timeLimit: clamp(20 - this.difficulty * 5, 9, 20),
    };
  }

  private options(): Array<{
    id: string;
    label: string;
    index: number;
    score: number;
    distance: number;
    safe: boolean;
  }> {
    // node(), peekBest() e choose() pedem as mesmas alternativas no mesmo
    // turno — sem o cache isso era calculado três vezes por pergunta.
    const key = ((this.turn << 16) ^ this.mask()) >>> 0;
    if (this.optionCache && this.optionCache.key === key) return this.optionCache.value;

    const rng = new Rng(((this.turn * 7919) ^ this.mask()) >>> 0);
    const before = solve(this.caps, this.open);
    const beforeDistance = this.distanceToWin(this.open);
    const all = EDGES.map((e, i) => {
      const trial = [...this.open];
      trial[i] = !trial[i];
      const after = solve(this.caps, trial);
      const distance = after.burst ? 255 : this.distanceToWin(trial);
      const action = `${this.open[i] ? 'FECHAR' : 'ABRIR'} ${e.id}  (${e.from} → ${e.to})`;
      const current = this.open[i] ? 'ABERTA' : 'FECHADA';
      const reading = (node: NodeId): string =>
        node === 'PRENSA'
          ? `${node} ${before.loads[node].toFixed(1)}`
          : `${node} ${before.loads[node].toFixed(1)}/${this.caps[node]}`;

      // O botão descreve somente o hardware diante do jogador. `after`,
      // `distance` e `score` continuam existindo para garantir uma partida
      // solucionável, mas nunca funcionam como previsão na interface.
      const label = `${action} · AGORA ${current} · ${reading(e.from)} → ${reading(e.to)}`;

      return {
        id: e.id,
        index: i,
        label,
        score: this.score(trial),
        distance,
        safe: after.burst === null,
        pressureAfter: after.loads.PRENSA,
        loadedOrigin: before.loads[e.from] > 1e-9,
      };
    });

    const sorted = [...all].sort((a, b) => b.score - a.score);
    const best = sorted[0]!;
    const selected = [best];

    // Quatro alternativas deliberadas, em vez de três rolagens cegas:
    // a solução, pelo menos duas manobras seguras que parecem relevantes e,
    // quando existe, somente uma ruptura possível. Uma queda imediata de
    // pressão que não encurta a rota é um bom distrator porque obriga a ler o
    // restante da rede, não apenas a procurar o menor número.
    const selectedIds = new Set([best.id]);
    const add = (candidate: (typeof all)[number] | undefined): void => {
      if (!candidate || selectedIds.has(candidate.id)) return;
      selected.push(candidate);
      selectedIds.add(candidate.id);
    };

    const safeRest = rng.shuffle(all.filter((o) => o.id !== best.id && o.safe));
    const greedyTrap = safeRest
      .filter((o) => o.pressureAfter < before.loads.PRENSA - 0.01 && o.distance >= beforeDistance)
      .sort((a, b) => a.pressureAfter - b.pressureAfter)[0];
    add(greedyTrap);

    const plausibleSafe = safeRest.sort((a, b) => {
      const routeA = Math.abs(a.distance - beforeDistance);
      const routeB = Math.abs(b.distance - beforeDistance);
      if (routeA !== routeB) return routeA - routeB;
      if (a.loadedOrigin !== b.loadedOrigin) return a.loadedOrigin ? -1 : 1;
      return Math.abs(a.pressureAfter - before.loads.PRENSA) - Math.abs(b.pressureAfter - before.loads.PRENSA);
    });
    for (const candidate of plausibleSafe) {
      if (selected.length >= 3) break;
      add(candidate);
    }

    const hazard = rng.shuffle(all.filter((o) => !o.safe && !selectedIds.has(o.id)))[0];
    add(hazard);
    for (const candidate of plausibleSafe) {
      if (selected.length >= 4) break;
      add(candidate);
    }

    // Só ocorre em redes extremamente restritas; ainda assim, nunca duplica
    // botões e preserva o limite de quatro escolhas.
    for (const candidate of rng.shuffle(all.filter((o) => !selectedIds.has(o.id)))) {
      if (selected.length >= 4) break;
      add(candidate);
    }

    const value = rng.shuffle(selected.slice(0, 4));
    this.optionCache = { key, value };
    return value;
  }

  /** O que essa manobra faz com a rede, em números. */
  private explain(index: number): string {
    const trial = [...this.open];
    trial[index] = !trial[index];
    const e = EDGES[index]!;
    const verb = this.open[index] ? 'fechar' : 'abrir';

    const before = solve(this.caps, this.open);
    const after = solve(this.caps, trial);

    if (after.burst) {
      const n = after.burst;
      const stillOpen = OUT[n].filter((i) => trial[i]).length;
      if (OUT[n].length > 0 && stillOpen === 0) {
        return `${verb} ${e.id} deixa ${n} sem nenhuma saída aberta — a pressão fica presa e arrebenta`;
      }
      return `${verb} ${e.id} joga ${after.loads[n].toFixed(1)} em ${n}, que aguenta ${this.caps[n]}`;
    }

    const d = before.loads.PRENSA - after.loads.PRENSA;
    if (d > 0.01) return `${verb} ${e.id} tira ${d.toFixed(1)} da prensa`;
    if (d < -0.01) return `${verb} ${e.id} manda mais ${(-d).toFixed(1)} para a prensa`;
    return `${verb} ${e.id} não muda a prensa neste instante`;
  }

  peekBest(): string | null {
    return [...this.options()].sort((a, b) => b.score - a.score)[0]?.id ?? null;
  }

  choose(optionId: string | null): Resolution {
    const opts = this.options();
    const picked = opts.find((o) => o.id === optionId) ?? null;

    if (!picked) {
      const current = solve(this.caps, this.open).loads.PRENSA.toFixed(1);
      this.lastReport = `nenhuma válvula acionada · PRENSA continuou em ${current}`;
      this.turn++;
      return {
        verdict: 'BAD',
        feedback:
          this.difficulty < 0
            ? `SEM MANOBRA — PRENSA permaneceu em ${current}. O relógio consumiu uma tentativa.`
            : 'Nenhuma manobra. A rede seguiu como estava.',
        bestOptionId: null,
        finished: this.turn > this.maxTurns,
        success: false,
        epilogue: this.turn > this.maxTurns ? 'O painel travou. Manutenção encerrada.' : undefined,
      };
    }

    // explicações têm que sair ANTES do toggle: elas comparam antes×depois
    const before = solve(this.caps, this.open);
    const beforeDistance = this.distanceToWin(this.open);
    const pickedWhy = this.explain(picked.index);

    this.open[picked.index] = !this.open[picked.index];
    const { loads, burst } = solve(this.caps, this.open);
    this.turn++;

    if (burst) {
      this.lastBurst = burst;
      if (this.fuseAvailable) {
        this.fuseAvailable = false;
        this.open[picked.index] = !this.open[picked.index];
        this.maxTurns++; // o fusível também devolve a manobra consumida
        this.lastReport =
          `${picked.id} causaria ruptura em ${burst} · FUSÍVEL desfez a ação · ` +
          `PRENSA voltou a ${before.loads.PRENSA.toFixed(1)}`;
        return {
          verdict: 'BAD',
          feedback:
            this.difficulty < 0
              ? `FUSÍVEL ACIONADO — ${pickedWhy}. A válvula voltou ao estado anterior; ` +
                `PRENSA continua em ${before.loads.PRENSA.toFixed(1)}.`
              : `FUSÍVEL: ruptura em ${burst} absorvida — ${pickedWhy}. A válvula voltou ao estado anterior.`,
          bestOptionId: null,
          finished: false,
          success: false,
        };
      }
      this.lastReport =
        `${picked.id} · PRENSA antes ${before.loads.PRENSA.toFixed(1)} · ` +
        `DEPOIS: ruptura em ${burst}`;
      return {
        verdict: 'FATAL',
        feedback:
          this.difficulty < 0
            ? `ANTES: PRENSA ${before.loads.PRENSA.toFixed(1)}. AÇÃO: ${pickedWhy}. ` +
              `DEPOIS: RUPTURA EM ${burst}.`
            : `Ruptura em ${burst}: ${pickedWhy}.`,
        bestOptionId: null,
        finished: true,
        success: false,
        cue: 'PIPE_BURST',
        epilogue:
          'Óleo quente na esteira, vapor até o teto, e o painel morto. ' +
          'Você acabou de dar mais força para a coisa que está te esperando.',
      };
    }

    const afterDistance = this.distanceToWin(this.open);
    const transition = `PRENSA ${before.loads.PRENSA.toFixed(1)}→${loads.PRENSA.toFixed(1)}`;
    this.lastReport = `${picked.id} · ${transition} · ${pickedWhy}`;

    if (loads.PRENSA <= 1e-6) {
      return {
        verdict: 'GOOD',
        feedback:
          this.difficulty < 0
            ? `META CUMPRIDA — ANTES/DEPOIS: ${transition}. CAUSA: ${pickedWhy}.`
            : 'Prensa em zero. A carga foi desviada para as saídas de segurança.',
        bestOptionId: null,
        finished: true,
        success: true,
        epilogue: 'O martelo perdeu força por alguns instantes. Alguns instantes é tudo que existe aqui.',
      };
    }

    if (this.turn > this.maxTurns) {
      return {
        verdict: 'BAD',
        feedback:
          this.difficulty < 0
            ? `A manobra fez ${transition}, mas a janela acabou antes de PRENSA 0.0.`
            : 'Janela de manutenção encerrada com pressão na prensa.',
        bestOptionId: null,
        finished: true,
        success: false,
        epilogue: 'O painel se apagou sozinho. Alguém, em algum lugar, decidiu que já bastava.',
      };
    }

    const verdict: Resolution['verdict'] =
      afterDistance < beforeDistance ? 'GOOD' : afterDistance > beforeDistance ? 'BAD' : 'NEUTRAL';
    const prensa = `Prensa em ${loads.PRENSA.toFixed(1)}.`;
    const feedback =
      this.difficulty < 0
        ? verdict === 'GOOD'
          ? `MANOBRA ÚTIL — ANTES/DEPOIS: ${transition}. CAUSA: ${pickedWhy}.`
          : verdict === 'BAD'
            ? `DESVIO INEFICIENTE — ANTES/DEPOIS: ${transition}. CAUSA: ${pickedWhy}.`
            : `EFEITO LOCAL — ANTES/DEPOIS: ${transition}. CAUSA: ${pickedWhy}.`
        : verdict === 'GOOD'
          ? `CERTO: ${pickedWhy}. ${prensa}`
          : verdict === 'BAD'
            ? `ERRO: ${pickedWhy}. A rota segura ficou mais longa. ${prensa}`
            : `${pickedWhy}. A rota não encurtou. ${prensa}`;

    return {
      verdict,
      feedback,
      bestOptionId: null,
      finished: false,
      success: false,
    };
  }
}

export const valveKind: MissionKind = {
  id: 'purga',
  name: 'PROTOCOLO DE PURGA',
  create: (seed, difficulty) => new ValveMission(seed, difficulty),
};
