import { Rng } from '../core/rng';
import { labyrinthKind } from './labyrinth/mission';
import { valveKind } from './valves';
import { wireKind } from './wires';
import type { Mission, MissionKind } from './types';

export type TransmissionSignal = 'LIMPO' | 'INSTÁVEL';

/**
 * O que o receptor consegue inferir antes de sintonizar uma chamada. Os textos
 * são deliberadamente diegéticos: a campanha informa o risco, não o nome do
 * minijogo nem uma promessa de recompensa.
 */
export interface TransmissionOffer {
  /** identificador opaco; é a única coisa que `accept()` aceita */
  readonly token: string;
  /** útil para telemetria/testes, mas não precisa aparecer no terminal */
  readonly kindId: string;
  /** fixado no instante da varredura para que recusar/esperar não refaça a missão */
  readonly seed: number;
  /** ajuste aplicado à dificuldade quando a frequência é aceita */
  readonly modifier: number;
  readonly danger: string;
  readonly window: string;
  readonly signal: TransmissionSignal;
  /** força normalizada 0..1; o auto-tune escolhe a maior */
  readonly strength: number;
}

/**
 * O LABIRINTO é o carro-chefe e aparece com o dobro de frequência: é a única
 * missão em que existe outra pessoa do outro lado, e é isso que dói.
 */
const OPENING: readonly MissionKind[] = [
  labyrinthKind,
  valveKind,
  wireKind,
  labyrinthKind,
];

const DECK: readonly MissionKind[] = [labyrinthKind, labyrinthKind, valveKind, wireKind];

/**
 * Cada três varreduras os três confrontos possíveis aparecem uma vez. Assim a
 * escolha sempre é real, mas nenhum protocolo some por uma sequência ruim de
 * RNG. O Labirinto continua presente em 2/3 das seleções, como no deck antigo.
 */
const OFFER_CYCLE: readonly (readonly [MissionKind, MissionKind])[] = [
  [labyrinthKind, valveKind],
  [labyrinthKind, wireKind],
  [valveKind, wireKind],
];

const OFFER_PROFILE: Readonly<Record<string, { danger: string; window: string }>> = {
  labirinto: { danger: 'MOVIMENTO HUMANO', window: 'CURTA · 25–45 S' },
  purga: { danger: 'SOBREPRESSÃO', window: 'MÉDIA · 35–60 S' },
  codigo: { danger: 'ALTA TENSÃO', window: 'LONGA · 45–80 S' },
};

interface PendingOffer {
  readonly offer: TransmissionOffer;
  readonly kind: MissionKind;
}

export class MissionDeck {
  private rng: Rng;
  private lastId = '';
  private dealt = 0;
  private offerAt = 0;
  private offerSerial = 0;
  private pendingOffers: readonly [PendingOffer, PendingOffer] | null = null;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  next(difficulty: number): Mission {
    // A abertura funciona como uma campanha curta: apresenta os três sistemas
    // em ordem legível e volta ao carro-chefe antes de liberar o deck infinito.
    const forced = OPENING[this.dealt];
    this.dealt++;
    if (forced) {
      this.lastId = forced.id;
      return forced.create(this.rng.int(0x7fffffff), difficulty);
    }

    let kind = this.rng.pick(DECK);
    // evita repetir o mesmo tipo duas vezes seguidas (menos o labirinto)
    for (let i = 0; i < 4 && kind.id === this.lastId && kind.id !== 'labirinto'; i++) {
      kind = this.rng.pick(DECK);
    }
    this.lastId = kind.id;
    return kind.create(this.rng.int(0x7fffffff), difficulty);
  }

  /**
   * Abre uma varredura de duas frequências. Enquanto nenhuma delas for aceita,
   * chamadas subsequentes devolvem o mesmo par: não existe reroll por timeout,
   * resize ou render repetido.
   */
  offer(_difficulty: number): readonly [TransmissionOffer, TransmissionOffer] {
    if (this.pendingOffers) {
      return [this.pendingOffers[0].offer, this.pendingOffers[1].offer];
    }

    const pair = OFFER_CYCLE[this.offerAt % OFFER_CYCLE.length]!;
    this.offerAt++;

    // Sempre há uma frequência legível e uma arriscada, mas a posição muda.
    const cleanAt = this.rng.chance(0.5) ? 0 : 1;
    const pending = pair.map((kind, index): PendingOffer => {
      const signal: TransmissionSignal = index === cleanAt ? 'LIMPO' : 'INSTÁVEL';
      const modifier = signal === 'LIMPO' ? -0.08 : 0.12;
      const strength = signal === 'LIMPO'
        ? 0.78 + this.rng.next() * 0.17
        : 0.38 + this.rng.next() * 0.28;
      const seed = this.rng.int(0x7fffffff);
      const serial = this.offerSerial++;
      const profile = OFFER_PROFILE[kind.id]!;
      const offer = Object.freeze<TransmissionOffer>({
        token: `${serial.toString(36)}-${kind.id}-${seed.toString(36)}`,
        kindId: kind.id,
        seed,
        modifier,
        danger: profile.danger,
        window: profile.window,
        signal,
        strength,
      });
      return { offer, kind };
    }) as unknown as [PendingOffer, PendingOffer];

    this.pendingOffers = pending;
    return [pending[0].offer, pending[1].offer];
  }

  /**
   * Consome a frequência escolhida e descarta a outra. O seed e o modificador
   * são os que já estavam visíveis na oferta; só a dificuldade global é lida no
   * instante da conexão.
   */
  accept(token: string, difficulty: number): Mission {
    if (!this.pendingOffers) {
      throw new Error('Nenhuma transmissão está aguardando sintonia.');
    }

    const picked = this.pendingOffers.find((entry) => entry.offer.token === token);
    if (!picked) {
      throw new Error('Frequência desconhecida ou já descartada.');
    }

    this.pendingOffers = null;
    this.lastId = picked.kind.id;
    const effectiveDifficulty = Math.max(0, difficulty + picked.offer.modifier);
    return picked.kind.create(picked.offer.seed, effectiveDifficulty);
  }

  /** Consome a varredura sem abrir nenhum canal (extração manual da chave). */
  discard(): void {
    if (!this.pendingOffers) throw new Error('Nenhuma transmissão está aguardando descarte.');
    this.pendingOffers = null;
  }
}

export { labyrinthKind, valveKind, wireKind };
