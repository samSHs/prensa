// Verificação visual do manual da purga com o mapa da rede.
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5205 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,760'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5205/?debug', { waitUntil: 'networkidle0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

await page.evaluate(() => document.querySelector('#screen-training').click());
await sleep(500);
await page.evaluate(() => document.querySelector('[data-training-kind="purga"]').click());
await sleep(400);
await page.evaluate(() => {
  const det = document.querySelector('.training-manual');
  if (det && !det.open) det.open = true;
  const rules = document.querySelector('#training-rules');
  rules.style.maxHeight = 'none';
  rules.style.overflow = 'visible';
});
await sleep(400);
await page.evaluate(() => document.querySelector('#training-rules').scrollIntoView({ block: 'start' }));
await sleep(200);
const el = await page.$('#training-rules');
await el.screenshot({ path: '_treino-purga-mapa.png' });
console.log('ERROS:', errors.length ? errors.join(' ; ') : '(nenhum)');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
