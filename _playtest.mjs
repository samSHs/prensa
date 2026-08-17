// Playtest de avaliação — não faz parte do build nem do smoke oficial.
// Joga como o jogador: teclas numéricas escolhem a opção da lista.
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5201 }, logLevel: 'error' });
await server.listen();

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,760'],
});

const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newSession() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
  await page.goto('http://localhost:5201/?debug', { waitUntil: 'networkidle0' });
  await sleep(1200);
  return page;
}

const shot = (page, name) => page.screenshot({ path: `_play-${name}.png` }).then(() => console.log(`  _play-${name}.png`));

async function waitFor(page, fn, timeout = 30000, step = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(step);
  }
  return false;
}

// lê as <li data-id> do terminal e devolve índice 1-based da escolha
const lerOpcoes = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#m-options li')).map((li, i) => ({
      n: i + 1,
      id: li.dataset.id,
      texto: li.querySelector('span')?.textContent ?? li.textContent,
      travada: li.classList.contains('locked'),
    })),
  );

async function escolher(page, n) {
  await page.keyboard.press(String(n));
}

const missionState = (page) =>
  page.evaluate(() => ({
    titulo: document.querySelector('#m-title')?.textContent,
    prompt: document.querySelector('#m-prompt')?.textContent,
    feedback: document.querySelector('#m-feedback')?.textContent,
    debug: window.prensa.debug(),
  }));

async function startCampaign(page, canal) {
  await page.evaluate(() => document.querySelector('#screen-btn').click());
  await sleep(2500);
  await page.keyboard.press('Escape');
  const ok = await waitFor(page, () => window.prensa.debug().tuning === true, 20000);
  console.log(`  varredura aberta: ${ok}`);
  await shot(page, `${canal}-0-varredura`);
  await page.keyboard.press(canal === 'A' ? '1' : '2');
  const iniciou = await waitFor(page, () => window.prensa.debug().tuning === false, 15000);
  console.log(`  missão iniciada: ${iniciou}`);
  await sleep(1200);
}

// ---------- sessão 1: campanha, CANAL A (labirinto) ----------
{
  const page = await newSession();
  await startCampaign(page, 'A');
  console.log('\n=== LABIRINTO (campanha) ===');
  let ultimoShot = Date.now();
  let ultimasOrdens = [];
  for (let i = 0; i < 90; i++) {
    const st = await missionState(page);
    const ops = await lerOpcoes(page);
    if (i % 5 === 0) {
      console.log(`t${i}: fase=${st.debug.phase} d=${Number(st.debug.distance).toFixed(1)}m chaves=${st.debug.keys} missoes=${st.debug.missionsDone}`);
      console.log(`     ${st.titulo} | ${st.prompt} ${st.feedback ? '· ' + st.feedback : ''}`);
      console.log(`     opções: ${JSON.stringify(ops.map((o) => o.texto))}`);
    }
    if (st.debug.phase === 'dead' || st.debug.phase === 'won') { console.log('  FIM:', JSON.stringify(st.debug)); break; }
    if (st.debug.tuning) { console.log('  missão encerrada, de volta à varredura:', JSON.stringify(st.debug)); await shot(page, 'A-9-pos-missao'); break; }
    if (Date.now() - ultimoShot > 20000) { await shot(page, `A-${String(i).padStart(2, '0')}-lab`); ultimoShot = Date.now(); }

    if (ops.length && !ops[0].travada) {
      // heurística de jogador: prefere mover (evitando voltar ao SUL), depois armário, evita repetir isca
      const livre = ops.filter((o) => !ultimasOrdens.includes(o.id));
      const mov = (livre.length ? livre : ops).find((o) => /^MOVE:/.test(o.id ?? '') && !/SUL/.test(o.id));
      const arm = ops.find((o) => /^HIDE:/.test(o.id ?? ''));
      const escolha = mov ?? arm ?? (livre[0] ?? ops[0]);
      await escolher(page, escolha.n);
      ultimasOrdens.push(escolha.id);
      if (ultimasOrdens.length > 4) ultimasOrdens.shift();
      if (i % 5 === 0) console.log(`     >> [${escolha.n}] ${escolha.texto}`);
    }
    await sleep(1300);
  }
  await shot(page, 'A-fim');
  await page.close();
}

// ---------- sessão 2: campanha, CANAL B (purga) ----------
{
  const page = await newSession();
  await startCampaign(page, 'B');
  console.log('\n=== PURGA (campanha) ===');
  await shot(page, 'B-1-inicio');
  let ultimoShot = Date.now();
  for (let i = 0; i < 40; i++) {
    const st = await missionState(page);
    const ops = await lerOpcoes(page);
    if (i % 3 === 0) {
      console.log(`t${i}: fase=${st.debug.phase} d=${Number(st.debug.distance).toFixed(1)}m missoes=${st.debug.missionsDone}`);
      console.log(`     ${st.titulo} | ${st.prompt} ${st.feedback ? '· ' + st.feedback : ''}`);
      console.log(`     opções: ${JSON.stringify(ops.map((o) => o.texto))}`);
    }
    if (st.debug.phase === 'dead' || st.debug.phase === 'won') { console.log('  FIM:', JSON.stringify(st.debug)); break; }
    if (st.debug.tuning) { console.log('  missão encerrada:', JSON.stringify(st.debug)); await shot(page, 'B-9-pos-missao'); break; }
    if (Date.now() - ultimoShot > 20000) { await shot(page, `B-${String(i).padStart(2, '0')}-purga`); ultimoShot = Date.now(); }

    if (ops.length && !ops[0].travada) {
      // jogador razoável: alivia o nó mais carregado abrindo saída p/ QUEIMADOR;
      // senão fecha a válvula que alimenta o nó mais cheio
      const abrirAlívio = ops.find((o) => /ABRIR/.test(o.texto) && /QUEIMADOR/.test(o.texto));
      const escolha = abrirAlívio ?? ops[Math.floor(Math.random() * ops.length)];
      await escolher(page, escolha.n);
      if (i % 3 === 0) console.log(`     >> [${escolha.n}] ${escolha.texto}`);
    }
    await sleep(2000);
  }
  await shot(page, 'B-fim');
  await page.close();
}

console.log('\n=== ERROS ===');
console.log(errors.length ? errors.join('\n') : '(nenhum)');

await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
