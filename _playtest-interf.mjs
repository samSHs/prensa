// Completa o exercício de INTERFERÊNCIAS no treinamento:
// trava -> imobilidade (isca) -> prova mista, reagindo só aos cues corretos.
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5204 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,760'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5204/?debug', { waitUntil: 'networkidle0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

const estado = () =>
  page.evaluate(() => ({
    no: document.querySelector('#t-m-node')?.textContent,
    estadoSala: document.querySelector('#t-m-state')?.textContent,
    cue: document.querySelector('#t-m-pulse')?.dataset.stage ?? null,
    corpo: document.querySelector('#t-m-body')?.innerText ?? '',
    prompt: document.querySelector('#t-m-prompt')?.textContent ?? '',
    feedback: document.querySelector('#t-m-feedback')?.innerText ?? '',
    continuar: !document.querySelector('#training-next')?.hidden,
  }));

await page.evaluate(() => document.querySelector('#screen-training').click());
await sleep(600);
await page.evaluate(() => document.querySelector('[data-training-kind="interferencia"]').click());
await sleep(400);
await page.evaluate(() => document.querySelector('#training-guided').click());
await sleep(800);

let ultimoQuadro = '';
let shots = 0;
for (let i = 0; i < 160; i++) {
  const st = await estado();
  const quadro = `${st.no}|${st.cue}|${st.corpo.slice(0, 60)}`;
  if (quadro !== ultimoQuadro) {
    console.log(`\n[${i}] ${st.no} · cue=${st.cue} · ${st.estadoSala}`);
    console.log(`  corpo: ${st.corpo.replace(/\n+/g, ' ⏎ ').slice(0, 220)}`);
    if (st.prompt) console.log(`  prompt: ${st.prompt}`);
    if (st.feedback) console.log(`  feedback: ${st.feedback.slice(0, 180)}`);
    ultimoQuadro = quadro;
    if ((st.cue === 'watch' || st.cue === 'approach' || st.cue === 'lock') && shots < 4) {
      await page.screenshot({ path: `_treino-interf-${st.cue}-${shots++}.png` });
    }
  }
  if (/EXERCÍCIO CONCLUÍDO|FALHA DE TREINO/.test(st.estadoSala ?? '')) {
    console.log(`\n=== FIM: ${st.estadoSala} ===\n${st.feedback}`);
    await page.screenshot({ path: '_treino-interf-fim.png' });
    break;
  }
  if (st.continuar) { await page.evaluate(() => document.querySelector('#training-next').click()); await sleep(400); continue; }

  if (st.cue === 'lock') {
    const seq = [...st.corpo.matchAll(/\[\s*([A-Z0-9])\s*\]/g)].map((m) => m[1]);
    const entrada = (st.corpo.match(/ENTRADA:\s*([■□]+)/) ?? [])[1] ?? '';
    const feitos = (entrada.match(/■/g) ?? []).length;
    if (seq.length && feitos < seq.length) {
      const tecla = seq[feitos];
      await page.keyboard.press(tecla);
      console.log(`  >> trava: tecla ${tecla} (${feitos + 1}/${seq.length})`);
      await sleep(160);
      continue;
    }
  } else if (st.cue === 'routine') {
    const m = st.prompt.match(/Pressione\s+(\S+)/i) ?? st.corpo.match(/CONFIRMAR:\s*\[\s*([A-Z0-9])\s*\]/i);
    if (m) {
      await page.keyboard.press(m[1]);
      console.log(`  >> rotina: ${m[1]}`);
      await sleep(300);
      continue;
    }
  }
  // approach/watch/clear: imóvel de propósito
  await sleep(380);
}

console.log('\nERROS:', errors.length ? errors.join(' ; ') : '(nenhum)');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
