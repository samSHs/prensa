// A abertura travada não pode virar uma parede: sem ENTER ela espera para
// sempre; com ENTER ela anda e o jogo começa. Verifica os dois lados.
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5207 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,760'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5207/?debug', { waitUntil: 'networkidle0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const estado = () => page.evaluate(() => ({
  fase: window.prensa.debug().phase,
  linha: document.querySelector('#voice-line').textContent,
}));

await sleep(1400);
await page.evaluate(() => document.querySelector('#screen-btn').click());

// Doze segundos parado. O teletipo roda por quadro, e com GL por software o
// headless entrega poucos quadros por segundo — a margem é para a digitação
// terminar mesmo assim. O que se mede aqui é o que vem DEPOIS dela: nada.
const PRIMEIRA = 'Bom dia. Você acordou. Isso já é um dado.';
await sleep(12000);
const parado = await estado();
console.log('linha    :', JSON.stringify(parado.linha));
console.log('digitou  :', parado.linha === PRIMEIRA ? 'OK — completou a frase' : 'FALHOU — parou no meio da frase');
console.log('trava    :', parado.linha === PRIMEIRA && parado.fase === 'intro' ? 'OK — completou e esperou, sem passar para a proxima' : 'FALHOU — a abertura andou sozinha');
const primeira = parado;

// agora anda no ENTER
for (let i = 0; i < 30; i++) {
  await page.keyboard.press('Enter');
  await sleep(120);
}
const depois = await estado();
console.log('avanco   :', depois.linha !== primeira.linha || depois.fase === 'playing' ? 'OK — ENTER avanca' : 'FALHOU — ENTER nao move');
console.log('fase apos 30x ENTER:', depois.fase);

// ESC duas vezes durante a partida volta ao menu
if (depois.fase === 'playing') {
  await page.keyboard.press('Escape');
  await sleep(200);
  const armado = await estado();
  await page.keyboard.press('Escape');
  await sleep(400);
  const menu = await estado();
  console.log('esc 1x   :', armado.fase === 'playing' ? 'OK — nao abandona no primeiro toque' : `FALHOU — foi para ${armado.fase}`);
  console.log('esc 2x   :', menu.fase === 'title' ? 'OK — voltou ao menu' : `FALHOU — ficou em ${menu.fase}`);
}

console.log('ERROS:', errors.length ? errors.join(' ; ') : '(nenhum)');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
