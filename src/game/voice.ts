import { Rng } from '../core/rng';
import type { Audio } from './audio';

/**
 * O ZELADOR.
 *
 * Ele nunca grita. Fala como quem preenche formulário — e é por isso que
 * incomoda. Trata você como equipamento em teste, e trata a morte como
 * resultado de ensaio. Toda linha aqui foi escrita para ser dita por um
 * alto-falante enferrujado a doze metros de distância.
 */

export const INTRO: readonly string[] = [
  'Bom dia. Você acordou. Isso já é um dado.',
  'Você está deitado numa esteira de transporte de sucata. Ela funciona. Nós verificamos hoje de manhã.',
  'À sua frente há uma prensa hidráulica de quatrocentas toneladas. Ela também funciona.',
  'Não temos nada contra você.',
  'Você foi escolhido por dois motivos: morava perto do galpão, e ninguém vai notar que você sumiu antes de terça-feira.',
  'À sua direita há um terminal. Ele mostra pessoas em situações parecidas com a sua.',
  'Cada resposta correta inverte a esteira por alguns segundos. Cada erro acelera.',
  'Cada missão concluída libera uma chave. Você precisa de quatro.',
  'Não existe pausa. Não existe recomeço. Ninguém está vindo atrás de você.',
  'Vinte e seis metros atrás de você há uma escotilha de manutenção. Quatro travas mantêm ela fechada.',
  'Pegue as quatro chaves. Depois, é só chegar até lá.',
];

/**
 * Aberturas de retorno. Ele não repete o discurso — cada morte encurta o que
 * ele acha que você merece ouvir, até sobrar uma palavra. Sai mais rápido que
 * pular, e ainda é conteúdo.
 */
const INTRO_REPEATS: readonly (readonly string[])[] = [
  [
    'Você de novo. A esteira foi rebobinada enquanto você não estava aqui.',
    'As regras não mudaram. Quatro chaves. Vinte e seis metros.',
  ],
  ['Segunda vez que eu lavo essa linha hoje.', 'Vá.'],
  ['Não vou explicar de novo.'],
  ['Já.'],
];

/** `run` 0 é a primeira partida da sessão. */
export function introFor(run: number): readonly string[] {
  if (run <= 0) return INTRO;
  return INTRO_REPEATS[Math.min(run - 1, INTRO_REPEATS.length - 1)]!;
}

const GOOD = [
  'Correto.',
  'Anotado.',
  'Você lê rápido. Isso é raro.',
  'Bom. Continue assim e talvez isso demore.',
  'A esteira recuou. Não confunda isso com misericórdia.',
  'Interessante. Você ainda está pensando.',
];

const BAD = [
  'Incorreto.',
  'Você chutou. Dá para ouvir daqui.',
  'A esteira agradece.',
  'Errado. E você sabia que estava errado.',
  'Registrado. A velocidade foi ajustada.',
  'Isso custou metros.',
];

const FATAL = [
  'A pessoa do outro lado morreu por sua causa. Você entende isso, não entende?',
  'Ela confiou na sua voz. Foi o último erro dela.',
  'Isso não foi um erro de cálculo. Isso foi uma decisão.',
  'Você não é bom nisso. Ninguém é, no começo.',
];

const MISSION_WIN = [
  'Missão encerrada. O sistema perdeu um pouco de força.',
  'Concluído. Você comprou tempo. Tempo é a única moeda aqui.',
  'A prensa vai reclamar disso.',
];

const HATCH_LOCKED = [
  'Você chegou à escotilha cedo demais. As quatro travas continuam no lugar.',
  'A porta não negocia. Encontre as chaves.',
  'Pode empurrar de novo, se quiser. A escotilha continua trancada.',
];

const MISSION_LOSE = [
  'Missão encerrada mal. A linha compensou sozinha.',
  'Fracasso registrado. A esteira recebeu o excedente.',
  'Isso vai aparecer no relatório. O relatório é a prensa.',
];

const ESCALATION = [
  'Fase dois. O ciclo da prensa foi encurtado. Você vai perceber.',
  'Fase três. A partir daqui o terminal não é confiável em todos os pontos.',
  'Fase quatro. Estamos observando outra coisa em você agora, não a resposta.',
  'Fase cinco. Honestamente, ninguém chegou aqui antes.',
];

const NEAR = [
  'Você está a menos de três metros. Vire a cabeça se quiser olhar.',
  'Ela desce a cada dois segundos agora. Conte, se ajudar.',
  'Não feche os olhos. Não muda nada, mas não feche.',
  'Daqui eu consigo ver seu joelho tremendo.',
];

const INTERRUPT_FAIL = [
  'A trava de segurança não foi confirmada.',
  'Você deixou passar. A esteira ganhou folga.',
  'Duas coisas ao mesmo tempo. É sempre aí que quebram.',
];

const IDLE = [
  'Você respira alto.',
  'O terminal registra dezoito batimentos nos últimos dez segundos.',
  'Tem alguém no corredor. Não é para você.',
  'Continue.',
  'Não olhe para a cabine.',
];

export const DEATH_LINES: readonly string[] = [
  'Encerrado às — não importa. Encerrado.',
  'Obrigado pela participação. Os dados foram úteis.',
  'Limpem a linha três.',
];

export const ESCAPE_LINES: readonly string[] = [
  'A escotilha abriu.',
  'Isso não estava previsto. Vou precisar rever a esteira.',
  'Vá. Você vai voltar sozinho, mais tarde. Todos voltam.',
];

interface Utterance {
  text: string;
  hold: number;
  who: string;
  /** trava a fala no fim da digitação até o jogador pedir a próxima */
  gate: boolean;
}

export class Voice {
  private queue: Utterance[] = [];
  private cur: Utterance | null = null;
  private typed = 0;
  private holdLeft = 0;
  private idleTimer = 22;
  private rng = new Rng(0x5eed1);
  private soundCounter = 0;

  constructor(
    private root: HTMLElement,
    private whoEl: HTMLElement,
    private lineEl: HTMLElement,
    private audio: Audio,
  ) {}

  get busy(): boolean {
    return this.cur !== null || this.queue.length > 0;
  }

  say(
    text: string,
    opts: { who?: string; hold?: number; urgent?: boolean; gate?: boolean } = {},
  ): void {
    const u: Utterance = {
      text,
      hold: opts.hold ?? Math.max(1.6, text.length * 0.035),
      who: opts.who ?? 'O ZELADOR',
      gate: opts.gate ?? false,
    };
    if (opts.urgent) {
      this.queue.length = 0;
      this.cur = null;
      this.typed = 0;
      this.queue.push(u);
    } else if (this.queue.length < 3) {
      this.queue.push(u);
    }
    this.idleTimer = 26 + this.rng.next() * 20;
  }

  private pick(bank: readonly string[]): string {
    return this.rng.pick(bank);
  }

  good(): void {
    if (this.rng.chance(0.4)) this.say(this.pick(GOOD));
  }
  bad(): void {
    if (this.rng.chance(0.55)) this.say(this.pick(BAD));
  }
  fatal(): void {
    this.say(this.pick(FATAL), { urgent: true });
  }
  missionWin(): void {
    this.say(this.pick(MISSION_WIN));
  }
  keyAcquired(keys: number, total: number): void {
    if (keys >= total) {
      this.say('Quarta chave registrada. As travas da escotilha foram liberadas.', {
        urgent: true,
        hold: 3.4,
      });
      return;
    }
    const missing = total - keys;
    this.say(
      `Chave ${keys} de ${total}. ${missing === 1 ? 'Falta uma.' : `Faltam ${missing}.`}`,
      { hold: 2.4 },
    );
  }
  hatchLocked(keys: number, total: number): void {
    if (keys === 0) {
      this.say(this.pick(HATCH_LOCKED), { hold: 2.8 });
      return;
    }
    const missing = total - keys;
    this.say(
      `A escotilha recusou você. ${missing === 1 ? 'Ainda falta uma chave.' : `Ainda faltam ${missing} chaves.`}`,
      { hold: 2.8 },
    );
  }
  missionLose(): void {
    this.say(this.pick(MISSION_LOSE));
  }
  escalation(phase: number): void {
    const line = ESCALATION[Math.min(phase, ESCALATION.length) - 1];
    if (line) this.say(line, { urgent: true, hold: 3.4 });
  }
  near(): void {
    this.say(this.pick(NEAR), { hold: 2.6 });
  }
  interruptFail(): void {
    if (this.rng.chance(0.5)) this.say(this.pick(INTERRUPT_FAIL));
  }

  clear(): void {
    this.queue.length = 0;
    this.cur = null;
    this.root.hidden = true;
  }

  /**
   * ENTER na abertura: se a linha ainda está sendo digitada, completa na hora;
   * se já terminou, chama a próxima. Duas batidas por frase, então dá para
   * atravessar o discurso inteiro no ritmo da leitura.
   */
  advance(): void {
    const u = this.cur;
    if (!u) return;
    if (this.typed < u.text.length) {
      this.typed = u.text.length;
      this.lineEl.textContent = u.text;
      this.root.classList.add('done');
      if (!u.gate) this.holdLeft = Math.min(this.holdLeft, 0.4);
    } else if (u.gate) {
      // fala travada: só o jogador a dispensa
      this.cur = null;
      if (!this.queue.length) this.root.hidden = true;
    } else {
      this.holdLeft = 0;
    }
  }

  /** true enquanto uma fala travada espera o ENTER do jogador */
  get waiting(): boolean {
    const u = this.cur;
    return u !== null && u.gate && this.typed >= u.text.length;
  }

  /** 1 enquanto os alto-falantes estão vivos (o mundo 3D usa isso) */
  get active(): number {
    return this.cur ? 1 : 0;
  }

  update(dt: number, danger: number): void {
    if (!this.cur) {
      const nxt = this.queue.shift();
      if (nxt) {
        this.cur = nxt;
        this.typed = 0;
        this.holdLeft = nxt.hold;
        this.root.hidden = false;
        this.root.classList.remove('done');
        this.whoEl.textContent = nxt.who;
        this.lineEl.textContent = '';
        this.audio.crackle();
      } else {
        // silêncio longo demais? ele comenta. Nunca quando você quer.
        this.idleTimer -= dt;
        if (this.idleTimer <= 0 && danger > 0.25) {
          this.idleTimer = 26 + this.rng.next() * 26;
          this.say(this.pick(IDLE));
        }
        return;
      }
    }

    const u = this.cur;
    const cps = 38;
    if (this.typed < u.text.length) {
      const before = Math.floor(this.typed);
      this.typed = Math.min(u.text.length, this.typed + cps * dt);
      const after = Math.floor(this.typed);
      if (after > before) {
        this.lineEl.textContent = u.text.slice(0, after);
        if (after % 2 === 0) this.audio.say(this.soundCounter++);
      }
      if (this.typed >= u.text.length) this.root.classList.add('done');
      return;
    }

    if (u.gate) return; // a abertura não anda sozinha

    this.holdLeft -= dt;
    if (this.holdLeft <= 0) {
      this.cur = null;
      if (!this.queue.length) this.root.hidden = true;
    }
  }
}
