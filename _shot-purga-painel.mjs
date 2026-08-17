// Verificação visual do painel vivo da purga: marcação das rotas que ainda
// alimentam a prensa (ABR↯) contra as que escoam para um ralo (ABR ok).
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5206 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,760'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5206/?debug', { waitUntil: 'networkidle0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

await page.evaluate(() => document.querySelector('#screen-training').click());
await sleep(500);
await page.evaluate(() => document.querySelector('[data-training-kind="purga"]').click());
await sleep(400);
await page.evaluate(() => document.querySelector('#training-start').click());
await sleep(900);

const painel = await page.$('#training-practice');
await painel.screenshot({ path: '_shot-purga-painel.png' });

const texto = await page.evaluate(() => document.querySelector('#t-m-body').innerText);
console.log('--- corpo do painel ---');
console.log(texto);
console.log('ERROS:', errors.length ? errors.join(' ; ') : '(nenhum)');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
