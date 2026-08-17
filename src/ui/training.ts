import type { Mission, MissionKind, Resolution } from '../missions/types';
import type { Audio } from '../game/audio';

interface Lesson {
  eyebrow: string;
  summary: string;
  steps: readonly string[];
  watch: string;
}

const LESSONS: Record<string, Lesson> = {
  labirinto: {
    eyebrow: 'RÁDIO // RESGATE EM TEMPO REAL',
    summary:
      'Você não pilota a vítima. Dê uma ordem num ponto de decisão; ela atravessa o corredor sozinha enquanto o caçador continua vivo.',
    steps: [
      'Localize a vítima, a saída e o último contato conhecido do caçador.',
      'Quando ela pedir uma ordem, escolha uma direção. A lista fica congelada até sua decisão; somente o mapa continua mudando.',
      'Ela percorre retas e curvas obrigatórias sem outro clique e para em bifurcações, chave, saída ou armário.',
      'A = armário. F = telefone: F1 no botão é exatamente F1 na planta; o disjuntor afeta somente a luz ao redor dela.',
      'Observe o que realmente aconteceu antes de corrigir a ordem. Contradições destroem confiança.',
      'Duas ordens transmitidas em seis segundos triangulam a posição. [0] corta o TX; dois segundos de silêncio limpam a assinatura.',
    ],
    watch:
      'Na DEMONSTRAÇÃO GUIADA, o caçador pausa enquanto uma decisão está aberta. Na SIMULAÇÃO REAL e na campanha, ele nunca pausa.',
  },
  purga: {
    eyebrow: 'HIDRÁULICA // DESVIO DE CARGA',
    summary:
      'A fonte injeta pressão na rede. Sua meta é zerar a carga que chega à PRENSA sem deixar nenhum nó acima da capacidade ou sem saída.',
    steps: [
      'Compare CARGA/CAP de cada nó e siga o fluxo indicado pelas válvulas abertas.',
      'Antes de agir, confira para onde a carga do ramo vai escapar. Fechar a alimentação da PRENSA pode sobrecarregar outro nó.',
      'Acione uma válvula por manobra e use o relatório posterior para entender o efeito real. Continue até PRENSA = 0.0.',
    ],
    watch:
      'Fechar tudo não é seguro: pressão presa em um nó sem saída também provoca ruptura.',
  },
  codigo: {
    eyebrow: 'LÓGICA // ORDEM DE CORTE',
    summary:
      'As leituras são verdadeiras e, juntas, descrevem uma única ordem. Você programa a fila completa antes de permitir qualquer corte.',
    steps: [
      'Cruze posições pares/ímpares, pontas, intervalos e relações entre três fios. Nenhuma linha isolada entrega o começo na simulação real.',
      'Preencha todos os slots; DESFAZER só retira o último. Programar um fio não confirma se ele está certo.',
      'Revise e então EXECUTE. Uma fila incompatível acumula carga e é apagada; a terceira rejeição encerra a missão.',
    ],
    watch:
      'O número ao lado do fio é apenas a posição física na caixa. A cor identifica o fio; não existe código secreto de cores.',
  },
  interferencia: {
    eyebrow: 'ATENÇÃO // TRAVA E INSPEÇÃO',
    summary:
      'Alguns eventos tomam o controle do teclado no meio de outra tarefa. A trava exige ação imediata; a inspeção exige o oposto: imobilidade total.',
    steps: [
      'Na trava vermelha, digite a sequência exata. Número, clique ou letra errada também contam como falha.',
      'Os passos anunciam a inspeção. A aproximação ainda é segura; use esse instante para terminar o que estava fazendo.',
      'Quando a cabine ficar branca, não toque no teclado nem no mouse até a luz apagar.',
    ],
    watch:
      'A campanha não abre este manual. O aviso será apenas a mudança de luz, o som dos passos e a tomada do painel.',
  },
};

/**
 * Sala de prática deliberadamente separada da campanha. Ela reaproveita as
 * missões reais, mas não cria Belt, chaves, interrupções ou cronômetros.
 */
export class Training {
  private root: HTMLElement;
  private kinds: readonly MissionKind[];
  private onExit: () => void;
  private selected: MissionKind;
  private mission: Mission | null = null;
  private attempt = 0;
  private awaitingAdvance = false;
  private finished = false;
  private guided = false;
  private hintLevel = 0;
  private pulseLeft = 0;
  private pulseTotal = 1;
  private lastAttentionCue: ReturnType<Mission['node']>['attentionCue'] | null = null;
  private suppressPointerUntil = 0;

  private lesson: HTMLElement;
  private practice: HTMLElement;
  private lessonName: HTMLElement;
  private eyebrow: HTMLElement;
  private summary: HTMLElement;
  private steps: HTMLOListElement;
  private watch: HTMLElement;
  private rules: HTMLElement;

  private missionName: HTMLElement;
  private nodeLabel: HTMLElement;
  private body: HTMLElement;
  private prompt: HTMLElement;
  private options: HTMLElement;
  private feedback: HTMLElement;
  private state: HTMLElement;
  private advanceBtn: HTMLButtonElement;
  private pulse: HTMLElement;
  private pulseBar: HTMLElement;
  private pulseLabel: HTMLElement;
  private inspection: HTMLElement;

  constructor(
    root: HTMLElement,
    kinds: readonly MissionKind[],
    private audio: Audio,
    onExit: () => void,
  ) {
    this.root = root;
    this.kinds = kinds;
    this.onExit = onExit;
    this.selected = kinds[0]!;

    this.lesson = root.querySelector<HTMLElement>('#training-lesson')!;
    this.practice = root.querySelector<HTMLElement>('#training-practice')!;
    this.lessonName = root.querySelector<HTMLElement>('#training-name')!;
    this.eyebrow = root.querySelector<HTMLElement>('#training-eyebrow')!;
    this.summary = root.querySelector<HTMLElement>('#training-summary')!;
    this.steps = root.querySelector<HTMLOListElement>('#training-steps')!;
    this.watch = root.querySelector<HTMLElement>('#training-watch')!;
    this.rules = root.querySelector<HTMLElement>('#training-rules')!;
    this.missionName = root.querySelector<HTMLElement>('#t-m-title')!;
    this.nodeLabel = root.querySelector<HTMLElement>('#t-m-node')!;
    this.body = root.querySelector<HTMLElement>('#t-m-body')!;
    this.prompt = root.querySelector<HTMLElement>('#t-m-prompt')!;
    this.options = root.querySelector<HTMLElement>('#t-m-options')!;
    this.feedback = root.querySelector<HTMLElement>('#t-m-feedback')!;
    this.state = root.querySelector<HTMLElement>('#t-m-state')!;
    this.advanceBtn = root.querySelector<HTMLButtonElement>('#training-next')!;
    this.pulse = root.querySelector<HTMLElement>('#t-m-pulse')!;
    this.pulseBar = root.querySelector<HTMLElement>('#t-m-pulse i')!;
    this.pulseLabel = root.querySelector<HTMLElement>('#t-m-pulse > span')!;
    this.inspection = root.querySelector<HTMLElement>('#training-inspection')!;

    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-training-kind]')) {
      button.addEventListener('click', () => this.select(button.dataset.trainingKind ?? ''));
    }

    this.root.querySelector('#training-start')!.addEventListener('click', () => this.start(false));
    this.root.querySelector('#training-guided')!.addEventListener('click', () => this.start(true));
    this.root.querySelector('#training-reset')!.addEventListener('click', () => this.start(this.guided));
    this.root.querySelector('#training-menu')!.addEventListener('click', () => this.showLesson());
    this.root.querySelector('#training-hint')!.addEventListener('click', () => this.hint());
    this.root.querySelector('#training-exit')!.addEventListener('click', () => this.exit());
    this.advanceBtn.addEventListener('click', () => this.advance());

    this.options.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-option]');
      if (button) this.choose(button.dataset.option ?? null);
    });
    this.root.addEventListener('pointerdown', (event) => {
      // Controles da sala são metacomandos: o jogador nunca pode ficar preso
      // numa prova de imobilidade sem conseguir reiniciar ou voltar ao manual.
      if (
        (event.target as HTMLElement).closest(
          '#training-exit, [data-training-kind], .training-actions button',
        )
      ) return;
      if (
        this.selected.id !== 'interferencia' ||
        !this.mission?.shortcut ||
        this.awaitingAdvance ||
        this.finished
      ) return;
      if (this.mission.node().attentionCue === 'approach') return;
      const resolution = this.mission.shortcut('clique');
      this.suppressPointerUntil = performance.now() + 900;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (resolution) this.showResolution(resolution, null);
    }, true);
    for (const eventName of ['pointerup', 'click', 'contextmenu'] as const) {
      this.root.addEventListener(eventName, (event) => {
        if (performance.now() > this.suppressPointerUntil) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (eventName === 'click' || eventName === 'contextmenu') this.suppressPointerUntil = 0;
      }, true);
    }

    this.paintLesson();
  }

  open(): void {
    this.root.hidden = false;
    document.body.classList.add('show-cursor');
    this.showLesson();
  }

  close(): void {
    this.root.hidden = true;
    this.mission = null;
    this.awaitingAdvance = false;
    this.inspection.hidden = true;
    this.lastAttentionCue = null;
    document.body.classList.remove('show-cursor');
  }

  update(dt: number): void {
    if (!this.mission?.live || this.finished) return;
    // A demonstração existe para aprender a linguagem sem punição. A prática
    // real conserva exatamente o contrato da campanha e nunca recebe pausa.
    if (
      this.guided &&
      this.selected.id === 'labirinto' &&
      this.mission.node().options.length > 0
    ) return;
    if (!this.pulse.hidden) {
      this.pulseLeft = Math.max(0, this.pulseLeft - dt);
      this.pulseBar.style.transform = `scaleX(${this.pulseLeft / this.pulseTotal})`;
    }
    const update = this.mission.update?.(dt);
    if (update?.resolution) {
      this.showResolution(update.resolution, null);
    } else if (update?.changed && !this.awaitingAdvance) {
      this.paintNode(false);
    }
  }

  /** Teclas de conveniência da sala; devolve true quando consumiu o evento. */
  key(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!this.practice.hidden) this.showLesson();
      else this.exit();
      return true;
    }

    if (this.practice.hidden) return false;
    const meta = event.ctrlKey || event.metaKey;
    if (meta && (event.key === 'r' || event.key === 'R')) {
      if (!event.repeat) this.start(this.guided);
      return true;
    }
    if (meta && (event.key === 'd' || event.key === 'D')) {
      if (!event.repeat) this.hint();
      return true;
    }
    // Teclas modificadoras são apenas o prefixo dos metacomandos acima. Sem
    // esta exceção, o keydown de Control erraria a trava antes de Ctrl+D/R.
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return true;

    if (
      this.selected.id === 'interferencia' &&
      this.mission?.shortcut &&
      !this.awaitingAdvance &&
      !this.finished
    ) {
      // Uma tecla iniciada antes do clarão não pode matar o jogador só porque
      // o sistema operacional gerou autorepeat depois da mudança de fase.
      if (event.repeat) return true;
      const resolution = this.mission.shortcut(event.key);
      if (resolution) this.showResolution(resolution, null);
      return true;
    }
    if ((event.key === 'Enter' || event.key === ' ') && this.awaitingAdvance) {
      event.preventDefault();
      this.advance();
      return true;
    }

    const labShortcut =
      this.selected.id === 'labirinto' && ['0', 'w', 'a', 's', 'd'].includes(event.key.toLowerCase());
    if (labShortcut && event.repeat) return true;
    if (
      !event.repeat &&
      this.mission?.shortcut &&
      (this.selected.id === 'interferencia' || labShortcut || event.key === '0')
    ) {
      const resolution = this.mission.shortcut(event.key);
      if (resolution) this.showResolution(resolution, null);
      return true;
    }

    const n = Number(event.key);
    if (Number.isInteger(n) && n >= 1) {
      // Segurar um número não deve confirmar a mesma posição novamente
      // depois que um exercício vivo redesenhar ou avançar o painel.
      if (event.repeat) return true;
      const node = this.mission?.node();
      const option = node?.options[n - 1];
      if (option) {
        this.choose(option.id);
        return true;
      }
    }
    return false;
  }

  private select(id: string): void {
    const kind = this.kinds.find((candidate) => candidate.id === id);
    if (!kind) return;
    this.selected = kind;
    this.guided = false;
    this.showLesson();
  }

  private paintLesson(): void {
    const sample = this.selected.create(this.seed(0), -1);
    const lesson = LESSONS[this.selected.id]!;
    this.lessonName.textContent = sample.name;
    this.eyebrow.textContent = lesson.eyebrow;
    this.summary.textContent = lesson.summary;
    this.steps.innerHTML = lesson.steps.map((step) => `<li>${step}</li>`).join('');
    this.watch.textContent = lesson.watch;
    this.rules.innerHTML = sample.howTo;

    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-training-kind]')) {
      button.classList.toggle('active', button.dataset.trainingKind === this.selected.id);
    }
  }

  private showLesson(): void {
    this.mission = null;
    this.awaitingAdvance = false;
    this.finished = false;
    this.inspection.hidden = true;
    delete this.inspection.dataset.stage;
    this.lastAttentionCue = null;
    this.practice.hidden = true;
    this.lesson.hidden = false;
    this.paintLesson();
  }

  private realDifficulty(): number {
    switch (this.selected.id) {
      case 'labirinto': return 0.55;
      case 'purga': return 0.85;
      case 'codigo': return 0.95;
      case 'interferencia': return 0.65;
      default: return 0.6;
    }
  }

  private start(guided = false): void {
    this.attempt++;
    this.guided = guided;
    this.mission = this.selected.create(
      this.seed(this.attempt),
      guided ? -1 : this.realDifficulty(),
    );
    this.awaitingAdvance = false;
    this.finished = false;
    this.hintLevel = 0;
    this.lastAttentionCue = null;
    this.suppressPointerUntil = 0;
    this.lesson.hidden = true;
    this.practice.hidden = false;
    this.state.textContent = guided
      ? this.selected.id === 'labirinto'
        ? 'DEMONSTRAÇÃO GUIADA · DECISÕES PAUSAM'
        : 'DEMONSTRAÇÃO GUIADA · SEM PUNIÇÃO'
      : 'SIMULAÇÃO REAL · SEM ESTEIRA';
    this.advanceBtn.hidden = true;
    this.paintNode(true);
  }

  private paintNode(clearFeedback: boolean): void {
    if (!this.mission) return;
    const node = this.mission.node();
    this.missionName.textContent = this.mission.name;
    this.nodeLabel.textContent = node.nodeLabel;
    this.syncAttention(node.attentionCue ?? null);
    this.pulse.hidden = !node.continuous;
    if (node.continuous) {
      this.pulseTotal = Math.max(0.1, node.continuousTotal ?? node.timeLimit);
      this.pulseLeft = Math.max(0, Math.min(this.pulseTotal, node.timeLimit));
      this.pulseBar.style.transform = `scaleX(${this.pulseLeft / this.pulseTotal})`;
    }
    this.body.innerHTML = node.bodyHtml;
    this.prompt.textContent = node.prompt;
    const currentOptions = Array.from(
      this.options.querySelectorAll<HTMLButtonElement>('button[data-option]'),
    )
      .map(
        (button) =>
          `${button.dataset.option ?? ''}\u0000${button.querySelector('span')?.textContent ?? ''}`,
      )
      .join('\u0001');
    const nextOptions = node.options
      .map((option) => `${option.id}\u0000${option.label}`)
      .join('\u0001');

    // O mapa/status de uma missão viva pode mudar sem a superfície de ação
    // mudar. Preservar os mesmos botões evita cancelar hover/pointer e foco.
    if (currentOptions !== nextOptions) {
      this.options.innerHTML = '';
      node.options.forEach((option, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.option = option.id;
        const key = document.createElement('b');
        key.textContent = `[${index + 1}]`;
        const label = document.createElement('span');
        label.textContent = option.label;
        button.append(key, label);
        this.options.append(button);
      });
    }

    if (clearFeedback) {
      this.hintLevel = 0;
      this.feedback.textContent = this.guided
        ? 'Demonstração segura. As explicações aparecem depois da sua ação.'
        : 'Mesmas regras da campanha, sem esteira. [CTRL+D] oferece ajuda gradual.';
      this.feedback.className = '';
    }
  }

  private choose(id: string | null): void {
    if (!this.mission || this.awaitingAdvance || this.finished) return;
    const resolution = this.mission.choose(id);
    this.hintLevel = 0;
    this.showResolution(resolution, id);
  }

  private showResolution(resolution: Resolution, picked: string | null): void {
    if (!this.mission) return;
    if (resolution.finished && this.mission.live) this.paintNode(false);
    const best = resolution.bestOptionId ?? null;
    for (const button of this.options.querySelectorAll<HTMLButtonElement>('button[data-option]')) {
      button.disabled = !this.mission.live || resolution.finished;
      button.classList.toggle('picked', button.dataset.option === picked);
      button.classList.toggle('best', best !== null && button.dataset.option === best);
    }

    this.feedback.innerHTML = resolution.feedback;
    this.feedback.className =
      resolution.verdict === 'GOOD' ? 'good' : resolution.verdict === 'NEUTRAL' ? '' : 'bad';
    if (resolution.verdict === 'GOOD') this.audio.good();
    else if (resolution.verdict === 'BAD' || resolution.verdict === 'FATAL') this.audio.bad();
    else this.audio.beep(620, 0.045, 0.035);

    if (resolution.finished) {
      this.finished = true;
      this.awaitingAdvance = true;
      this.state.textContent = resolution.success
        ? 'EXERCÍCIO CONCLUÍDO · NENHUMA CHAVE CONCEDIDA'
        : 'FALHA DE TREINO · SEM PUNIÇÃO';
      this.advanceBtn.textContent = 'TENTAR NOVAMENTE';
      this.advanceBtn.hidden = false;
      return;
    }

    if (this.mission.live) {
      // Ordens de rádio não são turnos: o exercício continua correndo.
      this.paintNode(false);
      return;
    }

    this.awaitingAdvance = true;
    this.advanceBtn.textContent = 'CONTINUAR';
    this.advanceBtn.hidden = false;
  }

  private syncAttention(cue: ReturnType<Mission['node']>['attentionCue'] | null): void {
    if (cue) this.pulse.dataset.stage = cue;
    else delete this.pulse.dataset.stage;
    this.pulseLabel.textContent = cue === 'lock'
      ? 'TEMPO PARA DIGITAR'
      : cue === 'approach'
        ? 'PASSOS SE APROXIMANDO'
        : cue === 'watch'
          ? 'PERMANEÇA IMÓVEL'
          : cue === 'clear'
            ? 'AGUARDE LIBERAÇÃO'
            : 'PRÓXIMA AÇÃO AUTÔNOMA';

    const inspectionStage = cue === 'approach' || cue === 'watch' || cue === 'clear';
    this.inspection.hidden = !inspectionStage;
    if (inspectionStage) this.inspection.dataset.stage = cue;
    else delete this.inspection.dataset.stage;

    if (cue === this.lastAttentionCue) return;
    this.lastAttentionCue = cue;
    if (cue === 'lock') this.audio.alarm();
    else if (cue === 'approach') this.audio.crackle();
    else if (cue === 'watch') this.audio.beep(185, 0.12, 0.075);
    else if (cue === 'clear') this.audio.beep(720, 0.045, 0.035);
  }

  private advance(): void {
    if (!this.mission || !this.awaitingAdvance) return;
    if (this.finished) {
      this.start(this.guided);
      return;
    }
    this.awaitingAdvance = false;
    this.advanceBtn.hidden = true;
    this.paintNode(true);
  }

  private hint(): void {
    if (!this.mission || this.awaitingAdvance || this.finished) return;
    if (this.selected.id === 'interferencia') {
      const body = this.mission.node().bodyHtml;
      this.feedback.textContent = body.includes('TRAVA DE SEGURANÇA')
        ? 'DICA: digite toda a sequência mostrada, da esquerda para a direita. Qualquer outra entrada reinicia esta trava.'
        : body.includes('LUZ BRANCA')
          ? 'DICA: a ordem no painel é uma isca. Não pressione tecla nem clique até a luz desaparecer.'
          : body.includes('PASSOS SE APROXIMANDO')
            ? 'DICA: os passos são a preparação. Pare somente quando o clarão branco tomar a cabine.'
            : body.includes('LUZ ESTÁ RECUANDO')
              ? 'DICA: aguarde a liberação completa; este breve recuo ainda bloqueia a entrada.'
              : 'DICA: confirme a leitura indicada e prepare-se para identificar qual ameaça tomou o painel.';
      this.feedback.className = 'hint-text';
      return;
    }
    const best = this.mission.peekBest();
    const buttons = Array.from(this.options.querySelectorAll<HTMLButtonElement>('button[data-option]'));
    const button = buttons.find((candidate) => candidate.dataset.option === best);
    if (!button) return;
    this.hintLevel++;
    const eliminable = buttons.filter(
      (candidate) => candidate !== button && !candidate.classList.contains('eliminated'),
    );
    if (this.hintLevel < 3 && eliminable.length) {
      eliminable[eliminable.length - 1]!.classList.add('eliminated');
      this.feedback.textContent =
        `AJUDA ${this.hintLevel}/3: o diagnóstico eliminou uma alternativa incompatível. ` +
        'Cruze novamente as informações antes de pedir outra pista.';
    } else {
      button.classList.add('hint');
      this.feedback.textContent = 'AJUDA 3/3: a alternativa contornada é a recomendação do simulador.';
    }
    this.feedback.className = 'hint-text';
  }

  private exit(): void {
    this.close();
    this.onExit();
  }

  private seed(salt: number): number {
    const code = this.selected.id.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return ((code * 7919) ^ (salt * 104729) ^ 0x51a7) & 0x7fffffff;
  }
}
