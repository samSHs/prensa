import { clamp } from '../../core/rng';
import type { Mission, MissionKind, MissionNode, MissionUpdate, Resolution } from '../types';
import { renderMap } from './render';
import {
  CLOSET,
  DIRS,
  HUNT,
  INVESTIGATE,
  PHONE,
  RADIO_SCRUB_SECONDS,
  SECTOR_NAMES,
  advanceKillerTick,
  advanceRadioTrace,
  advanceSurvivorTick,
  bfs,
  clone,
  corridorRun,
  emitRadioTrace,
  evaluate,
  generate,
  idx,
  radioTraceLoad,
  issueCommand,
  remainingPath,
  sectorOf,
  setRadioTx,
  step,
  tileLabel,
  walkable,
  type LabAction,
  type LabState,
} from './sim';

interface Candidate {
  id: string;
  label: string;
  action: LabAction;
  score: number;
  kind: string;
  /** estado resultante — guardado para poder EXPLICAR a jogada depois */
  sim: LabState;
}

const killerDist = (s: LabState): number => {
  const d = bfs(s, s.kil.x, s.kil.y)[idx(s, s.sur.x, s.sur.y)]!;
  return d < 0 ? 99 : d;
};

/** O que esta ordem causa, numa oração. É isto que ensina o jogo. */
function effectOf(before: LabState, c: Candidate): string {
  const a = c.sim;
  if (!a.sur.alive) return 'ela morre neste turno';
  if (a.sur.out) return 'ela sai pela porta';

  const kd = killerDist(a);
  const gained = remainingPath(before) - remainingPath(a);
  const alvo = a.sur.key ? 'da saída' : 'da chave';

  switch (c.action.k) {
    case 'HIDE':
      return `ela segue para o ${tileLabel(before, idx(before, c.action.x, c.action.y))}; ele fica a ${kd} célula(s)`;
    case 'LIGHT':
      return before.lights[c.action.s]
        ? `no escuro ele enxerga 3 células em vez de ${before.visionLit}`
        : 'a luz acesa longe puxa ele para aquele setor';
    case 'LURE':
      return `o telefone arrasta ele para o outro lado (ficou a ${kd})`;
    case 'WAIT':
      return `ela congela; ele fica a ${kd} célula(s)`;
    default:
      if (gained > 0) return `avança ${gained} célula(s) rumo ${alvo}, caçador a ${kd}`;
      if (gained < 0) return `recua ${-gained} célula(s) ${alvo}, caçador a ${kd}`;
      return `não encurta o caminho; caçador a ${kd}`;
  }
}

/** Por que a ordem escolhida foi ruim. Uma causa só, a dominante. */
function faultOf(before: LabState, c: Candidate): string {
  const a = c.sim;
  if (!a.sur.alive) return 'ela morreu por causa disso';
  if (a.kil.mode === HUNT && before.kil.mode !== HUNT) return 'jogou ela no campo de visão dele';

  const kd = killerDist(a);
  if (kd <= 3) return `deixou ela a ${kd} célula(s) do caçador`;

  const gained = remainingPath(before) - remainingPath(a);
  if (gained < 0) return `afastou ela ${-gained} célula(s) do objetivo`;
  if (gained === 0) return 'gastou um turno sem tirar ela do lugar';
  return 'havia jogada melhor disponível';
}

/**
 * Paleta de uma decisão real. A ordem é canônica e cada ID descreve a ação;
 * nenhum deles depende da posição que ocupou na lista. Enquanto a refém está
 * parada esta fotografia permanece intacta, mesmo que o caçador se mova.
 */
function buildCandidates(s: LabState): Candidate[] {
  const out: Candidate[] = [];
  const push = (id: string, label: string, action: LabAction, kind: string) => {
    out.push({ id, label, action, score: 0, kind, sim: s });
  };

  for (const d of DIRS) {
    if (!walkable(s, s.sur.x + d.dx, s.sur.y + d.dy)) continue;
    const key = d.dy < 0 ? 'W' : d.dx > 0 ? 'D' : d.dy > 0 ? 'S' : 'A';
    push(
      `MOVE:${d.name}`,
      `SIGA PARA O ${d.name} · [${key}]`,
      { k: 'MOVE', dx: d.dx, dy: d.dy, steps: 1 },
      `mv${d.name}`,
    );
  }

  const here = idx(s, s.sur.x, s.sur.y);
  if (s.tiles[here] === CLOSET && !s.sur.hidden) {
    const name = tileLabel(s, here);
    push(
      `HIDE:${name}`,
      `ENTRE NO ARMÁRIO ${name}`,
      { k: 'HIDE', x: s.sur.x, y: s.sur.y },
      `hide${here}`,
    );
  }

  // Telefones nunca são descritos apenas por quadrante: o mesmo F impresso
  // no botão está impresso na planta. Usados viram piso e somem somente depois
  // de uma escolha confirmada, jamais durante uma decisão aberta.
  for (let i = 0; i < s.tiles.length; i++) {
    if (s.tiles[i] !== PHONE) continue;
    const x = i % s.w;
    const y = (i / s.w) | 0;
    const name = tileLabel(s, i);
    push(
      `LURE:${name}`,
      `TOCAR ${name} — MARCADO NO MAPA · ${SECTOR_NAMES[sectorOf(s, x, y)]}`,
      { k: 'LURE', x, y },
      `lure${i}`,
    );
  }

  // Um único disjuntor contextual substitui a antiga lista rotativa de
  // quadrantes. É a luz ao redor da vítima, portanto a consequência é legível.
  const surSec = sectorOf(s, s.sur.x, s.sur.y);
  const on = s.lights[surSec]!;
  push(
    `LIGHT:${SECTOR_NAMES[surSec]}`,
    `${on ? 'APAGUE' : 'ACENDA'} AS LUZES AO REDOR DELA · ${SECTOR_NAMES[surSec]}`,
    { k: 'LIGHT', s: surSec },
    `lite${surSec}`,
  );

  const labels = new Set<string>();
  return out.filter((candidate) => {
    const normalized = candidate.label.replace(/\s+/g, ' ').trim();
    if (labels.has(normalized)) return false;
    labels.add(normalized);
    return true;
  });
}

function scoreAll(s: LabState, cands: Candidate[], live: boolean): void {
  for (const c of cands) {
    const sim = clone(s);
    const voice = c.action.k !== 'LURE' && c.action.k !== 'LIGHT';
    if (live && voice && !sim.radio.txOpen) {
      c.sim = sim;
      c.score = -1000000;
      continue;
    }
    if (live && voice && !sameActiveOrder(sim, c.action)) emitRadioTrace(sim);
    step(sim, c.action);
    c.sim = sim;
    c.score = evaluate(sim);
  }
}

function riskyCommand(before: LabState, c: Candidate): boolean {
  if (!c.sim.sur.alive) return true;
  if (c.sim.kil.mode === HUNT && before.kil.mode !== HUNT) return true;
  return killerDist(c.sim) <= 3;
}

function sameActiveOrder(s: LabState, action: LabAction): boolean {
  if (s.sur.pending) return false;
  const intent = s.sur.intent;
  if (action.k === 'MOVE' && intent.k === 'MOVE') {
    return action.dx === intent.dx && action.dy === intent.dy;
  }
  if (action.k === 'HIDE' && intent.k === 'HIDE') {
    return action.x === intent.x && action.y === intent.y;
  }
  return action.k === 'WAIT' && intent.k === 'WAIT';
}

class LabyrinthMission implements Mission {
  readonly id = 'labirinto';
  readonly name = 'O LABIRINTO';
  readonly live = true;
  readonly brief =
    'Tem outra pessoa presa aqui, e ela não sabe que existe alguém do outro lado do rádio. ' +
    'Você vê as câmeras. Ela não vê nada.';

  readonly howTo = [
    '<span class="hl">VOCÊ NÃO ESTÁ NO LABIRINTO. VOCÊ ESTÁ NAS CÂMERAS.</span>',
    '',
    'Tem uma refém lá dentro com um fone no ouvido. Você não pilota o corpo',
    'dela: transmite uma ordem quando ela pede ajuda. O caçador nunca pausa.',
    '',
    '  <span class="key">OBJETIVO</span>   ela pega a chave <span class="key">$</span> e chega até a saída <span class="exit">][</span>',
    '  <span class="key">AMEAÇA</span>     o caçador <span class="him">†</span> mata se chegar ao lado dela',
    '',
    '  <span class="key">CORREDORES</span> uma direção move ela <span class="hl">IMEDIATAMENTE</span>. Ela atravessa',
    '             retas e curvas obrigatórias sozinha, parando apenas onde há escolha.',
    '             Durante o trajeto não aparece uma lista: observe e espere o rádio.',
    '',
    '  <span class="key">DECISÕES</span>   ao ouvir “cruzamento”, as alternativas ficam <span class="hl">CONGELADAS</span>.',
    '             O mapa e o caçador continuam vivos, mas nenhum botão troca de lugar',
    '             ou de significado enquanto você decide.',
    '',
    '  <span class="key">DOIS RELÓGIOS</span> ela e o caçador andam em ritmos independentes e rápidos.',
    '             A barra mede o próximo passo dele — não o movimento dela.',
    '',
    '  <span class="key">A BRECHA</span>   ele só persegue enquanto <span class="hl">ENXERGA</span>. Depois procura',
    '             perto do último contato. Armários <span class="hide">A1</span>, <span class="hide">A2</span> têm nome.',
    '',
    '  <span class="key">O ESCURO</span>  “APAGUE AS LUZES AO REDOR DELA” reduz a visão dele.',
    '             Telefones <span class="lure">F1</span>, <span class="lure">F2</span> atraem o caçador: o identificador',
    '             do botão é exatamente o mesmo que está desenhado no mapa.',
    '',
    '  <span class="key">O RÁDIO</span>    ordens contraditórias ou suicidas quebram a confiança.',
    '             Tremendo, ela hesita. Sem confiar, ela pode recusar.',
    '             Cada nova transmissão deixa uma amostra <span class="bad">△</span> por 6 segundos.',
    '             Duas amostras triangulam o último ponto e mandam o caçador investigar.',
    '             [0] corta o TX. Dois segundos de silêncio limpam as amostras;',
    '             ela continua a ordem ativa e o canal de retorno permanece aberto.',
    '',
    '<span class="ghost">Você vê a planta inteira, mas só vê o caçador onde há câmera.</span>',
    '<span class="ghost">Sem câmera sobra o <span class="ghost">?</span> — onde ele estava da última vez.</span>',
  ].join('\n');

  private state: LabState;
  private shown: Candidate[] = [];
  private cands: Candidate[] = [];
  /** assinatura do ponto onde a lista foi fotografada; não inclui o caçador */
  private deckSignature = '';
  private survivorClock = 0;
  private hunterClock = 0;
  private readonly survivorEvery: number;
  private readonly hunterEvery: number;
  private pendingBeltGain = 0;
  private interventionNeeded = false;
  private liveActivated = false;
  private ended = false;

  constructor(seed: number, private difficulty: number) {
    this.state = generate(seed, difficulty);
    // Corredores são rápidos; a duração vem de poucas decisões reais e da
    // evasão, não de esperar uma célula por segundo. No fim da campanha o
    // caçador fecha a vantagem e ainda ganha passos extras durante HUNT.
    this.survivorEvery = clamp(0.52 - difficulty * 0.06, 0.34, 0.52);
    this.hunterEvery = clamp(0.90 - difficulty * 0.15, 0.46, 0.90);
  }

  private waitingForOrder(): boolean {
    const s = this.state.sur;
    return s.intent.k === 'WAIT' && s.pending === null && s.hesitate <= 0;
  }

  private currentDeckSignature(): string {
    const s = this.state;
    if (!this.waitingForOrder()) return 'CORRIDOR';
    // Estado do caçador, relógios, RNG, confiança e rádio são propositalmente
    // ausentes: eles atualizam o risco, não o significado da mão do jogador.
    return [
      'DECISION',
      s.sur.x,
      s.sur.y,
      Number(s.sur.hidden),
      Number(s.sur.key),
      s.tiles[idx(s, s.sur.x, s.sur.y)],
    ].join(':');
  }

  private invalidateDeck(): void {
    this.deckSignature = '';
  }

  private refresh(): void {
    const signature = this.currentDeckSignature();
    if (signature === this.deckSignature) return;
    this.deckSignature = signature;
    if (signature === 'CORRIDOR') {
      this.cands = [];
      this.shown = [];
      return;
    }

    this.cands = buildCandidates(this.state);
    scoreAll(this.state, this.cands, this.liveActivated);
    this.shown = [...this.cands];
  }

  /** Recalcula risco sem reordenar, remover ou renomear a fotografia visível. */
  private rescoreShown(): void {
    for (const candidate of this.shown) {
      candidate.score = 0;
      candidate.sim = this.state;
    }
    scoreAll(this.state, this.shown, this.liveActivated);
  }

  node(): MissionNode {
    this.refresh();
    const s = this.state;
    const moveIntent = s.sur.intent.k === 'MOVE' ? s.sur.intent : null;
    const moving = moveIntent !== null;
    const direction = moveIntent
      ? moveIntent.dy < 0 ? 'NORTE'
      : moveIntent.dx > 0 ? 'LESTE'
      : moveIntent.dy > 0 ? 'SUL'
      : 'OESTE'
      : '';
    const prompt =
      !s.radio.txOpen
        ? s.kil.mode === HUNT
          ? 'TX CORTADO. Ele está vindo; [0] reabre a transmissão para intervir.'
          : moving
            ? 'TX CORTADO. Ela continua a ordem sozinha; [0] reabre quando precisar falar.'
            : s.sur.hidden
              ? 'TX CORTADO. Ela permanece escondida; [0] reabre a transmissão.'
              : 'TX CORTADO. Ela está esperando sem ouvir você; pressione [0].'
      : s.kil.mode === HUNT && this.waitingForOrder()
        ? 'ELE ESTÁ VINDO. Ela parou e espera uma ordem — as opções não vão mudar.'
      : s.sur.hesitate > 0 || s.sur.pending
          ? 'Ela está hesitando. O caçador continua; espere a resposta no rádio.'
          : moving
            ? `ORDEM ATIVA: ${direction}. Ela atravessa o corredor sozinha; observe até a próxima decisão.`
            : s.sur.hidden
              ? 'Ela está escondida. As ordens abaixo permanecem fixas enquanto você escuta os passos.'
              : 'ELA PEDIU UMA ORDEM. Escolha uma vez; esta lista permanecerá fixa.';
    return {
      nodeLabel: `EXPOSIÇÃO ${String(s.turn).padStart(2, '0')}/${s.maxTurns}`,
      bodyHtml: renderMap(s),
      prompt,
      options: this.shown.map((c) => {
        const voice = c.action.k !== 'LURE' && c.action.k !== 'LIGHT';
        return {
          id: c.id,
          label: !s.radio.txOpen && voice ? `TX CORTADO — ${c.label}` : c.label,
        };
      }),
      timeLimit: clamp(this.hunterEvery - this.hunterClock, 0.05, this.hunterEvery),
      continuous: true,
      continuousTotal: this.hunterEvery,
    };
  }

  private fatalResolution(bestOptionId: string | null = null): Resolution {
    this.ended = true;
    const events = this.state.events.join(' ') || this.state.lastEvent;
    return {
      verdict: 'FATAL',
      feedback: `${events} O rádio ficou mudo.`,
      bestOptionId,
      finished: true,
      success: false,
      cue: 'VICTIM_SCREAM',
      epilogue:
        'Você ouviu tudo. Depois veio uma pancada no microfone e só o chiado — ' +
        'e a sua esteira, que não parou nenhum instante.',
    };
  }

  private successResolution(bestOptionId: string | null = null): Resolution {
    this.ended = true;
    return {
      verdict: 'GOOD',
      feedback: 'Ela saiu. A porta bateu.',
      bestOptionId,
      finished: true,
      success: true,
      epilogue:
        'Ela saiu e nunca vai saber que existiu você. O painel registra a fuga ' +
        'como falha de contenção. Falha de contenção é crédito na sua conta.',
    };
  }

  private timeoutResolution(bestOptionId: string | null = null): Resolution {
    this.ended = true;
    return {
      verdict: 'BAD',
      feedback: 'Tempo de exposição esgotado. A sala vai ser trancada com ela dentro.',
      bestOptionId,
      finished: true,
      success: false,
      epilogue: 'O setor foi selado. O que sobrou lá dentro não é problema seu — é o seu castigo.',
    };
  }

  private creditSurvivorProgress(pathBefore: number, hadKey: boolean): number {
    const pathAfter = remainingPath(this.state);
    const progress = Math.max(0, pathBefore - pathAfter);
    // A recompensa é por terreno real, não por cliques. O late game acelera
    // sem imprimir crédito extra por segundo na esteira.
    const paceScale = this.survivorEvery / 0.82;
    let gain = progress * 0.82 * paceScale;
    if (!hadKey && this.state.sur.key) gain += 0.55 * paceScale;
    return gain;
  }

  update(dt: number): MissionUpdate | null {
    if (this.ended) return null;
    if (!this.liveActivated) {
      this.liveActivated = true;
      // IDs e ordem já eram os mesmos antes do primeiro frame. Só a física
      // usada pelo avaliador muda, eliminando o antigo TOCTOU de abertura.
      this.rescoreShown();
    }
    const elapsed = clamp(dt, 0, 0.25);
    this.survivorClock += elapsed;
    this.hunterClock += elapsed;
    let changed = advanceRadioTrace(this.state, elapsed);
    let beltGain = this.pendingBeltGain;
    this.pendingBeltGain = 0;

    // Processa os relógios pela ordem temporal real. Se ambos vencerem no
    // mesmo frame, o maior atraso aconteceu primeiro; empate favorece a refém.
    for (let guard = 0; guard < 12 && !this.ended; guard++) {
      const survivorDue = this.survivorClock >= this.survivorEvery;
      const hunterDue = this.hunterClock >= this.hunterEvery;
      if (!survivorDue && !hunterDue) break;

      const survivorFirst =
        survivorDue &&
        (!hunterDue ||
          this.survivorClock - this.survivorEvery >= this.hunterClock - this.hunterEvery);
      const hunterModeBefore = this.state.kil.mode;

      if (survivorFirst) {
        this.survivorClock -= this.survivorEvery;
        const pathBefore = remainingPath(this.state);
        const hadKey = this.state.sur.key;
        changed = advanceSurvivorTick(this.state) || changed;
        beltGain += this.creditSurvivorProgress(pathBefore, hadKey);
      } else {
        this.hunterClock -= this.hunterEvery;
        const wasHunted = this.state.kil.mode === HUNT;
        advanceKillerTick(this.state);
        changed = true;
        if (wasHunted && this.state.kil.mode !== HUNT && this.state.sur.alive) {
          beltGain += 0.35 * (this.hunterEvery / 1.28);
        }
      }

      if (hunterModeBefore !== HUNT && this.state.kil.mode === HUNT) {
        this.interventionNeeded = true;
        // Um contato visual é um novo ponto de decisão explícito. Ela entra
        // em pânico e para; não surge uma lista nova enquanto ainda corria e
        // não se obriga o jogador a adivinhar uma curva futura.
        if (!this.state.sur.hidden && this.state.sur.intent.k !== 'WAIT') {
          this.state.sur.intent = { k: 'WAIT' };
          this.state.sur.pending = null;
          this.state.sur.hesitate = 0;
          this.state.sur.refusePending = false;
          this.state.events.push('“Eu vi ele.” Ela parou sem esperar autorização.');
          this.state.lastEvent = this.state.events.join(' ');
          changed = true;
        }
      }

      if (!this.state.sur.alive) {
        return {
          changed: true,
          beltGain: beltGain || undefined,
          resolution: this.fatalResolution(),
        };
      }
      if (this.state.sur.out) {
        return {
          changed: true,
          beltGain: beltGain || undefined,
          resolution: this.successResolution(),
        };
      }
      if (this.state.turn > this.state.maxTurns) {
        return {
          changed: true,
          beltGain: beltGain || undefined,
          resolution: this.timeoutResolution(),
        };
      }
    }
    return changed || beltGain ? { changed, beltGain: beltGain || undefined } : null;
  }

  private silenceWindow(): number {
    const s = this.state;
    if (this.ended || !s.sur.alive || s.sur.out) return 99;
    if (this.interventionNeeded || s.kil.mode === HUNT || s.sur.pending || s.sur.hesitate > 0) return 0;

    const intent = s.sur.intent;
    if (intent.k === 'WAIT') return s.sur.hidden ? 4 : 0;

    let steps = 0;
    if (intent.k === 'HIDE') {
      const distance = bfs(s, intent.x, intent.y)[idx(s, s.sur.x, s.sur.y)]!;
      steps = Math.max(0, distance);
    } else {
      steps = corridorRun(s, intent.dx, intent.dy);
    }

    if (steps <= 0) return 0;
    const first = Math.max(0, this.survivorEvery - this.survivorClock);
    return clamp(first + Math.max(0, steps - 1) * this.survivorEvery, 0, 12);
  }

  shortcut(raw: string): Resolution | null {
    if (this.ended) return null;
    const directionId: Record<string, string> = {
      w: 'MOVE:NORTE',
      d: 'MOVE:LESTE',
      s: 'MOVE:SUL',
      a: 'MOVE:OESTE',
    };
    const direct = directionId[raw.toLowerCase()];
    if (direct) {
      this.refresh();
      if (this.shown.some((candidate) => candidate.id === direct)) return this.choose(direct);
      return {
        verdict: 'NEUTRAL',
        feedback: this.waitingForOrder()
          ? 'Há uma parede nessa direção. Nada foi transmitido.'
          : 'Ela ainda está atravessando o corredor. Aguarde a próxima chamada.',
        bestOptionId: null,
        finished: false,
        success: false,
      };
    }
    if (raw !== '0') return null;
    const opening = !this.state.radio.txOpen;
    setRadioTx(this.state, opening);

    const load = radioTraceLoad(this.state);
    return {
      verdict: 'NEUTRAL',
      feedback: opening
        ? load > 0
          ? 'TX reaberto. A assinatura antiga ainda existe; falar agora pode completar a triangulação.'
          : 'TX reaberto. Ela voltou a ouvir você.'
        : load > 0
          ? `TX cortado. Segure o silêncio por ${RADIO_SCRUB_SECONDS.toFixed(0)} segundos para limpar a assinatura.`
          : 'TX cortado. Ela continuará a última ordem sem ouvir novas instruções.',
      bestOptionId: null,
      finished: false,
      success: false,
    };
  }

  attention(): { load: 0 | 1 | 2; inputRequired: boolean; safeSilenceSeconds: number } {
    const radio = radioTraceLoad(this.state);
    const load: 0 | 1 | 2 =
      this.state.kil.mode === HUNT
        ? 2
        : this.state.kil.mode === INVESTIGATE
          ? Math.max(1, radio) as 1 | 2
          : radio;
    const safeSilenceSeconds = this.silenceWindow();
    return {
      load,
      inputRequired: safeSilenceSeconds <= 0.05,
      safeSilenceSeconds,
    };
  }

  peekBest(): string | null {
    this.refresh();
    if (!this.shown.length) return null;
    this.rescoreShown();
    return [...this.shown].sort((a, b) => b.score - a.score)[0]?.id ?? null;
  }

  choose(optionId: string | null): Resolution {
    this.refresh();
    const s = this.state;
    this.rescoreShown();

    const picked = this.shown.find((c) => c.id === optionId) ?? null;
    const best = [...this.shown].sort((a, b) => b.score - a.score)[0] ?? null;

    // Um evento pode encerrar um corredor entre keydown e commit. Um token de
    // outra decisão é rejeitado sem virar WAIT, sem rádio e sem punição.
    if (!picked || !best) {
      return {
        verdict: 'NEUTRAL',
        feedback: this.shown.length
          ? 'A ordem não pertence a esta bifurcação. Nada foi transmitido.'
          : 'Ela ainda está atravessando o corredor. Aguarde a próxima chamada.',
        bestOptionId: null,
        finished: false,
        success: false,
      };
    }

    // fotografia do estado ANTES da ordem: sem ela não dá para dizer o que
    // a jogada causou, só o que aconteceu
    const before = clone(s);
    const bestShort = best.label.split(' — ')[0]!;
    const bestWhy = effectOf(before, best);

    // No harness discreto a ordem executa a fatia inteira. No jogo conectado
    // a update(), ela vira intenção e os pulsos fazem os dois corpos andarem.
    const action: LabAction = picked.action;
    // Uma ordem pode parecer perigosa e ainda ser a única saída. A confiança
    // só quebra quando o jogador escolhe uma exposição evitável; penalizar a
    // melhor rota disponível fazia até o operador perfeito criar recusas.
    const avoidablyRisky = picked.id !== best.id && riskyCommand(before, picked);
    const repeated = this.liveActivated && sameActiveOrder(s, action);
    const voice = action.k !== 'LURE' && action.k !== 'LIGHT';
    if (this.liveActivated && voice && !s.radio.txOpen) {
      return {
        verdict: 'NEUTRAL',
        feedback: 'O transmissor está cortado. Ela não ouviu nada; pressione [0] para reabrir o TX.',
        bestOptionId: null,
        finished: false,
        success: false,
      };
    }
    if (repeated) {
      return {
        verdict: 'NEUTRAL',
        feedback:
          action.k === 'MOVE'
            ? 'Ela já está seguindo essa direção. Não precisa repetir: a ordem continua automática.'
            : action.k === 'WAIT'
              ? 'Ela já está parada. O caçador, não.'
              : 'Ela já está indo para esse esconderijo.',
        bestOptionId: this.difficulty < 0 ? best.id : null,
        finished: false,
        success: false,
      };
    }

    if (this.liveActivated) {
      const hunterModeBefore = s.kil.mode;
      this.interventionNeeded = false;
      issueCommand(s, action, avoidablyRisky);
      if (voice) emitRadioTrace(s);

      // Uma nova ordem física tem resposta tátil imediata. Repetir a mesma
      // ordem não acelera a simulação; ela já continuará no relógio próprio.
      const acceptedPhysicalOrder =
        s.sur.pending === null &&
        ((action.k === 'MOVE' && s.sur.intent.k === 'MOVE' &&
          action.dx === s.sur.intent.dx && action.dy === s.sur.intent.dy) ||
          (action.k === 'HIDE' && s.sur.intent.k === 'HIDE' &&
            action.x === s.sur.intent.x && action.y === s.sur.intent.y));
      if (action.k === 'MOVE' || action.k === 'HIDE') this.survivorClock = 0;
      if (acceptedPhysicalOrder) {
        const pathBefore = remainingPath(s);
        const hadKey = s.sur.key;
        advanceSurvivorTick(s, true);
        this.pendingBeltGain += this.creditSurvivorProgress(pathBefore, hadKey);
      }
      if (hunterModeBefore !== HUNT && s.kil.mode === HUNT) this.interventionNeeded = true;
    } else {
      step(s, action);
    }
    this.invalidateDeck();

    const events = s.events.join(' ');

    if (!s.sur.alive) {
      return this.fatalResolution(this.difficulty < 0 ? best.id : null);
    }

    if (s.sur.out) {
      return this.successResolution(this.difficulty < 0 ? best.id : null);
    }

    if (s.turn > s.maxTurns) {
      return this.timeoutResolution(this.difficulty < 0 ? best.id : null);
    }

    const gap = best.score - picked.score;
    let verdict: Resolution['verdict'] = 'NEUTRAL';
    if (gap <= 10) verdict = 'GOOD';
    else if (gap > 70) verdict = 'BAD';

    // Toda resposta explica a si mesma. Um jogo em que você acerta sem saber
    // por quê não ensina nada — e o próximo turno vira chute de novo.
    const head = events ? `${events} ` : '';
    const revealSolution = this.difficulty < 0 || !this.liveActivated;
    const feedback = this.liveActivated && !revealSolution
      ? verdict === 'GOOD'
        ? `${head}Ordem confirmada. Ela atravessa o corredor sem esperar outra instrução.`
        : verdict === 'NEUTRAL'
          ? `${head}Ela ouviu. Observe o corredor antes de falar novamente.`
          : `${head}${faultOf(before, picked)}. Ela está começando a duvidar da sua voz.`
      : verdict === 'GOOD'
        ? `${head}CERTO: ${effectOf(before, picked)}.`
        : verdict === 'NEUTRAL'
          ? `${head}Serviu, mas ${effectOf(before, picked)}. Melhor: “${bestShort}” — ${bestWhy}.`
          : `${head}ERRO: ${faultOf(before, picked)}. Era “${bestShort}” — ${bestWhy}.`;

    return {
      verdict,
      feedback,
      bestOptionId: revealSolution ? best.id : null,
      finished: false,
      success: false,
    };
  }
}

export const labyrinthKind: MissionKind = {
  id: 'labirinto',
  name: 'O LABIRINTO',
  create: (seed, difficulty) => new LabyrinthMission(seed, difficulty),
};
