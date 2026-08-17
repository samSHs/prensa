/** Contrato entre a missão e a esteira. A esteira não sabe o que é um labirinto. */

export type Verdict = 'GOOD' | 'NEUTRAL' | 'BAD' | 'FATAL';

export interface MissionOption {
  id: string;
  label: string;
}

export interface MissionNode {
  /** "TURNO 04/14", "VÁLVULA 2 DE 6"… */
  nodeLabel: string;
  /** mapa/diagrama já com marcação (HTML — o terminal injeta) */
  bodyHtml: string;
  prompt: string;
  options: MissionOption[];
  /** segundos; o cronômetro corre enquanto a esteira anda */
  timeLimit: number;
  /**
   * Missões contínuas usam a barra como relógio visual de pulso. Chegar a zero
   * não escolhe WAIT automaticamente: a própria simulação avança.
   */
  continuous?: boolean;
  /** duração total do pulso quando `timeLimit` contém apenas o restante */
  continuousTotal?: number;
  /** Sinal físico de uma prova de atenção, usado pelo treinamento para
   * reproduzir a mesma linguagem visual da campanha. */
  attentionCue?: 'routine' | 'lock' | 'approach' | 'watch' | 'clear';
}

export interface Resolution {
  verdict: Verdict;
  feedback: string;
  /** para destacar a alternativa que era a certa, depois do fato */
  bestOptionId: string | null;
  finished: boolean;
  success: boolean;
  /** texto final da missão, se acabou */
  epilogue?: string;
  /** efeito audiovisual que o integrador pode disparar sem acoplar a missão */
  cue?: 'VICTIM_SCREAM' | 'PIPE_BURST' | 'ELECTROCUTION';
}

export interface MissionUpdate {
  /** o estado visual mudou e `node()` deve ser consultado novamente */
  changed: boolean;
  /**
   * Crédito físico conquistado pela simulação — nunca por repetir um botão.
   * O labirinto usa isto quando a refém realmente encurta a rota ou escapa de
   * uma perseguição, ligando o resgate à sobrevivência na esteira.
   */
  beltGain?: number;
  /** término autônomo: morte/tempo podem acontecer sem uma escolha */
  resolution?: Resolution;
}

export interface Mission {
  readonly id: string;
  readonly name: string;
  /** a missão continua simulando enquanto o terminal espera uma escolha */
  readonly live?: boolean;
  /** uma linha que o Zelador lê antes de começar */
  readonly brief: string;
  /**
   * Manual usado somente na sala de treinamento fora da campanha.
   */
  readonly howTo: string;
  node(): MissionNode;
  /** `null` = tempo esgotado */
  choose(optionId: string | null): Resolution;
  /**
   * Melhor alternativa do nó atual, sem alterar estado. Existe para o
   * harness de balanceamento provar que a missão é vencível jogando perfeito.
  */
  peekBest(): string | null;
  /** atalho estável da missão, fora da lista numerada de alternativas */
  shortcut?(raw: string): Resolution | null;
  /** carga atual para sistemas que evitam interromper uma decisão crítica */
  attention?(): { load: 0 | 1 | 2; inputRequired: boolean; safeSilenceSeconds: number };
  /** atualização opcional em tempo real; missões discretas não implementam */
  update?(dt: number): MissionUpdate | null;
}

export interface MissionKind {
  id: string;
  name: string;
  /** difficulty: 0 na primeira missão, cresce indefinidamente */
  create(seed: number, difficulty: number): Mission;
}
