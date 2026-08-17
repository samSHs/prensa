# PRENSA

Jogo web de terror psicológico. Você acorda amarrado numa esteira industrial.
À sua frente, uma prensa hidráulica bate em ciclo. À sua direita, um terminal.
Vinte e seis metros atrás, uma escotilha presa por quatro ferrolhos.

A esteira nunca para. O cronômetro nunca para. Ninguém vem.

```bash
npm install
npm run dev
```

Para playtests em outro Windows, use os executáveis prontos de `release/`:
o instalador cria atalhos; o portátil abre sem instalar nada. O computador de
teste não precisa de Node, npm, terminal, internet ou WebView2.

---

## A estética: 3D de verdade, rasterizado em ASCII

A cena é Three.js real — prensa, esteira, corpo, cabine, faíscas, névoa,
iluminação. Ela é renderizada num alvo minúsculo (exatamente 2× a grade de
caracteres) e passa por um shader que:

1. amostra 2×2 por célula da grade (1 leitura em modo desempenho);
2. roda **Sobel** sobre a luminância das 8 células vizinhas, 1 leitura cada;
3. onde há aresta forte, desenha um glifo orientado — `-` `/` `|` `\` —
   o que dá **contorno** às formas no escuro;
4. onde não há, escolhe um glifo da rampa de densidade (` .':;~=+cox*%&#@`);
5. tinge com fósforo âmbar, deixando o vermelho da prensa e o ciano da
   escotilha atravessarem, e soma scanline, flicker de rede, aberração
   cromática e glitch proporcional ao perigo.

Não é filtro de ASCII art colado por cima: é a resolução nativa do jogo.
Efeito colateral: a coisa toda roda a centenas de quadros por segundo.

O atlas de glifos é desenhado em `<canvas>` em runtime. Zero assets externos.
Zero arquivos de áudio — tudo é WebAudio sintetizado (zumbido da esteira,
engate hidráulico, batida com ressonância de aço, coração, sussurros, e a
"fala" do Zelador).

---

## O Zelador

O sequestrador fala por alto-falantes enferrujados e aparece como uma
silhueta na janela acesa da cabine: casaco longo, máscara de gás com filtro,
aba de chapéu, duas lentes que refletem. Ele acompanha você com a cabeça.

Ele nunca grita. Fala como quem preenche formulário — e é isso que incomoda:

> *"Você foi escolhido por dois motivos: morava perto do galpão, e ninguém
> vai notar que você sumiu antes de terça-feira."*

Conforme o jogo aperta, a máscara pisca em **4 quadros** no meio da tela, o
suficiente para você não ter certeza de que viu.

---

## Aprender fora, sobreviver dentro

O menu inicial possui uma sala de **TREINAMENTO** separada da campanha. Cada
protocolo tem resumo, manual completo e dois modos: **DEMONSTRAÇÃO GUIADA**,
com sinais mais longos e explicações depois da ação, e **SIMULAÇÃO REAL**, com
as regras e a dificuldade da campanha, mas sem esteira:

- Labirinto em tempo real; na demonstração as decisões pausam, enquanto a
  simulação real mantém vítima e caçador ativos;
- PURGA por leitura real do fluxo, sem rótulo ou previsão da resposta;
- Código Morto com programação da sequência inteira antes da execução;
- Interferências em três provas: trava, imobilidade com isca e prova mista,
  reproduzindo o clarão, a silhueta e os sinais sonoros da campanha.

Treinar não move a esteira, concede chaves ou registra erros. É possível pedir
uma dica, reiniciar e trocar de protocolo livremente.

Depois de pressionar **JOGAR**, o jogo não abre cartões, manuais ou ajuda. A
campanha começa direto pelo rádio e mantém a imersão. A PURGA também esconde o
oráculo: não revela a melhor válvula nem colore opções como resposta certa.

Antes de cada missão, o receptor encontra **duas transmissões** de tipos
distintos. O painel informa perigo, janela estimada e qualidade do sinal; o
jogador decide qual atender. A primeira missão escolhida inteira continua
protegida de trava e inspeção. No labirinto, objetivo e rumo aparecem com
precisão no começo; mais tarde, números viram setores e faixas
`PERTO`/`LONGE`, enquanto a cobertura de câmeras encolhe.

Quatro missões bem-sucedidas liberam os quatro ferrolhos da escotilha. Existe
uma rota mais rápida: segurar `[0]` durante a varredura arranca uma chave e sela
uma das pessoas do outro lado. A esteira acelera permanentemente e o final
muda. Chegar à escotilha antes de quatro chaves só faz o corpo bater nas
travas.

## A morte

Tinha um bug que estragava o clímax: o impacto disparava em `phase 0.72` mas
o martelo só chegava embaixo em `0.78`. O estrondo e a morte aconteciam com a
massa ainda no alto — e como a morte congelava o ciclo, o martelo ficava
pendurado no ar. A curva do êmbolo agora é medida **a partir** do instante do
impacto: `p = 0` é o fundo.

A morte do jogador virou uma cena de ~3,4 s dirigida por quadro: o martelo desce e
**fica** (peso parado vende mais que queda), a câmera larga o enquadramento e
cai em cima da bigorna, a tela lava de vermelho por 1,4 s, o glitch vai ao
máximo, e o som é um golpe em quatro camadas — sub descendo a 12 Hz,
esmagamento de chapa por passa-baixa despencando, um estalo curto e molhado, e
cauda longa de aço. Depois o mixer é abafado a 5% por dois segundos: o
silêncio é o que faz o som anterior parecer grande.

A morte da refém tem outra assinatura: grito saturado no rádio, impacto no
microfone, estática e corte seco. Só depois o Zelador comenta.

As outras falhas fatais também ganharam corpo próprio. Uma ruptura hidráulica
produz golpe grave, metal cedendo, clarão laranja e vapor longo; a terceira
carga dos fios dispara arco irregular, estrobos frios e tremor forte. Não são
o mesmo bipe vermelho reaproveitado para três mortes diferentes.

## Desempenho

O custo do jogo não é a cena 3D — ela é renderizada num alvo minúsculo. É o
passe ASCII, que roda em cada pixel da tela.

**Correção que beneficia todo mundo:** o Sobel amostrava 4 texels por vizinho,
9 vizinhos = **36 leituras de textura por pixel**. Os vizinhos agora usam 1
leitura cada: **12 por pixel**, 3× mais barato, sem diferença visível.

**Modo desempenho** (`P`, ou automático): sem Sobel, sem supersample, sem
aberração cromática, buffer a 70% da tela (**51% menos pixels**) e sem
poeira/faíscas. A grade de caracteres não muda de tamanho — o layout é
idêntico, só rasterizado em menos pixels e esticado.

O detector mede a **mediana** de 90 quadros e liga o modo leve sozinho abaixo
de ~38 fps. Mediana, não média: um travamento de GC não deve rebaixar a
máquina inteira.

## As missões — o desenho

Sua ideia (minimapa + labirinto + assassino) virou a missão principal, mas
com um enquadramento que resolve o problema que você não estava conseguindo
fechar: **quem é você nessa cena?**

A resposta é o que faz a mecânica funcionar: **você não controla a pessoa.**
Você é o operador da CFTV, e ela tem um fone no ouvido. Sua ordem vira uma
intenção persistente; ela e o caçador continuam andando enquanto você pensa.
Isso resolve tudo de uma vez:

- justifica o minimapa (você vê câmeras, ela vê o corredor à frente);
- justifica o formato "pergunta + alternativas" (são ordens de rádio);
- justifica a continuidade (o estado do labirinto persiste entre nós);
- e cria a segunda camada de horror: **a culpa**. Se ela morre, morreu
  porque *você* falou a coisa errada. Enquanto isso a sua esteira anda.

### 1. O LABIRINTO — simulação, não roteiro

Nada é escrito à mão. O labirinto é gerado (backtracker recursivo + laços
extras: labirinto perfeito é armadilha mortal, sem ciclos não existe evasão),
e o caçador é uma máquina de estados honesta:

| estado | comportamento |
| --- | --- |
| `PATRULHA` | anda até um ponto aleatório, na sua velocidade |
| `INVESTIGA` | vai até o último ruído; chegando, revista o armário embaixo do nariz |
| `CAÇA` | persegue **enquanto tem contato visual** |
| `PROCURA` | perdeu a refém, varre o último setor e pode inspecionar armários próximos antes de desistir |

Ele **não é onisciente**. Quebrar linha de visada funciona.

Vítima e caçador têm relógios independentes. Uma direção move a vítima
**imediatamente** e ela percorre retas e curvas obrigatórias aproximadamente a
cada 0,5 s. Só devolve a decisão numa bifurcação real, beco, chave, saída,
armário ou contato visual. Durante o corredor não existe lista para perseguir;
quando ela para, a fotografia de comandos fica congelada enquanto somente o
mapa e o caçador continuam vivos.

Os IDs agora são semânticos (`MOVE:NORTE`, `LURE:F1`) e nunca posicionais como
`c0`. `W/A/S/D` transmitem direções fixas, além do clique e dos números. Um
armário só oferece “ENTRE” quando ela realmente está em cima de `A1`/`A2`;
telefones usam no botão o mesmo `F1`/`F2` desenhado na planta. A barra do
terminal mede a próxima ação do caçador, não o passo da vítima.

Ordens contraditórias ou exposições evitáveis quebram confiança. Primeiro ela
hesita; no limite, recusa uma ordem arriscada. Não é sorte: o estado
`CONFIA`/`TREMENDO`/`NÃO RESPONDE` e a fala dela explicam a causa.

Cada nova ordem de voz deixa uma amostra espacial `△` durante seis segundos.
Duas amostras triangulam o **último ponto transmitido** e fazem o caçador
investigá-lo; isso nunca cria `CAÇA` sem contato visual. `[0]` corta apenas o
TX: a refém continua a intenção ativa, o retorno e o grito permanecem audíveis,
e dois segundos completos de silêncio limpam as amostras. Repetição, telefone
e luz não geram rastro de rádio.

**Como o teste sabe qual é a rota especialista:** ele simula. Cada alternativa
é clonada, executada e pontuada por progresso, distância ao caçador e estado de
caça. A campanha não imprime esse oráculo nem diz “era SIGA...”: apresenta
todas as direções fisicamente possíveis, os telefones restantes e um único
disjuntor contextual. O oráculo existe apenas no balanceamento e nas dicas do
treinamento.

O que você vê é só o que você sabe: setor sem energia não mostra o piso, e o
caçador só aparece se alguma câmera ou a própria refém o enxergar. Fora isso
sobra o `?`, a última posição confirmada, envelhecendo. **A cobertura de
câmeras encolhe com a dificuldade** — é assim que o jogo deixa de ser tático
e vira aposta.

### 2. PROTOCOLO DE PURGA — rede de pressão

A prensa que vai te matar é alimentada por uma rede hidráulica, e você tem o
painel. Fechar tudo não resolve: pressão que não escoa arrebenta o nó onde
ficou presa, e ruptura encerra a missão. É um DAG com capacidades sorteadas;
a geração resolve **todas as 2¹⁵ configurações**, então o jogo conhece
exatamente o conjunto de estados de vitória e mede cada manobra pela
distância de Hamming até o mais próximo.

Nenhum botão prevê o futuro. Ele mostra somente a ação, o estado atual da
válvula e a carga/capacidade dos dois nós conectados. O jogador precisa seguir
o fluxo desde a FONTE e preservar uma rota de alívio antes de cortar um ramo.
O relatório **posterior** explica a consequência observada, mas nunca destaca
a próxima resposta. A demonstração possui um fusível que desfaz a primeira
ruptura; a simulação real não possui essa proteção.

### 3. CÓDIGO MORTO — dedução pura

Caixa de junção, fios sem etiqueta, uma ordem de corte secreta. O painel dá
leituras verdadeiras, e o gerador só entrega o enigma quando o conjunto de
leituras admite **exatamente uma** permutação (verificado por força bruta
sobre todas as permutações, depois podado). Sempre dá para deduzir.

A primeira caixa real já tem cinco fios; depois entram seis. Nenhuma leitura
real diz “X é o primeiro”, no máximo uma usa adjacência dirigida, e o gerador
rejeita enigmas em que uma única pista entregue o primeiro ou o segundo slot.
Entram relações de ponta, paridade, intervalo, posição entre dois fios e XOR,
sempre explicadas na própria frase.

O jogador monta a fila inteira sem receber confirmação e só então escolhe
**EXECUTAR**. Uma fila incompatível mostra até duas leituras violadas, é
apagada e soma carga — nunca revela “era o fio X”. A terceira execução errada
encerra a missão. O ruído tardio continua decorativo e estável.

---

## A pressão

Você pediu *Welcome to the Game 2*: medo por pressão, não por dificuldade
artificial. O que produz isso aqui:

**A esteira acelera sozinha, para sempre.** Jogar seguro é matematicamente
impossível. Só existe jogar rápido e certo.

**Acerto compra segundos, não velocidade.** Cada acerto injeta uma inversão
que *decai*. No labirinto, trocar ordens não rende nada: o crédito só chega
quando a refém realmente encurta a rota, pega a chave ou quebra uma perseguição.

**Erro tira metros e acelera a base.** Uma falha final não cobra a mesma
penalidade duas vezes.

**Bônus de velocidade.** A distância ganha depende de quanto tempo sobrava no
cronômetro. Ler com calma é uma decisão cara. Sequências de acertos rendem
multiplicador — é a válvula de escape que mantém o jogo vencível.

**Trava de segurança (a peça central).** No meio da leitura do mapa, o painel
exige 2, 3 ou 4 teclas em 2,2–3,0 segundos. Você larga o raciocínio,
executa, e volta antes do cronômetro estourar. Atenção dividida: nada aqui é
difícil sozinho.

**Diretor de tensão.** `CALMA → SUSPEITA → CERCO → ALÍVIO` forma ondas
determinísticas. O diretor mede perseguição, relógio, próxima batida, fala e
perigo antes de gastar um evento. A primeira missão é protegida; perto da
morte, a própria prensa já basta e o diretor recua. O caos tardio pode
sobrepor sistemas, mas dentro de um orçamento explícito.

**Inspeção inversa.** Passos e a silhueta anunciam a aproximação. Quando a
cabine fica branca, qualquer tecla de jogo ou clique falha: a resposta certa é
ficar imóvel. Ela só aparece depois de duas missões, tem 42 s de intervalo e
ocorre no máximo duas vezes por partida.

**Entrada exclusiva.** Enquanto trava ou inspeção controlam a cabine, números
e cliques não atravessam até a missão. Isso corrige o antigo atalho de responder
o terminal para cancelar uma trava aberta.

**Quatro chaves separam sobrevivência de vitória.** A distância ainda é sua
vida, mas não encerra a campanha sozinha. A escotilha bloqueia o corpo, elimina
o impulso armazenado e só abre depois de quatro objetivos completos.

**O ciclo da prensa encurta** conforme o perigo e as missões concluídas sobem
— de 5,0 s para 1,85 s entre batidas.

**Nada pausa.** Nem o discurso do Zelador, nem o feedback da resposta, nem a
troca de missão.

Existe uma rede de segurança discreta: colado na prensa, um acerto vale mais.
Nunca é anunciada.

---

## Balanceamento verificado

`_selftest.ts` (fora do `src`, não entra no build) joga centenas de partidas
por missão e por faixa de dificuldade, comparando um **operador perfeito**
(sempre a melhor alternativa segundo o próprio oráculo do jogo) contra
**escolhas aleatórias**. Duas invariantes:

- jogo perfeito tem que **vencer quase sempre** — senão o jogo é injusto;
- jogo aleatório tem que **perder quase sempre** — senão as alternativas não
  importam.

```bash
npm run balance
```

Resultado atual (60 partidas por linha, RNG determinístico):

| missão | dificuldade | jogo perfeito | jogo aleatório |
| --- | --- | --- | --- |
| LABIRINTO | 0.0 | **93%** | 3% |
| LABIRINTO | 0.6 | **90%** | 3% |
| LABIRINTO | 1.2 | **78%** | 2% |
| LABIRINTO | 1.8 | **63%** | 5% |
| PURGA | 0.0 – 1.6 | **100%** | 0–27% |
| CÓDIGO MORTO | 0.0 – 2.2 | **100%** | 0–2% |

A integração também é testada: em 40 primeiras missões vivas, o perfil
especialista — incluindo o corte tático do TX — manteve o jogador vivo em
**80%**, resgatou a refém em **50%** e permaneceu no cenário por **32,2 s em
média**. O teste exige uma faixa de
25–42 s para impedir tanto correria ilegível quanto a antiga espera. A
escotilha é verificada trancada e destrancada no mesmo harness.

### Seis bugs que mudaram o desenho

Nenhum destes aparecia olhando a tela. Todos tornavam o jogo **injusto**:

1. **Fuga antes do resgate.** A mesma distância era vida e campanha; seis
   respostas rápidas cruzavam a escotilha no meio do primeiro labirinto. Agora
   quatro sucessos liberam quatro ferrolhos.
2. **Caçador congelado e vítima lenta.** Primeiro a simulação só avançava no
   clique; depois ambos esperavam o mesmo pulso de até 3,6 s. Agora usam
   relógios independentes, a primeira passada é imediata e corredores são
   atravessados sem repetir a ordem.
3. **Fio corrigido por tentativa.** Validar cada corte revelava a sequência
   passo a passo. Agora nenhum fio é tocado durante a programação; só a fila
   inteira é julgada, e uma rejeição informa conflitos sem revelar a resposta.
4. **PURGA entregando a própria solução.** A heurística priorizava pressão
   instantânea e o painel ainda imprimia `AVANÇA` e `PRENSA antes→depois` antes
   da escolha. A distância BFS segura continua garantindo solução, mas o
   jogador vê somente o estado atual; causalidade aparece apenas depois.
5. **Trava cancelada por número/clique.** A trava ignorava dígitos; responder a
   missão colocava o terminal em feedback e cancelava o QTE sem punição. O
   controlador de atenção agora captura a entrada inteira até resolver.
6. **Alternativa mudando sob o cursor.** Cada passo do caçador reconstruía e
   embaralhava a lista; numa simulação com 700 ms de reação, 40,5% dos cliques
   chegavam a um texto diferente. Agora cada decisão é um snapshot com IDs
   semânticos; mapa vivo nenhum pode renomear a ordem capturada no pointerdown.

### Verificação no navegador

```bash
npm run smoke
```

Sobe o Vite, abre o Chrome headless com WebGL (SwiftShader), joga sozinho e
captura `_shot-*.png`: título, seleção de treinamento, prática, retorno ao
título, campanha, morte e fuga. Falha se houver erro de página, requisição
quebrada ou erro de shader.

---

## Distribuição Windows

```bash
npm run package:win
```

O comando compila, gera o ícone, empacota fora de `Documents` para evitar
bloqueios do Windows Defender, abre silenciosamente o executável produzido e
confirma HTML, JavaScript e WebGL. Depois grava em `release/`:

- `PRENSA-Instalador-0.1.0-x64.exe` — assistente por usuário, com atalhos;
- `PRENSA-Portatil-0.1.0-x64.exe` — copiar e abrir, sem instalação;
- `COMO-TESTAR.txt` — instruções para o playtester;
- `SHA256SUMS.txt` — hashes dos dois executáveis.

O portátil mostra um splash nativo enquanto extrai o Chromium e usa o modo
ZIP/zlib do NSIS para reduzir essa espera. A primeira abertura ainda pode ser
alongada pela análise do Windows Defender; o instalador é a opção mais rápida
para várias partidas no mesmo computador.

Os artefatos incluem Chromium e funcionam offline. Por ainda não possuírem
certificado comercial, podem exibir “Editor desconhecido” no SmartScreen; um
certificado de assinatura de código é necessário para remover esse aviso.

---

## Controles

`1`…`9` respondem · `W/A/S/D` transmitem direções fixas no labirinto
teclas em vermelho confirmam a trava
`0` corta/reabre o TX no labirinto · segurar `0` na varredura arranca uma chave
`ENTER` avança a fala da abertura · `ESC` pula a abertura inteira
`M` silencia · `P` alterna o modo desempenho · `F11` alterna tela cheia no app

No treinamento: `CTRL+D` mostra dica, `CTRL+R` reinicia e `ESC` volta ao manual/menu.

Fones de ouvido são recomendados. Nenhum áudio toca antes do primeiro clique.

### A abertura encolhe sozinha

Num jogo que mata rápido, obrigar a ouvir o mesmo discurso a cada morte é
castigo errado. Além do skip, o Zelador **não repete o discurso**: a cada
partida nova ele entrega menos, até sobrar uma palavra.

| partida | o que ele diz |
| --- | --- |
| 1ª | as nove frases |
| 2ª | *"Você de novo. A esteira foi rebobinada enquanto você não estava aqui."* |
| 3ª | *"Segunda vez que eu lavo essa linha hoje." / "Vá."* |
| 4ª | *"Não vou explicar de novo."* |
| 5ª+ | *"Já."* |

Sai mais rápido do que pular, e ainda é conteúdo.

---

## Estrutura

```
src/
  render/   fontAtlas · asciiPass (o shader) · renderer
  world/    world.ts — geometria do abatedouro, o Zelador na cabine
  game/     belt · audio · voice · director (ondas/orçamento) · interrupts
  missions/ types · registry
            labyrinth/ maze+sim · render (planta ASCII) · mission
            valves.ts · wires.ts · interference (prática segura)
  ui/       terminal · treinamento · hud · mask (arte ASCII)
  core/     rng determinístico e serializável
  main.ts   máquina de estados, balanço, efeitos
```

`electron/main.cjs` contém a janela desktop segura; `scripts/` gera ícone,
empacota os dois formatos e produz o manifesto de playtest.

O RNG é serializável de propósito: as missões precisam ser simuladas para
frente e voltar ao estado anterior, então o acaso mora dentro do estado.
