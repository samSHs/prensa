import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1280,760',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });

const errors = [];
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto('http://localhost:5199/?debug', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1500));

const shot = async (name) => {
  await page.screenshot({ path: `_shot-${name}.png` });
  console.log(`  captura _shot-${name}.png`);
};
const trainingOnly = process.argv.includes('--training-only');

// --- tela de titulo
await shot('1-titulo');

// --- sala de treinamento: abre, escolhe uma prática e volta sem iniciar campanha
await page.evaluate(() => document.querySelector('#screen-training').click());
await new Promise((r) => setTimeout(r, 500));
const treino = await page.evaluate(() => ({
  visivel: !document.querySelector('#training').hidden,
  missoes: document.querySelectorAll('[data-training-kind]').length,
  titulo: document.querySelector('#training-name')?.textContent,
  fase: window.prensa.debug().phase,
}));
await shot('8-treinamento');
await page.evaluate(() => document.querySelector('#training-start').click());
await new Promise((r) => setTimeout(r, 600));
const pratica = await page.evaluate(() => ({
  visivel: !document.querySelector('#training-practice').hidden,
  opcoes: document.querySelectorAll('#t-m-options button').length,
  estado: document.querySelector('#t-m-state')?.textContent,
}));
await shot('12-treino-pratica');

// O mapa vivo pode redesenhar dezenas de vezes; a mão de comandos não pode
// mudar nem perder os próprios elementos enquanto a vítima espera uma ordem.
await page.evaluate(() => {
  window.__labOptionNodes = Array.from(document.querySelectorAll('#t-m-options button'));
  window.__labOptionSignature = window.__labOptionNodes
    .map((button) => `${button.dataset.option}\u0000${button.textContent}`)
    .join('\u0001');
});
await new Promise((r) => setTimeout(r, 1250));
const labInput = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll('#t-m-options button'));
  const signature = nodes.map((button) => `${button.dataset.option}\u0000${button.textContent}`).join('\u0001');
  return {
    assinaturaEstavel: signature === window.__labOptionSignature,
    mesmosElementos:
      nodes.length === window.__labOptionNodes.length &&
      nodes.every((button, index) => button === window.__labOptionNodes[index]),
    idsSemanticos: nodes.every((button) => !/^c\d+$/.test(button.dataset.option ?? '')),
  };
});
if (!labInput.assinaturaEstavel || !labInput.mesmosElementos || !labInput.idsSemanticos) {
  errors.push(`input mutável no labirinto: ${JSON.stringify(labInput)}`);
}

// A demonstração é a única variante que pausa numa decisão; a prática real
// acima continuou atualizando o mapa e o caçador.
await page.evaluate(() => document.querySelector('#training-menu').click());
await page.evaluate(() => document.querySelector('#training-guided').click());
await new Promise((r) => setTimeout(r, 250));
const guidedBefore = await page.evaluate(() => ({
  corpo: document.querySelector('#t-m-body')?.innerHTML,
  no: document.querySelector('#t-m-node')?.textContent,
  estado: document.querySelector('#t-m-state')?.textContent,
}));
await new Promise((r) => setTimeout(r, 1100));
const guidedAfter = await page.evaluate(() => ({
  corpo: document.querySelector('#t-m-body')?.innerHTML,
  no: document.querySelector('#t-m-node')?.textContent,
}));
const guidedPaused =
  guidedBefore.corpo === guidedAfter.corpo &&
  guidedBefore.no === guidedAfter.no &&
  /DECISÕES PAUSAM/.test(guidedBefore.estado ?? '');
if (!guidedPaused) errors.push('demonstração do labirinto não pausou a decisão');

// A PURGA foi o ponto de confusão do playtest: prova que nem a simulação de
// treino imprime os antigos rótulos-resposta ou uma previsão antes da ação.
await page.evaluate(() => document.querySelector('#training-menu').click());
await page.evaluate(() => document.querySelector('[data-training-kind="purga"]').click());
await new Promise((r) => setTimeout(r, 250));
await shot('13-treino-purga-manual');
await page.evaluate(() => document.querySelector('#training-start').click());
await new Promise((r) => setTimeout(r, 350));
const purgaTreino = await page.evaluate(() => ({
  titulo: document.querySelector('#t-m-title')?.textContent,
  prompt: document.querySelector('#t-m-prompt')?.textContent,
  opcoes: Array.from(document.querySelectorAll('#t-m-options button')).map((el) => el.textContent),
}));
await shot('14-treino-purga-pratica');
await page.evaluate(() => document.querySelector('#training-exit').click());
await new Promise((r) => setTimeout(r, 1400));
console.log('\n--- treinamento ---');
console.log(`  menu: ${treino.visivel}, ${treino.missoes} missões, fase=${treino.fase} (${treino.titulo})`);
console.log(`  prática: ${pratica.visivel}, ${pratica.opcoes} opções (${pratica.estado})`);
console.log(`  labirinto: input estável=${JSON.stringify(labInput)}, demonstração pausa=${guidedPaused}`);
console.log(
  `  PURGA sem resposta vazada: ${purgaTreino.titulo}, ` +
  `${!purgaTreino.opcoes.some((opcao) => /AVANÇA|AFASTA|ROMPE|PRENSA\s+\d+[.,]\d+\s*→/i.test(opcao))}`,
);

if (trainingOnly) {
  console.log('\n--- erros ---');
  console.log(errors.length ? errors.join('\n') : '(nenhum)');
  await browser.close();
  await server.close();
  process.exit(errors.length ? 1 : 0);
}

// --- entra: clica JOGAR, deixa o discurso rolar
await page.evaluate(() => document.querySelector('#screen-btn').click());
await new Promise((r) => setTimeout(r, 4000));
await shot('2-intro');

// --- ENTER deve completar/avançar a fala, sem começar a partida
const linhaAntes = await page.$eval('#voice-line', (e) => e.textContent);
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 220));
}
const skipLinha = await page.evaluate(() => ({
  linha: document.querySelector('#voice-line').textContent,
  dicaVisivel: !document.querySelector('#intro-hint').hidden,
  terminalAberto: !document.querySelector('#terminal').hidden,
}));

// --- ESC deve pular a abertura inteira
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 1200));
const skipTudo = await page.evaluate(() => ({
  // ESC sai da abertura direto para a missão: a campanha não abre manuais.
  fase: window.prensa.debug().phase,
  dicaVisivel: !document.querySelector('#intro-hint').hidden,
  hudVisivel: !document.querySelector('#hud').hidden,
}));

console.log('\n--- skip da abertura ---');
console.log(`  ENTER: "${linhaAntes?.slice(0, 26)}…" -> "${skipLinha.linha?.slice(0, 26)}…"`);
console.log(`  ENTER nao inicia a partida: ${skipLinha.terminalAberto === false}`);
console.log(`  dica visivel durante a abertura: ${skipLinha.dicaVisivel}`);
console.log(`  ESC encerra a abertura: ${skipTudo.fase !== 'intro'} (fase=${skipTudo.fase}, hud=${skipTudo.hudVisivel})`);
console.log(`  dica some ao iniciar: ${skipTudo.dicaVisivel === false}`);

await new Promise((r) => setTimeout(r, 1200));
await shot('3-jogo');

// --- mundo sem HUD nem terminal: prova que prensa/esteira/sujeito leem
await page.evaluate(() => {
  for (const id of ['#terminal', '#hud', '#voice', '#vignette']) {
    const el = document.querySelector(id);
    if (el) el.style.visibility = 'hidden';
  }
});
await new Promise((r) => setTimeout(r, 900));
await shot('5-mundo-limpo');
await page.evaluate(() => {
  for (const id of ['#terminal', '#hud', '#voice', '#vignette']) {
    const el = document.querySelector(id);
    if (el) el.style.visibility = '';
  }
});

// --- estado interno
const state = await page.evaluate(() => {
  const term = document.querySelector('#terminal');
  const body = document.querySelector('#m-body');
  const opts = Array.from(document.querySelectorAll('#m-options li')).map((li) => li.textContent);
  const canvas = document.querySelector('#view');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  // le alguns pixels para provar que algo foi desenhado
  return {
    terminalVisible: term && !term.hidden,
    missao: document.querySelector('#m-title')?.textContent,
    no: document.querySelector('#m-node')?.textContent,
    prompt: document.querySelector('#m-prompt')?.textContent,
    linhasMapa: (body?.textContent ?? '').split('\n').length,
    opcoes: opts,
    hud: {
      sujeito: document.querySelector('#hud-subject')?.textContent,
      esteira: document.querySelector('#hud-belt')?.textContent,
      ciclo: document.querySelector('#hud-cycle')?.textContent,
    },
    canvas: { w: canvas.width, h: canvas.height, gl: !!gl },
  };
});

// --- prova pelo compositor que o jogo não está preto. Copiar o WebGL direto
// para um canvas 2D devolve zero quando preserveDrawingBuffer=false, mesmo com
// a imagem visível; a captura da página testa o quadro que o jogador recebe.
const composedFrame = await page.screenshot({ encoding: 'base64' });
const nonBlack = await page.evaluate(async (frame) => {
  const src = new Image();
  src.src = `data:image/png;base64,${frame}`;
  await src.decode();
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 90;
  c.getContext('2d').drawImage(src, 0, 0, 160, 90);
  const d = c.getContext('2d').getImageData(0, 0, 160, 90).data;
  let lit = 0;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] + d[i + 1] + d[i + 2];
    if (v > 24) lit++;
    if (v > max) max = v;
  }
  return { pctAceso: ((lit / (160 * 90)) * 100).toFixed(1), brilhoMax: max };
}, composedFrame);
if (Number(nonBlack.pctAceso) <= 0 || nonBlack.brilhoMax <= 24) {
  errors.push(`quadro composto sem imagem: ${JSON.stringify(nonBlack)}`);
}

// --- modo desempenho: [P] alterna, o buffer encolhe e a grade nao muda
const antesP = await page.evaluate(() => {
  const c = document.querySelector('#view');
  return { w: c.width, h: c.height, cssW: c.style.width };
});
await page.keyboard.press('p');
await new Promise((r) => setTimeout(r, 700));
const depoisP = await page.evaluate(() => {
  const c = document.querySelector('#view');
  return { w: c.width, h: c.height, cssW: c.style.width };
});
await shot('10-desempenho');
await page.keyboard.press('p');
await new Promise((r) => setTimeout(r, 500));
const voltaP = await page.evaluate(() => document.querySelector('#view').width);
console.log('\n--- modo desempenho ---');
console.log(`  buffer: ${antesP.w}x${antesP.h} -> ${depoisP.w}x${depoisP.h} -> ${voltaP} (volta)`);
console.log(`  tamanho CSS preservado: ${antesP.cssW === depoisP.cssW} (${depoisP.cssW})`);
console.log(`  pixels poupados: ${(100 - (depoisP.w * depoisP.h * 100) / (antesP.w * antesP.h)).toFixed(0)}%`);

// --- responde algumas perguntas
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('1');
  await new Promise((r) => setTimeout(r, 1800));
}
await shot('4-depois-respostas');

const after = await page.evaluate(() => ({
  sujeito: document.querySelector('#hud-subject')?.textContent,
  feedback: document.querySelector('#m-feedback')?.textContent,
  voz: document.querySelector('#voice-line')?.textContent,
  fase: document.querySelector('#hud-phase')?.textContent,
}));

// --- final: esmagado. Não existe cartão didático para congelar a campanha.
let morreu = false;
for (let i = 0; i < 20 && !morreu; i++) {
  await page.evaluate(() => {
    if (!window.prensa.belt.dead) window.prensa.belt.distance = 0.2;
  });
  await new Promise((r) => setTimeout(r, 400));
  morreu = await page.evaluate(() => window.prensa.belt.dead);
}
// meio da cena de morte: o martelo tem que estar EMBAIXO e a camera colada
for (let i = 0; i < 60; i++) {
  const t = await page.evaluate(() => window.prensa.debug().deathT);
  if (t > 0.9) break;
  await new Promise((r) => setTimeout(r, 150));
}
await shot('9-esmagado');

// espera a cena de morte terminar e a tela de fim aparecer
// headless roda por software: com o clamp de dt o tempo de JOGO anda mais
// devagar que o relogio, entao a espera aqui e generosa de proposito
for (let i = 0; i < 140; i++) {
  const pronto = await page.evaluate(() => window.prensa.debug().deathScreenShown);
  if (pronto) break;
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 600));
await shot('6-morte');
const diag = await page.evaluate(() => ({
  ...window.prensa.debug(),
  telaEscondida: document.querySelector('#screen').hidden,
  terminalAberto: !document.querySelector('#terminal').hidden,
}));
console.log('\n--- diagnostico pre-morte ---');
console.log(JSON.stringify(diag));

const morte = await page.evaluate(() => ({
  titulo: document.querySelector('#screen-title')?.textContent,
  texto: document.querySelector('#screen-text')?.textContent,
  botao: document.querySelector('#screen-btn')?.textContent,
  visivel: !document.querySelector('#screen').hidden,
}));

// --- reinicia e força a fuga (a tela de fim só aceita entrada após ~1.2 s)
await new Promise((r) => setTimeout(r, 1400));
await page.evaluate(() => document.querySelector('#screen-btn').click());
await new Promise((r) => setTimeout(r, 1200));
// segunda partida: o Zelador deve entregar a abertura CURTA
const aberturaCurta = await page.$eval('#voice-line', (e) => e.textContent);
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 1400));
console.log(`\n  abertura da 2a partida: "${aberturaCurta}"`);
await page.evaluate(() => {
  // Mesmo além do limiar, quatro travas devem segurar o corpo dentro da sala.
  window.prensa.belt.distance = 26.4;
});
await new Promise((r) => setTimeout(r, 900));
const bloqueio = await page.evaluate(() => ({
  ...window.prensa.debug(),
  telaVisivel: !document.querySelector('#screen').hidden,
}));
await shot('11-escotilha-trancada');
if (
  bloqueio.phase === 'won' ||
  bloqueio.unlocked !== false ||
  bloqueio.keys !== 0 ||
  bloqueio.distance > 25.86 ||
  bloqueio.telaVisivel
) {
  errors.push(`escotilha trancada falhou: ${JSON.stringify(bloqueio)}`);
}

// O atalho altera exatamente o estado que quatro sucessos alterariam.
await page.evaluate(() => {
  window.prensa.debugUnlockExit();
  window.prensa.belt.distance = 26.4;
});
await new Promise((r) => setTimeout(r, 4500));
await shot('7-fuga');
const fuga = await page.evaluate(() => ({
  ...window.prensa.debug(),
  titulo: document.querySelector('#screen-title')?.textContent,
  texto: document.querySelector('#screen-text')?.textContent,
  visivel: !document.querySelector('#screen').hidden,
}));
if (fuga.phase !== 'won' || fuga.unlocked !== true || fuga.keys !== 4 || fuga.titulo !== 'FORA' || !fuga.visivel) {
  errors.push(`escotilha destrancada falhou: ${JSON.stringify(fuga)}`);
}

console.log('\n--- final: morte ---');
console.log(JSON.stringify(morte, null, 2));
console.log('\n--- escotilha trancada ---');
console.log(JSON.stringify(bloqueio, null, 2));
console.log('\n--- final: fuga ---');
console.log(JSON.stringify(fuga, null, 2));

console.log('\n--- estado do jogo ---');
console.log(JSON.stringify(state, null, 2));
console.log('\n--- canvas ---');
console.log(JSON.stringify(nonBlack));
console.log('\n--- depois de 6 respostas ---');
console.log(JSON.stringify(after, null, 2));

const glErrors = logs.filter((l) => /THREE|WebGL|shader|GL_/i.test(l));
console.log('\n--- avisos three/webgl ---');
console.log(glErrors.length ? glErrors.join('\n') : '(nenhum)');
console.log('\n--- erros ---');
console.log(errors.length ? errors.join('\n') : '(nenhum)');

await browser.close();
await server.close();
process.exit(errors.length || glErrors.some((l) => /error/i.test(l)) ? 1 : 0);
