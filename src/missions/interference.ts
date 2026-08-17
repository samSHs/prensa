import { Rng, clamp } from '../core/rng';
import {
  lockKeyCount,
  makeLockSpec,
  type LockKeyCount,
} from '../game/interrupts';
import type { Mission, MissionKind, MissionNode, MissionUpdate, Resolution } from './types';

type Stage =
  | 'LOCK'
  | 'INSPECTION_TASK'
  | 'INSPECTION_APPROACH'
  | 'INSPECTION_WATCH'
  | 'INSPECTION_CLEAR'
  | 'MIX_TASK'
  | 'MIX_LOCK'
  | 'MIX_APPROACH'
  | 'MIX_WATCH'
  | 'MIX_CLEAR'
  | 'DONE';

type MixedEvent = 'LOCK' | 'INSPECTION';

const APPROACH_TIME = 1.4;
const WATCH_TIME = 2.6;
const CLEAR_TIME = 0.5;
const TASK_KEYS = ['1', '2', '3', '4'] as const;
const BAIT_KEYS = ['R', 'E', 'Q', 'F', '2', 'A'] as const;

/**
 * Exercício usado somente pela sala de treinamento. A campanha usa o
 * controlador global real; aqui os mesmos geradores de trava são organizados
 * em três checkpoints para treinar a mudança agir -> parar -> agir.
 */
class InterferenceTraining implements Mission {
  readonly id = 'interferencia';
  readonly name = 'INTERFERÊNCIAS';
  readonly live = true;
  readonly brief = '';
  readonly howTo = [
    '<span class="hl">DUAS AMEAÇAS TOMAM O CONTROLE DA ENTRADA.</span>',
    '',
    '  <span class="key">TRAVA</span>       digite toda a sequência vermelha na ordem exata.',
    '               Ela começa com duas teclas e cresce para três ou quatro.',
    '               Qualquer entrada errada — inclusive número ou clique — reinicia a trava.',
    '',
    '  <span class="key">INSPEÇÃO</span>    primeiro vêm os passos e o aviso de aproximação.',
    '               Quando a cabine ficar branca: <span class="hl">NÃO TOQUE EM NADA</span>.',
    '               O painel pode mandar apertar uma tecla. É uma isca.',
    '',
    '  <span class="key">PROVA MISTA</span> continue a rotina até uma interferência tomar o painel.',
    '               Trava significa agir; luz branca significa parar.',
    '',
    '<span class="ghost">Na campanha não haverá explicação. Cor, som e movimento são o aviso.</span>',
  ].join('\n');

  private rng: Rng;
  private intensity: number;
  private baseCount: LockKeyCount;
  private stage: Stage = 'LOCK';
  private sequence: string[] = [];
  private sequenceAt = 0;
  private left = 0;
  private total = 1;
  private taskKey = '1';
  private mixedOrder: readonly MixedEvent[];
  private mixedCompleted = 0;
  private ended = false;
  private readonly guided: boolean;
  private readonly approachTime: number;
  private readonly watchTime: number;
  private lastBaitTick = -1;

  constructor(seed: number, difficulty: number) {
    this.rng = new Rng((seed ^ 0x1f3e7a) >>> 0);

    // A demonstração usa duas teclas e sinais mais longos; a simulação real
    // do treinamento recebe difficulty normal e começa com três. Nenhuma das
    // duas volta ao antigo evento de uma tecla só.
    this.guided = difficulty < 0;
    this.intensity = this.guided ? 0 : clamp(difficulty / 1.6, 0, 1);
    this.approachTime = this.guided ? 1.9 : APPROACH_TIME;
    this.watchTime = this.guided ? 3.4 : WATCH_TIME;
    this.baseCount = lockKeyCount(this.intensity);
    this.mixedOrder = this.rng.chance(0.5)
      ? (['LOCK', 'INSPECTION'] as const)
      : (['INSPECTION', 'LOCK'] as const);
    this.taskKey = this.nextTaskKey();
    this.beginLock(false);
  }

  node(): MissionNode {
    if (this.stage === 'LOCK' || this.stage === 'MIX_LOCK') return this.lockNode();
    if (this.stage === 'INSPECTION_TASK' || this.stage === 'MIX_TASK') return this.taskNode();
    if (
      this.stage === 'INSPECTION_APPROACH' ||
      this.stage === 'INSPECTION_WATCH' ||
      this.stage === 'INSPECTION_CLEAR' ||
      this.stage === 'MIX_APPROACH' ||
      this.stage === 'MIX_WATCH' ||
      this.stage === 'MIX_CLEAR'
    ) {
      return this.inspectionNode();
    }

    return {
      nodeLabel: 'PROVA 3/3',
      bodyHtml: '<span class="ok">CALIBRAÇÃO CONCLUÍDA</span>',
      prompt: 'O painel está liberado.',
      options: [],
      timeLimit: 1,
      attentionCue: 'routine',
    };
  }

  choose(): Resolution {
    return this.result(
      'BAD',
      'A prática usa a entrada direta do teclado, não alternativas numeradas.',
    );
  }

  shortcut(raw: string): Resolution | null {
    if (this.ended || this.stage === 'DONE') return null;
    const key = raw.toUpperCase();

    if (this.stage === 'LOCK' || this.stage === 'MIX_LOCK') {
      return this.enterLockKey(key, raw);
    }

    if (this.stage === 'INSPECTION_TASK' || this.stage === 'MIX_TASK') {
      return this.enterTaskKey(key, raw);
    }

    if (this.isApproach()) {
      // A aproximação é a última janela em que concluir uma ação é seguro.
      return null;
    }

    if (this.isWatching()) {
      const mixed = this.isMixed();
      if (mixed) {
        this.stage = 'MIX_TASK';
        this.taskKey = this.nextTaskKey();
      } else {
        this.stage = 'INSPECTION_TASK';
        this.taskKey = this.nextTaskKey();
      }
      return this.result(
        'BAD',
        `Movimento detectado: “${raw || 'clique'}”. A etapa foi reiniciada; durante a luz branca até uma resposta certa é errada.`,
      );
    }

    // CLEAR segura a entrada até o clarão desaparecer, mas não pune.
    return null;
  }

  update(dt: number): MissionUpdate | null {
    if (this.ended || this.stage === 'DONE' || !this.isTimed()) return null;
    const stageBefore = this.stage;

    // Carregar o excedente mantém as fases corretas também em testes, abas
    // retomadas e quadros longos. O loop abaixo limita qualquer cascata.
    this.left -= Math.max(0, dt);
    for (let guard = 0; guard < 5 && this.left <= 0; guard++) {
      const overshoot = -this.left;

      if (this.stage === 'LOCK' || this.stage === 'MIX_LOCK') {
        const mixed = this.stage === 'MIX_LOCK';
        this.beginLock(mixed);
        return {
          changed: true,
          resolution: this.result(
            'BAD',
            'A trava expirou. A mesma etapa recomeçou com uma nova sequência.',
          ),
        };
      }

      if (this.stage === 'INSPECTION_APPROACH') {
        this.setTimedStage('INSPECTION_WATCH', this.watchTime, overshoot);
        continue;
      }
      if (this.stage === 'MIX_APPROACH') {
        this.setTimedStage('MIX_WATCH', this.watchTime, overshoot);
        continue;
      }
      if (this.stage === 'INSPECTION_WATCH') {
        this.setTimedStage('INSPECTION_CLEAR', CLEAR_TIME, overshoot);
        continue;
      }
      if (this.stage === 'MIX_WATCH') {
        this.setTimedStage('MIX_CLEAR', CLEAR_TIME, overshoot);
        continue;
      }
      if (this.stage === 'INSPECTION_CLEAR') {
        this.stage = 'MIX_TASK';
        this.taskKey = this.nextTaskKey();
        return {
          changed: true,
          resolution: this.result(
            'GOOD',
            'Imobilidade confirmada. Agora combine as duas regras sem aviso textual.',
          ),
        };
      }
      if (this.stage === 'MIX_CLEAR') {
        this.completeMixedEvent();
        return {
          changed: true,
          resolution: this.result(
            'GOOD',
            'Inspeção superada. A rotina voltou ao painel.',
          ),
        };
      }
    }

    const baitTick = this.isWatching()
      ? Math.floor(Math.max(0, this.total - this.left) / 0.42)
      : -1;
    const changed = this.stage !== stageBefore || baitTick !== this.lastBaitTick;
    this.lastBaitTick = baitTick;
    return changed ? { changed: true } : null;
  }

  peekBest(): string | null {
    return null;
  }

  private lockNode(): MissionNode {
    const mixed = this.stage === 'MIX_LOCK';
    const rendered = this.sequence
      .map((key, index) =>
        index < this.sequenceAt
          ? `<span class="ok">[ ${key} ]</span>`
          : `<span class="hl">[ ${key} ]</span>`,
      )
      .join('  ');
    const progress = `${'■'.repeat(this.sequenceAt)}${'□'.repeat(this.sequence.length - this.sequenceAt)}`;

    return {
      nodeLabel: mixed ? 'PROVA 3/3' : 'CALIBRAÇÃO 1/3',
      bodyHtml:
        '<span class="bad">TRAVA DE SEGURANÇA</span>\n\n' +
        `SEQUÊNCIA:  ${rendered}\n` +
        `ENTRADA:    ${progress}`,
      prompt: mixed
        ? 'A interferência tomou o painel. Digite a sequência completa.'
        : 'Digite todas as teclas, da esquerda para a direita.',
      options: [],
      timeLimit: this.left,
      continuous: true,
      continuousTotal: this.total,
      attentionCue: 'lock',
    };
  }

  private taskNode(): MissionNode {
    const inspectionLesson = this.stage === 'INSPECTION_TASK';
    const remaining = Math.max(0, 2 - this.mixedCompleted);
    return {
      nodeLabel: inspectionLesson ? 'IMOBILIDADE 2/3' : 'PROVA 3/3',
      bodyHtml: inspectionLesson
        ? '<span class="key">ROTINA DE CALIBRAÇÃO ATIVA</span>\n\n' +
          `LEITURA ESTÁVEL       CONFIRMAR: <span class="hl">[ ${this.taskKey} ]</span>\n\n` +
          '<span class="ghost">Depois da confirmação, escute os passos. O painel tentará enganar você.</span>'
        : '<span class="key">ROTINA SEM ASSISTÊNCIA</span>\n\n' +
          `CANAL ${3 - remaining}/3             CONFIRMAR: <span class="hl">[ ${this.taskKey} ]</span>\n` +
          `INTERFERÊNCIAS RESTANTES: ${remaining}\n\n` +
          '<span class="ghost">Continue trabalhando. Reaja à trava; pare diante da luz.</span>',
      prompt: `Pressione ${this.taskKey} para confirmar a leitura.`,
      options: [],
      timeLimit: 99,
      attentionCue: 'routine',
    };
  }

  private inspectionNode(): MissionNode {
    const mixed = this.isMixed();
    const watching = this.isWatching();
    const clear = this.isClear();
    const bait = this.currentBait();

    let bodyHtml: string;
    let prompt: string;
    if (watching) {
      bodyHtml =
        '<span class="hl">LUZ BRANCA · ELE ESTÁ OLHANDO</span>\n\n' +
        `     PAINEL: <span class="bad">PRESSIONE [ ${bait} ] AGORA</span>\n\n` +
        (mixed
          ? '                 NÃO SE MOVA'
          : '          ISSO É UMA ISCA · NÃO SE MOVA');
      prompt = mixed ? `Entrada solicitada: ${bait}.` : 'Ignore o comando até a luz apagar.';
    } else if (clear) {
      bodyHtml =
        '<span class="ok">A LUZ ESTÁ RECUANDO</span>\n\n' +
        '              AGUARDE A LIBERAÇÃO';
      prompt = 'A entrada continua bloqueada por um instante.';
    } else {
      bodyHtml =
        '<span class="key">PASSOS SE APROXIMANDO</span>\n\n' +
        `LEITURA PENDENTE       <span class="hl">[ ${this.taskKey} ]</span>\n\n` +
        (mixed
          ? 'A cabine está escurecendo.'
          : 'Ainda é seguro concluir uma ação. Prepare as mãos.');
      prompt = mixed
        ? 'A interferência ainda não tomou a entrada.'
        : 'Quando a cabine ficar branca, abandone o comando pendente.';
    }

    return {
      nodeLabel: mixed ? 'PROVA 3/3' : 'IMOBILIDADE 2/3',
      bodyHtml,
      prompt,
      options: [],
      timeLimit: this.left,
      continuous: true,
      continuousTotal: this.total,
      attentionCue: watching ? 'watch' : clear ? 'clear' : 'approach',
    };
  }

  private enterLockKey(key: string, raw: string): Resolution {
    const mixed = this.stage === 'MIX_LOCK';
    if (key !== this.sequence[this.sequenceAt]) {
      this.beginLock(mixed);
      return this.result(
        'BAD',
        `“${raw || '—'}” não era a próxima entrada. A trava reiniciou com outra sequência.`,
      );
    }

    this.sequenceAt++;
    if (this.sequenceAt < this.sequence.length) {
      return this.result('NEUTRAL', `${this.sequenceAt}/${this.sequence.length}. Continue.`);
    }

    if (mixed) {
      this.completeMixedEvent();
      return this.result('GOOD', 'Trava liberada. Volte imediatamente à rotina.');
    }

    this.stage = 'INSPECTION_TASK';
    this.taskKey = this.nextTaskKey();
    return this.result(
      'GOOD',
      'Trava liberada. O próximo checkpoint exige a reação oposta.',
    );
  }

  private enterTaskKey(key: string, raw: string): Resolution {
    if (key !== this.taskKey) {
      this.taskKey = this.nextTaskKey();
      return this.result(
        'BAD',
        `“${raw || '—'}” não confirma a leitura. A rotina continua com um novo código.`,
      );
    }

    if (this.stage === 'INSPECTION_TASK') {
      this.setTimedStage('INSPECTION_APPROACH', this.approachTime);
      return this.result(
        'NEUTRAL',
        'Leitura confirmada. Os passos começaram; ainda é seguro agir até o clarão.',
      );
    }

    if (this.mixedCompleted >= this.mixedOrder.length) {
      this.stage = 'DONE';
      this.ended = true;
      return this.result(
        'GOOD',
        'Trava, inspeção e retorno à rotina concluídos sem confundir as regras.',
        true,
        true,
      );
    }

    const event = this.mixedOrder[this.mixedCompleted]!;
    if (event === 'LOCK') this.beginLock(true);
    else this.setTimedStage('MIX_APPROACH', this.approachTime);
    return this.result(
      'NEUTRAL',
      'Leitura aceita. Uma interferência assumiu o painel.',
    );
  }

  private beginLock(mixed: boolean): void {
    const count = mixed
      ? (Math.min(4, this.baseCount + 1) as LockKeyCount)
      : this.baseCount;
    const spec = makeLockSpec(this.rng, this.intensity, count);
    this.sequence = spec.sequence;
    this.sequenceAt = 0;
    this.stage = mixed ? 'MIX_LOCK' : 'LOCK';
    this.left = spec.window;
    this.total = spec.window;
  }

  private completeMixedEvent(): void {
    this.mixedCompleted++;
    this.stage = 'MIX_TASK';
    this.taskKey = this.nextTaskKey();
  }

  private setTimedStage(stage: Stage, duration: number, overshoot = 0): void {
    this.stage = stage;
    this.total = duration;
    this.left = duration - overshoot;
  }

  private nextTaskKey(): string {
    let next = this.rng.pick(TASK_KEYS);
    while (next === this.taskKey) next = this.rng.pick(TASK_KEYS);
    return next;
  }

  private currentBait(): string {
    const elapsed = Math.max(0, this.total - this.left);
    return BAIT_KEYS[Math.floor(elapsed / 0.42) % BAIT_KEYS.length]!;
  }

  private isMixed(): boolean {
    return this.stage.startsWith('MIX_');
  }

  private isApproach(): boolean {
    return this.stage === 'INSPECTION_APPROACH' || this.stage === 'MIX_APPROACH';
  }

  private isWatching(): boolean {
    return this.stage === 'INSPECTION_WATCH' || this.stage === 'MIX_WATCH';
  }

  private isClear(): boolean {
    return this.stage === 'INSPECTION_CLEAR' || this.stage === 'MIX_CLEAR';
  }

  private isTimed(): boolean {
    return (
      this.stage === 'LOCK' ||
      this.stage === 'MIX_LOCK' ||
      this.isApproach() ||
      this.isWatching() ||
      this.isClear()
    );
  }

  private result(
    verdict: Resolution['verdict'],
    feedback: string,
    finished = false,
    success = false,
  ): Resolution {
    return {
      verdict,
      feedback,
      bestOptionId: null,
      finished,
      success,
    };
  }
}

export const interferenceKind: MissionKind = {
  id: 'interferencia',
  name: 'INTERFERÊNCIAS',
  create: (seed, difficulty) => new InterferenceTraining(seed, difficulty),
};
