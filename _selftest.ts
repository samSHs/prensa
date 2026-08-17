import { labyrinthKind } from './src/missions/labyrinth/mission';
import { valveKind } from './src/missions/valves';
import { wireKind } from './src/missions/wires';
import { interferenceKind } from './src/missions/interference';
import { Rng } from './src/core/rng';
import { Belt } from './src/game/belt';
import { TensionDirector } from './src/game/director';
import { ATTENTION_KEYSET, lockKeyCount, lockWindow, makeLockSpec } from './src/game/interrupts';
import { MissionDeck } from './src/missions/registry';
import type { Mission } from './src/missions/types';
import {
  HUNT,
  INVESTIGATE,
  advanceRadioTrace,
  emitRadioTrace,
  generate,
  radioTraceLoad,
  setRadioTx,
} from './src/missions/labyrinth/sim';

type Policy = 'perfect' | 'random';

interface Run {
  success: boolean;
  nodes: number;
  goods: number;
  bads: number;
  fatal: boolean;
  oracleViolation: boolean;
}

function play(m: Mission, policy: Policy, rng: Rng): Run {
  let goods = 0;
  let bads = 0;
  let fatal = false;

  for (let nodes = 1; nodes <= 80; nodes++) {
    const n = m.node();
    if (!n.options.length) {
      return { success: false, nodes, goods, bads, fatal, oracleViolation: policy === 'perfect' };
    }

    let pick: string;
    if (policy === 'random') {
      pick = n.options[rng.int(n.options.length)]!.id;
    } else {
      const best = m.peekBest();
      if (best === null || !n.options.some((o) => o.id === best)) {
        return { success: false, nodes, goods, bads, fatal, oracleViolation: true };
      }
      pick = best;
    }

    const r = m.choose(pick);
    if (r.verdict === 'GOOD') goods++;
    if (r.verdict === 'BAD') bads++;
    if (r.verdict === 'FATAL') {
      bads++;
      fatal = true;
    }
    if (r.finished) {
      return { success: r.success, nodes, goods, bads, fatal, oracleViolation: false };
    }
  }
  return { success: false, nodes: 80, goods, bads, fatal, oracleViolation: policy === 'perfect' };
}

function row(label: string, runs: Run[]): number {
  const win = runs.filter((r) => r.success).length;
  const nodes = runs.reduce((a, r) => a + r.nodes, 0) / runs.length;
  const acc = runs.reduce((a, r) => a + r.goods / Math.max(1, r.goods + r.bads), 0) / runs.length;
  const pct = (win / runs.length) * 100;
  console.log(
    `    ${label.padEnd(22)} vitória ${pct.toFixed(0).padStart(3)}%   ` +
      `turnos ${nodes.toFixed(1).padStart(4)}   acertos ${(acc * 100).toFixed(0).padStart(3)}%   ` +
      `fatais ${runs.filter((r) => r.fatal).length}   oráculo inválido ${
        runs.filter((r) => r.oracleViolation).length
      }`,
  );
  return pct;
}

const SAMPLES = Number(process.env.SAMPLES ?? 60);
const ONLY = process.argv[2] ?? '';
let failures = 0;

function suite(
  name: string,
  create: (seed: number, d: number) => Mission,
  diffs: number[],
  minPerfectAt: (d: number) => number,
  maxRandomAt: (d: number) => number,
): void {
  if (ONLY && !name.includes(ONLY)) return;
  console.log(`\n=== ${name} ===`);
  for (const d of diffs) {
    const minPerfect = minPerfectAt(d);
    const maxRandom = maxRandomAt(d);
    console.log(`  dificuldade ${d.toFixed(1)}`);
    const perfect: Run[] = [];
    const random: Run[] = [];
    for (let s = 0; s < SAMPLES; s++) {
      const policySeed = ((1000 + s) * 2654435761) ^ Math.round(d * 1000);
      perfect.push(play(create(1000 + s, d), 'perfect', new Rng(policySeed)));
      random.push(play(create(1000 + s, d), 'random', new Rng(policySeed)));
    }
    const p = row('operador perfeito', perfect);
    const r = row('escolhas aleatórias', random);

    if (p < minPerfect) {
      console.log(`    !! jogo perfeito deveria vencer >= ${minPerfect}%`);
      failures++;
    }
    if (perfect.some((run) => run.oracleViolation)) {
      console.log('    !! peekBest precisa devolver uma opção válida em cada nó');
      failures++;
    }
    if (r > maxRandom) {
      console.log(`    !! aleatório deveria vencer <= ${maxRandom}% (senão as opções não importam)`);
      failures++;
    }
  }
}

function wireContractChecks(): void {
  if (ONLY && !'CODIGO MORTO'.includes(ONLY)) return;
  console.log('\n=== CONTRATO DOS FIOS ===');
  let localFailures = 0;

  for (const [difficulty, expectedWires] of [
    [0, 5],
    [0.89, 5],
    [0.9, 6],
    [1.65, 6],
  ] as const) {
    for (let seed = 2000; seed < 2020; seed++) {
      // Montar a fila não corta nem valida fios. Até uma escolha sabidamente
      // errada precisa ser aceita como programação neutra.
      const assembly = wireKind.create(seed, difficulty);
      const first = assembly.node();
      if (first.options.length !== expectedWires) localFailures++;

      const best = assembly.peekBest();
      const wrong = first.options.find((option) => option.id.startsWith('WIRE:') && option.id !== best);
      if (!wrong) {
        localFailures++;
        continue;
      }

      const queued = assembly.choose(wrong.id);
      const afterQueued = assembly.node();
      if (
        queued.finished ||
        queued.verdict !== 'NEUTRAL' ||
        afterQueued.options.length !== expectedWires ||
        !afterQueued.options.some((option) => option.id === 'UNDO') ||
        !afterQueued.nodeLabel.includes(`1/${expectedWires}`) ||
        afterQueued.bodyHtml.includes('CORTADO')
      ) {
        localFailures++;
      }

      // O oráculo deve montar todos os slots sem encerrar a missão. Somente
      // EXECUTE transforma a programação correta em um resultado final.
      const perfect = wireKind.create(seed, difficulty);
      let assemblyOk = true;
      for (let slot = 0; slot < expectedWires; slot++) {
        const pick = perfect.peekBest();
        const node = perfect.node();
        if (!pick?.startsWith('WIRE:') || !node.options.some((option) => option.id === pick)) {
          assemblyOk = false;
          break;
        }
        const queuedCorrect = perfect.choose(pick);
        if (queuedCorrect.finished || queuedCorrect.verdict !== 'NEUTRAL') {
          assemblyOk = false;
          break;
        }
      }
      const executeId = perfect.peekBest();
      const completeNode = perfect.node();
      const executed = executeId === 'EXECUTE' ? perfect.choose(executeId) : null;
      if (
        !assemblyOk ||
        executeId !== 'EXECUTE' ||
        !completeNode.options.some((option) => option.id === 'EXECUTE') ||
        !executed?.finished ||
        !executed.success ||
        executed.verdict !== 'GOOD'
      ) {
        localFailures++;
      }

      // Uma fila errada só é julgada quando EXECUTE é enviado. Ela deve ser
      // apagada, acumular carga e explicar conflitos sem destacar a resposta.
      const fatalMission = wireKind.create(seed, difficulty);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const opening = fatalMission.node();
        const oracle = fatalMission.peekBest();
        const firstWrong = opening.options.find(
          (option) => option.id.startsWith('WIRE:') && option.id !== oracle,
        );
        if (!firstWrong) {
          localFailures++;
          break;
        }
        fatalMission.choose(firstWrong.id);

        while (true) {
          const available = fatalMission.node().options.find((option) => option.id.startsWith('WIRE:'));
          if (!available) break;
          const programmed = fatalMission.choose(available.id);
          if (programmed.finished) {
            localFailures++;
            break;
          }
        }

        const rejected = fatalMission.choose('EXECUTE');
        const lowerFeedback = rejected.feedback.toLocaleLowerCase('pt-BR');
        const answerLeak =
          lowerFeedback.includes('era o ') ||
          lowerFeedback.includes('resposta correta') ||
          (rejected.bestOptionId !== null &&
            fatalMission.node().options.some((option) => option.id === rejected.bestOptionId));

        if (attempt < 3) {
          const reset = fatalMission.node();
          if (
            rejected.finished ||
            rejected.verdict !== 'BAD' ||
            answerLeak ||
            !reset.nodeLabel.includes(`0/${expectedWires}`) ||
            !reset.bodyHtml.includes(`${attempt}/3`)
          ) {
            localFailures++;
          }
        } else if (
          !rejected.finished ||
          rejected.success ||
          rejected.verdict !== 'FATAL' ||
          answerLeak
        ) {
          localFailures++;
        }
      }
    }
  }

  console.log(
    localFailures === 0
      ? '    OK — tiers 5/6, fila opaca, execução integral e terceira carga fatal'
      : `    !! ${localFailures} quebra(s) no contrato de carga`,
  );
  if (localFailures > 0) failures++;
}

function valvePresentationChecks(): void {
  if (ONLY && !'PURGA'.includes(ONLY)) return;
  console.log('\n=== CONTRATO VISUAL DA PURGA ===');
  let localFailures = 0;
  const oracleWords = /\[(?:AVANÇA|AFASTA|ROMPE)\]|PASSOS SEGUROS/i;
  const futurePressure = /PRENSA\s+\d+(?:[.,]\d+)?\s*(?:→|->)/i;

  for (const difficulty of [-1, 0.85]) {
    for (let seed = 2600; seed < 2640; seed++) {
      const mission = valveKind.create(seed, difficulty);
      let completed = false;
      for (let turn = 0; turn < 10; turn++) {
        const node = mission.node();
        const labels = node.options.map((option) => option.label);
        if (
          labels.length < 3 ||
          new Set(node.options.map((option) => option.id)).size !== node.options.length ||
          labels.some((label) => oracleWords.test(label) || futurePressure.test(label))
        ) {
          localFailures++;
          break;
        }
        const best = mission.peekBest();
        if (!best || !node.options.some((option) => option.id === best)) {
          localFailures++;
          break;
        }
        const resolution = mission.choose(best);
        if (resolution.bestOptionId !== null) localFailures++;
        if (resolution.finished) {
          if (!resolution.success) localFailures++;
          completed = true;
          break;
        }
      }
      if (!completed) localFailures++;
    }
  }

  console.log(
    localFailures === 0
      ? '    OK — alternativas sem previsão, sem rótulo-resposta e rota perfeita preservada'
      : `    !! ${localFailures} quebra(s) de apresentação/solução`,
  );
  if (localFailures > 0) failures++;
}

function interferenceContractChecks(): void {
  if (ONLY && !'INTERFERENCIAS'.includes(ONLY)) return;
  console.log('\n=== CONTRATO DAS INTERFERÊNCIAS ===');
  let localFailures = 0;

  for (const [intensity, count, window] of [
    [0, 2, 2.2],
    [0.35, 3, 2.6],
    [0.7, 4, 3],
  ] as const) {
    if (lockKeyCount(intensity) !== count || lockWindow(count) !== window) localFailures++;
    const a = makeLockSpec(new Rng(4100), intensity);
    const b = makeLockSpec(new Rng(4100), intensity);
    if (
      a.sequence.length !== count ||
      new Set(a.sequence).size !== count ||
      a.sequence.some((key) => !ATTENTION_KEYSET.includes(key as (typeof ATTENTION_KEYSET)[number])) ||
      JSON.stringify(a) !== JSON.stringify(b)
    ) {
      localFailures++;
    }
  }

  for (const [difficulty, expected] of [[0, 2], [0.8, 3], [1.6, 4]] as const) {
    const mission = interferenceKind.create(4200, difficulty);
    const shown = [...mission.node().bodyHtml.matchAll(/\[ ([A-Z]) \]/g)].length;
    if (shown !== expected) localFailures++;
  }

  // Percorre a sala exatamente pelas pistas visíveis. Isso prova que ela não
  // termina depois de uma tecla e que agir/parar precisam ser alternados.
  for (let seed = 4300; seed < 4320; seed++) {
    const mission = interferenceKind.create(seed, -1);
    const openingKeys = [...mission.node().bodyHtml.matchAll(/\[ ([A-Z]) \]/g)].map((match) => match[1]!);
    if (openingKeys.length !== 2) {
      localFailures++;
      continue;
    }
    const wrong = ATTENTION_KEYSET.find((key) => key !== openingKeys[0])!;
    const rejected = mission.shortcut?.(wrong);
    if (rejected?.verdict !== 'BAD' || rejected.finished) localFailures++;

    let finished = false;
    let locks = 0;
    let inspections = 0;
    for (let guard = 0; guard < 40 && !finished; guard++) {
      const node = mission.node();
      let resolution;
      if (node.bodyHtml.includes('TRAVA DE SEGURANÇA')) {
        locks++;
        const keys = [...node.bodyHtml.matchAll(/\[ ([A-Z]) \]/g)].map((match) => match[1]!);
        if (keys.length < 2) {
          localFailures++;
          break;
        }
        for (const key of keys) {
          resolution = mission.shortcut?.(key) ?? undefined;
          if (resolution?.finished) break;
        }
      } else if (node.bodyHtml.includes('ROTINA')) {
        const key = node.prompt.match(/Pressione\s+([1-4])/i)?.[1];
        if (!key) {
          localFailures++;
          break;
        }
        resolution = mission.shortcut?.(key) ?? undefined;
      } else if (node.bodyHtml.includes('PASSOS SE APROXIMANDO')) {
        inspections++;
        resolution = mission.update?.(node.timeLimit + 0.01)?.resolution;
      } else if (node.bodyHtml.includes('LUZ BRANCA')) {
        resolution = mission.update?.(node.timeLimit + 0.01)?.resolution;
      } else if (node.bodyHtml.includes('LUZ ESTÁ RECUANDO')) {
        resolution = mission.update?.(node.timeLimit + 0.01)?.resolution;
      } else {
        localFailures++;
        break;
      }
      if (resolution?.finished) {
        finished = resolution.success;
        if (!resolution.success) localFailures++;
      }
    }
    if (!finished || locks < 2 || inspections < 2) localFailures++;
  }

  console.log(
    localFailures === 0
      ? '    OK — 2/3/4 teclas, isca de imobilidade e prova mista completas'
      : `    !! ${localFailures} quebra(s) no sequestro de atenção`,
  );
  if (localFailures > 0) failures++;
}

function campaignSystemsChecks(): void {
  if (ONLY && !'CAMPANHA'.includes(ONLY)) return;
  console.log('\n=== DIRETOR + TRANSMISSÕES ===');
  let localFailures = 0;

  const deck = new MissionDeck(0x1234567);
  const expectedPairs = [
    new Set(['labirinto', 'purga']),
    new Set(['labirinto', 'codigo']),
    new Set(['purga', 'codigo']),
  ];
  for (let index = 0; index < 9; index++) {
    const offered = deck.offer(index * 0.2);
    const repeated = deck.offer(99);
    if (offered[0].kindId === offered[1].kindId) localFailures++;
    if (offered[0].token !== repeated[0].token || offered[1].token !== repeated[1].token) localFailures++;
    const expected = expectedPairs[index % expectedPairs.length]!;
    if (!expected.has(offered[0].kindId) || !expected.has(offered[1].kindId)) localFailures++;
    const picked = offered[index % 2]!;
    const mission = deck.accept(picked.token, index * 0.2);
    if (mission.id !== picked.kindId) localFailures++;
  }
  const sacrificeDeck = new MissionDeck(91);
  const sacrificed = sacrificeDeck.offer(0);
  sacrificeDeck.discard();
  const afterSacrifice = sacrificeDeck.offer(0.1);
  if (sacrificed[0].token === afterSacrifice[0].token) localFailures++;

  const director = new TensionDirector(0x51a7);
  const context = {
    missionsDone: 0,
    keys: 0,
    difficulty: 0,
    elapsed: 0,
    danger: 0.2,
    running: true,
    interruptActive: false,
    attentionLoad: 0,
    inputRequired: false,
    safeSilenceSeconds: 99,
    decisionFraction: 1,
    untilImpact: 10,
    voiceBusy: false,
  };
  let events: Array<'LOCK' | 'INSPECTION'> = [];
  for (let i = 0; i < 1200; i++) {
    context.elapsed += 0.05;
    const decision = director.update(0.05, context);
    if (decision.event) events.push(decision.event);
  }
  if (events.length !== 0) localFailures++;

  director.missionFinished(true);
  context.missionsDone = 1;
  context.keys = 1;
  context.difficulty = 0.35;
  for (let i = 0; i < 3000 && events.length < 1; i++) {
    context.elapsed += 0.05;
    const decision = director.update(0.05, context);
    if (decision.event) {
      events.push(decision.event);
      director.interruptFinished(decision.event, true);
    }
  }
  if (events[0] !== 'LOCK') localFailures++;

  context.missionsDone = 3;
  context.keys = 3;
  context.difficulty = 1.2;
  for (let i = 0; i < 12000; i++) {
    context.elapsed += 0.05;
    const decision = director.update(0.05, context);
    if (decision.event) {
      events.push(decision.event);
      director.interruptFinished(decision.event, true);
    }
  }
  if (events.filter((event) => event === 'INSPECTION').length > 2) localFailures++;

  const dangerDirector = new TensionDirector(77);
  dangerDirector.missionFinished(true);
  let dangerEvents = 0;
  for (let i = 0; i < 3000; i++) {
    const decision = dangerDirector.update(0.05, {
      ...context,
      elapsed: i * 0.05,
      missionsDone: 2,
      danger: 0.9,
    });
    if (decision.event) dangerEvents++;
  }
  if (dangerEvents !== 0) localFailures++;

  console.log(
    localFailures === 0
      ? `    OK — pares fixos, abertura protegida, primeiro evento TRAVA, inspeções ${events.filter((e) => e === 'INSPECTION').length}/2`
      : `    !! ${localFailures} quebra(s) nos sistemas de campanha`,
  );
  if (localFailures > 0) failures++;
}

function radioContractChecks(): void {
  if (ONLY && !'RADIO'.includes(ONLY)) return;
  console.log('\n=== CONTRATO DO RÁDIO ===');
  let localFailures = 0;
  const state = generate(424242, 0);

  if (emitRadioTrace(state) !== 'SAMPLED' || radioTraceLoad(state) !== 1) localFailures++;
  if (state.kil.mode === INVESTIGATE || state.kil.mode === HUNT) localFailures++;
  if (emitRadioTrace(state) !== 'GROUPED' || radioTraceLoad(state) !== 1) localFailures++;

  advanceRadioTrace(state, 0.91);
  if (emitRadioTrace(state) !== 'TRIANGULATED' || radioTraceLoad(state) !== 2) localFailures++;
  if (state.kil.mode !== INVESTIGATE || state.kil.mode === HUNT) localFailures++;

  setRadioTx(state, false);
  if (emitRadioTrace(state) !== 'BLOCKED') localFailures++;
  advanceRadioTrace(state, 1.9);
  if (radioTraceLoad(state) !== 2) localFailures++;
  advanceRadioTrace(state, 0.11);
  if (radioTraceLoad(state) !== 0 || state.kil.mode === HUNT) localFailures++;

  console.log(
    localFailures === 0
      ? '    OK — burst agrupado, duas amostras investigam sem HUNT, TX limpa em 2 s'
      : `    !! ${localFailures} quebra(s) no contrato espacial`,
  );
  if (localFailures > 0) failures++;
}

/**
 * Regressão do bug observado no playtest: a lista era reconstruída a cada
 * pulso e o mesmo número passava a significar outra ordem sob o cursor.
 */
function labyrinthInputContractChecks(): void {
  if (ONLY && !'LABIRINTO'.includes(ONLY)) return;
  console.log('\n=== CONTRATO DE INPUT DO LABIRINTO ===');
  let localFailures = 0;
  const mission = labyrinthKind.create(7331, 0.55);
  const signature = () =>
    mission.node().options.map((option) => `${option.id}\u0000${option.label}`).join('\u0001');

  const initial = mission.node();
  const initialSignature = signature();
  const ids = initial.options.map((option) => option.id);
  if (!ids.length || new Set(ids).size !== ids.length) localFailures++;
  if (ids.some((id) => /^c\d+$/.test(id) || !id.includes(':'))) localFailures++;

  // Ativar a física não pode mais trocar a mão apresentada antes do primeiro
  // frame. Depois deixamos inclusive um passo do caçador acontecer.
  mission.update?.(0);
  if (signature() !== initialSignature) localFailures++;
  for (let elapsed = 0; elapsed < 0.95; elapsed += 0.05) {
    const update = mission.update?.(0.05);
    if (update?.resolution) {
      localFailures++;
      break;
    }
    if (signature() !== initialSignature) localFailures++;
  }

  // O token capturado antes do atraso humano precisa executar aquela mesma
  // ordem; a campanha também não deve imprimir a solução/oráculo na resposta.
  const delayedId = initial.options[0]!.id;
  const delayed = mission.choose(delayedId);
  if (/não pertence a esta bifurcação/i.test(delayed.feedback)) localFailures++;
  if (delayed.bestOptionId !== null) localFailures++;
  if (/rota mais segura|\bera[ :“"]|melhor:/i.test(delayed.feedback)) localFailures++;

  const wasd = labyrinthKind.create(9917, 0.55);
  wasd.update?.(0);
  const keyForId: Record<string, string> = {
    'MOVE:NORTE': 'w',
    'MOVE:LESTE': 'd',
    'MOVE:SUL': 's',
    'MOVE:OESTE': 'a',
  };
  const direction = wasd.node().options.find((option) => keyForId[option.id]);
  const keyResult = direction ? wasd.shortcut?.(keyForId[direction.id]!) : null;
  if (!direction || !keyResult || /parede|não pertence/i.test(keyResult.feedback)) localFailures++;

  console.log(
    localFailures === 0
      ? '    OK — snapshot estável, IDs semânticos, atraso humano e WASD fixo'
      : `    !! ${localFailures} quebra(s) no contrato de comandos`,
  );
  if (localFailures > 0) failures++;
}

/**
 * O teste antigo parava na missão e não enxergava o bug principal do jogo:
 * a física podia matar ou deixar escapar antes do objetivo terminar. Este
 * perfil joga o primeiro labirinto vivo com o oráculo, aplica apenas créditos
 * de progresso real e mantém a esteira completa rodando.
 */
function liveLabBeltChecks(): void {
  if (ONLY && !'LABIRINTO'.includes(ONLY)) return;
  console.log('\n=== LABIRINTO VIVO + ESTEIRA ===');

  const runs = 40;
  let rescued = 0;
  let playerAlive = 0;
  let totalSeconds = 0;

  for (let seed = 3000; seed < 3000 + runs; seed++) {
    const mission = labyrinthKind.create(seed, 0);
    let missionSuccess = false;
    let txCut = false;
    let txCutFor = 0;
    const belt = new Belt(
      {
        onImpact: () => {},
        onDeath: () => {},
        onEscape: () => {},
        onHatchBlocked: () => {},
      },
      { start: 11, hatch: 26, base: 0.24 },
    );

    mission.update?.(0); // ativa intenção persistente antes da primeira ordem
    const first = mission.peekBest();
    if (first) mission.choose(first);

    let seconds = 0;
    for (; seconds < 240 && !belt.dead; seconds += 0.05) {
      const update = mission.update?.(0.05);
      if (update?.beltGain) belt.gain(update.beltGain);
      belt.update(0.05);

      // Política especialista do novo rádio: uma amostra não é perigo mágico,
      // é o aviso para procurar uma janela segura de dois segundos. O harness
      // precisa testar a mecânica, não fingir que [0] não existe.
      if (txCut) {
        txCutFor += 0.05;
        if (txCutFor >= 2.05) {
          mission.shortcut?.('0');
          txCut = false;
          txCutFor = 0;
        }
      } else {
        const attention = mission.attention?.();
        if (attention?.load === 1 && attention.safeSilenceSeconds >= 0.55) {
          mission.shortcut?.('0');
          txCut = true;
          txCutFor = 0;
        }
      }

      if (update?.resolution) {
        missionSuccess = update.resolution.success;
        break;
      }
      if (update?.changed) {
        const best = mission.peekBest();
        if (best) mission.choose(best);
      }
    }

    if (missionSuccess) rescued++;
    if (!belt.dead) playerAlive++;
    totalSeconds += seconds;
  }

  const rescuePct = (rescued / runs) * 100;
  const alivePct = (playerAlive / runs) * 100;
  const meanSeconds = totalSeconds / runs;
  console.log(
    `    resgate ${rescuePct.toFixed(0)}%   jogador vivo ${alivePct.toFixed(0)}%   ` +
      `duração média ${meanSeconds.toFixed(1)}s`,
  );

  // O corredor agora é executado em tempo real: abaixo de 25 s vira ruído e
  // acima de 42 s volta ao problema de esperar/repetir a mesma direção.
  if (rescuePct < 40 || alivePct < 75 || meanSeconds < 25 || meanSeconds > 42) {
    console.log('    !! início deve durar 25–42 s, ser sobrevivível e ter rota especialista consistente');
    failures++;
  }

  let blockedHits = 0;
  let escaped = false;
  const gate = new Belt(
    {
      onImpact: () => {},
      onDeath: () => {},
      onEscape: () => {
        escaped = true;
      },
      onHatchBlocked: () => {
        blockedHits++;
      },
    },
    { start: 11, hatch: 26, base: 0.24 },
  );
  gate.distance = 26.4;
  gate.update(0.05);
  const blocked = !escaped && gate.distance < 26 && blockedHits === 1;
  gate.unlockExit();
  gate.distance = 26.4;
  gate.update(0.05);
  console.log(`    escotilha: bloqueada sem chave ${blocked ? 'OK' : 'FALHA'} · destrancada ${escaped ? 'OK' : 'FALHA'}`);
  if (!blocked || !escaped) failures++;
}

const t0 = Date.now();
// Intenção de design: no começo, jogo perfeito quase sempre salva a refém.
// Lá em cima a cobertura de câmeras despenca e o caçador fica mais rápido —
// aí nem o jogo perfeito garante, e isso é proposital.
suite(
  'LABIRINTO',
  (s, d) => labyrinthKind.create(s, d),
  [0, 0.6, 1.2, 1.8],
  (d) => (d >= 1.5 ? 50 : d >= 1.0 ? 60 : 75),
  () => 35,
);
suite('PURGA', (s, d) => valveKind.create(s, d), [0, 0.8, 1.6], () => 100, () => 40);
valvePresentationChecks();
suite(
  'CODIGO MORTO',
  (s, d) => wireKind.create(s, d),
  [0, 1.05, 1.65, 2.2],
  () => 100,
  (d) => (d < 1.05 ? 35 : 20),
);
wireContractChecks();
interferenceContractChecks();
campaignSystemsChecks();
radioContractChecks();
labyrinthInputContractChecks();
liveLabBeltChecks();

console.log(`\n${failures === 0 ? 'OK' : `${failures} FALHA(S)`}  —  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
process.exit(failures === 0 ? 0 : 1);
