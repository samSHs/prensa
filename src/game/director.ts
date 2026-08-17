import { Rng, clamp, lerp } from '../core/rng';
import { lockKeyCount, lockWindow } from './interrupts';

/** Eventos que sequestram temporariamente a atenção do jogador. */
export type AttentionKind = 'LOCK' | 'INSPECTION';

/** O ritmo invisível da campanha. Nunca deve aparecer como HUD. */
export type TensionPhase = 'CALMA' | 'SUSPEITA' | 'CERCO' | 'ALIVIO';

export interface DirectorContext {
  missionsDone: number;
  keys: number;
  difficulty: number;
  elapsed: number;
  danger: number;
  /** O terminal está aceitando uma decisão neste instante. */
  running: boolean;
  interruptActive: boolean;
  /** 0 = janela limpa, 1 = atenção elevada, 2 = decisão urgente/HUNT. */
  attentionLoad: number;
  inputRequired: boolean;
  safeSilenceSeconds: number;
  /** Fração 0..1 ainda disponível para a decisão atual. */
  decisionFraction: number;
  untilImpact: number;
  voiceBusy: boolean;
}

export interface DirectorDecision {
  phase: TensionPhase;
  macro: number;
  /** Evento emitido apenas no quadro em que deve começar. */
  event: AttentionKind | null;
}

const EVENT_COST = 2;
const INSPECTION_COOLDOWN = 42;
const MAX_INSPECTIONS = 2;

const PHASE_BASE: Record<TensionPhase, readonly [number, number]> = {
  CALMA: [10, 5],
  SUSPEITA: [7, 4],
  CERCO: [12, 22],
  ALIVIO: [10, 6],
};

/**
 * Diretor determinístico de tensão.
 *
 * Ele não conhece DOM, áudio, física ou detalhes de uma missão. Só emite uma
 * decisão; o integrador continua responsável por iniciar/cancelar o executor.
 * Gastar o orçamento no momento da emissão impede que cancelar uma animação
 * devolva imediatamente outro evento.
 */
export class TensionDirector {
  private readonly initialSeed: number;
  private rng: Rng;

  private current: TensionPhase = 'CALMA';
  private phaseLeft = 0;
  private cercoBudget = 0;
  private eventGap = 0;
  private inspectionCooldown = 0;
  private inspections = 0;
  private inspectionsThisCerco = 0;
  private eventsIssued = 0;
  private locksSinceInspection = 0;
  private lockResolved = false;
  private eventOutstanding = false;
  private lastKind: AttentionKind | null = null;
  private openingProtected = true;
  private dangerRelief = false;
  private lastMacro = 0;

  constructor(seed: number) {
    this.initialSeed = seed >>> 0;
    this.rng = new Rng(this.initialSeed);
    this.reset();
  }

  reset(): void {
    this.rng = new Rng(this.initialSeed);
    this.current = 'CALMA';
    this.phaseLeft = 0;
    this.cercoBudget = 0;
    this.eventGap = 0;
    this.inspectionCooldown = 0;
    this.inspections = 0;
    this.inspectionsThisCerco = 0;
    this.eventsIssued = 0;
    this.locksSinceInspection = 0;
    this.lockResolved = false;
    this.eventOutstanding = false;
    this.lastKind = null;
    this.openingProtected = true;
    this.dangerRelief = false;
    this.lastMacro = 0;
  }

  /** A progressão longa da partida; perigo imediato entra no orçamento à parte. */
  private macroFor(c: DirectorContext): number {
    return clamp(
      0.45 * clamp(c.keys / 4, 0, 1) +
        0.35 * clamp(c.difficulty / 1.6, 0, 1) +
        0.2 * clamp(c.elapsed / 180, 0, 1),
      0,
      1,
    );
  }

  private tierValue(macro: number): number {
    return macro < 0.35 ? 2 : macro < 0.7 ? 4 : 6;
  }

  private duration(phase: TensionPhase, macro: number): number {
    const [early, late] = PHASE_BASE[phase];
    // A variação é consumida apenas ao entrar num estado, portanto a taxa de
    // quadros não altera a sequência pseudoaleatória da partida.
    return lerp(early, late, macro) * this.rng.range(0.85, 1.15);
  }

  private enter(phase: TensionPhase, macro = this.lastMacro): void {
    this.current = phase;
    this.phaseLeft = this.duration(phase, macro);
    if (phase === 'CERCO') {
      this.cercoBudget = this.tierValue(macro);
      this.inspectionsThisCerco = 0;
    } else {
      this.cercoBudget = 0;
    }
  }

  private nextPhase(macro: number): void {
    switch (this.current) {
      case 'CALMA':
        this.enter('SUSPEITA', macro);
        break;
      case 'SUSPEITA':
        this.enter('CERCO', macro);
        break;
      case 'CERCO':
        // Orçamento que não encontrou uma janela justa morre aqui. Nunca é
        // carregado para o alívio nem vira uma rajada tardia.
        this.enter('ALIVIO', macro);
        break;
      case 'ALIVIO':
        this.enter('CALMA', macro);
        break;
    }
  }

  private tickPhases(dt: number, macro: number): void {
    let left = Math.max(0, dt);
    // dt normal é <= 0,05 s. O laço também torna avanços maiores seguros para
    // harnesses e abas que voltam de suspensão.
    for (let guard = 0; guard < 8 && left > 0; guard++) {
      if (this.phaseLeft > left) {
        this.phaseLeft -= left;
        return;
      }
      left -= Math.max(0, this.phaseLeft);
      this.nextPhase(macro);
    }
  }

  private eventDuration(kind: AttentionKind, macro: number): number {
    if (kind === 'INSPECTION') return 1.4 + lerp(2.2, 3.1, macro) + 0.5;
    return lockWindow(lockKeyCount(macro));
  }

  private currentLoad(c: DirectorContext, kind: AttentionKind, macro: number): number {
    let load = clamp(Math.round(c.attentionLoad), 0, 6);
    if (c.inputRequired) load += 2;
    if (c.decisionFraction < 0.34) load += 2;
    if (c.danger >= 0.78) load += 3;
    else if (c.danger >= 0.55) load += 1;

    // A batida pode compor um CERCO tardio, mas ocupa parte explícita do
    // orçamento. No início ela impede completamente uma interrupção.
    if (c.untilImpact <= this.eventDuration(kind, macro) + 0.5) load += 2;
    return load;
  }

  private baseEligible(c: DirectorContext): boolean {
    return (
      this.current === 'CERCO' &&
      this.cercoBudget >= EVENT_COST &&
      this.eventGap <= 0 &&
      !this.eventOutstanding &&
      c.running &&
      !c.interruptActive &&
      !c.voiceBusy &&
      c.danger < 0.88 &&
      c.decisionFraction >= 0.18 &&
      // Não deixa o alarme nascer embaixo do áudio de carga da prensa. Em
      // CERCO tardio ela ainda pode cair depois, durante o evento.
      c.untilImpact > 1.55
    );
  }

  private inspectionEligible(c: DirectorContext, macro: number): boolean {
    if (
      c.missionsDone < 2 ||
      !this.lockResolved ||
      this.inspections >= MAX_INSPECTIONS ||
      this.inspectionsThisCerco >= 1 ||
      this.inspectionCooldown > 0 ||
      this.lastKind === 'INSPECTION'
    ) {
      return false;
    }

    // Como a partida comporta no máximo duas inspeções, ambas recebem as
    // garantias de estreia: janela limpa, bastante tempo e nenhuma batida.
    const duration = this.eventDuration('INSPECTION', macro);
    return (
      c.attentionLoad === 0 &&
      !c.inputRequired &&
      c.safeSilenceSeconds >= duration &&
      c.danger < 0.68 &&
      c.decisionFraction > 0.65 &&
      c.untilImpact > duration + 0.5
    );
  }

  private chooseEvent(c: DirectorContext, macro: number): AttentionKind | null {
    if (!this.baseEligible(c)) return null;

    // O primeiro sequestro de atenção sempre ensina a regra ativa da trava.
    let kind: AttentionKind = 'LOCK';
    if (this.eventsIssued > 0 && this.inspectionEligible(c, macro)) {
      // A chance mantém a sessão menos mecânica; duas travas desde a última
      // inspeção garantem que o evento raro não desapareça por azar eterno.
      const wantsInspection =
        this.locksSinceInspection >= 2 || this.rng.chance(0.25 + macro * 0.1);
      if (wantsInspection) kind = 'INSPECTION';
    }

    const cap = this.tierValue(macro);
    if (this.currentLoad(c, kind, macro) + EVENT_COST > cap) return null;

    // A primeira trava também recebe a janela protegida de estreia.
    if (
      this.eventsIssued === 0 &&
      (c.attentionLoad !== 0 ||
        c.danger >= 0.68 ||
        c.decisionFraction <= 0.5 ||
        c.untilImpact <= this.eventDuration('LOCK', macro) + 0.5)
    ) {
      return null;
    }

    this.cercoBudget -= EVENT_COST;
    this.eventOutstanding = true;
    this.eventsIssued++;
    this.lastKind = kind;
    if (kind === 'INSPECTION') {
      this.inspections++;
      this.inspectionsThisCerco++;
      this.inspectionCooldown = INSPECTION_COOLDOWN;
      this.locksSinceInspection = 0;
    } else {
      this.locksSinceInspection++;
    }
    return kind;
  }

  update(dt: number, c: DirectorContext): DirectorDecision {
    const elapsed = Math.max(0, dt);
    const macro = this.macroFor(c);
    this.lastMacro = macro;
    this.eventGap = Math.max(0, this.eventGap - elapsed);
    this.inspectionCooldown = Math.max(0, this.inspectionCooldown - elapsed);

    // A primeira missão é o espaço para compreender o jogo, qualquer que seja
    // sua duração ou o estado físico da esteira.
    if (c.missionsDone < 1) {
      this.openingProtected = true;
      this.current = 'CALMA';
      this.cercoBudget = 0;
      return { phase: this.current, macro, event: null };
    }

    // Funciona mesmo se o integrador ainda não chamou missionFinished().
    if (this.openingProtected) {
      this.openingProtected = false;
      this.enter('ALIVIO', macro);
    }

    // Perto da morte, prensa e coração já são o CERCO. Só libera o diretor
    // depois que o jogador realmente recupera distância (histerese 0,88/0,74).
    if (c.danger >= 0.88) {
      this.dangerRelief = true;
      if (this.current !== 'ALIVIO') this.enter('ALIVIO', macro);
      return { phase: this.current, macro, event: null };
    }
    if (this.dangerRelief) {
      if (c.danger > 0.74) return { phase: this.current, macro, event: null };
      this.dangerRelief = false;
      this.enter('ALIVIO', macro);
    }

    this.tickPhases(elapsed, macro);
    const event = this.chooseEvent(c, macro);
    return { phase: this.current, macro, event };
  }

  /** Fim de qualquer missão cria um vale; falhar prolonga um pouco o silêncio. */
  missionFinished(result: boolean | string = true): void {
    const success = result === true || result === 'GOOD';
    this.openingProtected = false;
    this.eventOutstanding = false;
    this.enter('ALIVIO', this.lastMacro);
    this.phaseLeft *= success ? 0.72 : 1.05;
  }

  /** Deve ser chamado depois que o executor informou acerto ou falha. */
  interruptFinished(kind: AttentionKind, success = true): void {
    this.eventOutstanding = false;
    if (kind === 'LOCK') this.lockResolved = true;
    this.eventGap = Math.max(this.eventGap, lerp(14, 7, this.lastMacro));

    // A inspeção é o ápice da onda. Uma trava errada também já puniu o jogador
    // o bastante; em ambos os casos o restante do orçamento é descartado.
    if (kind === 'INSPECTION' || !success) this.enter('ALIVIO', this.lastMacro);
  }

  /** Erro de missão comum: não cria alívio grátis, apenas evita pile-on. */
  commonError(): void {
    this.eventGap = Math.max(this.eventGap, 3.5);
  }
}
