// Dump completo do modo treinamento: manual (resumo+passos+regras) e a
// demonstração guiada de cada protocolo, com todo o texto visível.
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const server = await createServer({ server: { port: 5202 }, logLevel: 'error' });
await server.listen();

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--window-size=1280,760'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:5202/?debug', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };

await page.evaluate(() => document.querySelector('#screen-training').click());
await sleep(500);

for (const kind of ['labirinto', 'purga', 'codigo', 'interferencia']) {
  await page.evaluate((k) => document.querySelector(`[data-training-kind="${k}"]`).click(), kind);
  await sleep(400);
  const lesson = await page.evaluate(() => ({
    nome: document.querySelector('#training-name')?.textContent,
    eyebrow: document.querySelector('#training-eyebrow')?.textContent,
    resumo: document.querySelector('#training-summary')?.textContent,
    passos: Array.from(document.querySelectorAll('#training-steps li')).map((li) => li.textContent),
    aviso: document.querySelector('#training-watch')?.textContent,
    regras: document.querySelector('#training-rules')?.innerText,
  }));
  log(`\n${'='.repeat(72)}\n### ${kind.toUpperCase()} — MANUAL`);
  log(`${lesson.eyebrow} · ${lesson.nome}`);
  log(`RESUMO: ${lesson.resumo}`);
  lesson.passos.forEach((p, i) => log(`  ${i + 1}. ${p}`));
  log(`AVISO: ${lesson.aviso}`);
  log(`REGRAS (howTo da missão):\n${lesson.regras}`);
  await page.screenshot({ path: `_treino-${kind}-1-manual.png` });

  // demonstração guiada: executa algumas ações e registra as explicações
  await page.evaluate(() => document.querySelector('#training-guided').click());
  await sleep(900);
  log(`\n--- ${kind}: DEMONSTRAÇÃO GUIADA (transcrição de ~10 passos) ---`);
  for (let passo = 0; passo < 10; passo++) {
    const st = await page.evaluate(() => ({
      estado: document.querySelector('#t-m-state')?.textContent,
      no: document.querySelector('#t-m-node')?.textContent,
      prompt: document.querySelector('#t-m-prompt')?.textContent,
      feedback: document.querySelector('#t-m-feedback')?.innerText,
      corpo: document.querySelector('#t-m-body')?.innerText?.slice(0, 700),
      opcoes: Array.from(document.querySelectorAll('#t-m-options button')).map((b, i) => `[${i + 1}] ${b.textContent}`),
      esperandoAvanco: !document.querySelector('#training-next')?.hidden,
    }));
    log(`\n  passo ${passo} · estado="${st.estado}" nó="${st.no}"${st.esperandoAvanco ? ' [CONTINUAR visível]' : ''}`);
    log(`  prompt: ${st.prompt}`);
    if (st.feedback) log(`  explicação: ${st.feedback}`);
    if (passo === 0) log(`  corpo:\n${st.corpo.split('\n').map((l) => `    ${l}`).join('\n')}`);
    if (st.opcoes.length) log(`  opções: ${st.opcoes.join(' | ')}`);
    if (passo === 1 || passo === 4) await page.screenshot({ path: `_treino-${kind}-${passo + 1}-guiada.png` });
    if (st.esperandoAvanco) {
      await page.evaluate(() => document.querySelector('#training-next').click());
      await sleep(400);
      continue;
    }
    // age: trava usa teclas do corpo; demais escolhem a 1ª opção não eliminada
    const agiu = await page.evaluate((k) => {
      if (k === 'interferencia') {
        const corpo = document.querySelector('#t-m-body')?.innerText ?? '';
        const m = corpo.match(/TRAVA DE SEGURANÇA[\s\S]*?SEQUÊNCIA[:\s]+([A-Z0-9 ]{3,})/);
        return { tipo: 'trava', seq: m?.[1]?.trim() ?? null };
      }
      const botoes = Array.from(document.querySelectorAll('#t-m-options button')).filter((b) => !b.disabled);
      if (!botoes.length) return null;
      const alvo = botoes.find((b) => !b.classList.contains('eliminated')) ?? botoes[0];
      alvo.click();
      return { tipo: 'opcao', texto: alvo.textContent };
    }, kind);
    if (agiu?.tipo === 'opcao') log(`  >> ação: ${agiu.texto}`);
    if (agiu?.tipo === 'trava' && agiu.seq) {
      log(`  >> digitando trava: ${agiu.seq}`);
      for (const ch of agiu.seq.replace(/\s/g, '')) { await page.keyboard.press(ch); await sleep(120); }
    }
    await sleep(1400);
  }
  await page.screenshot({ path: `_treino-${kind}-9-fim-guiada.png` });

  // dica (CTRL+D) na simulação real — só registra a 1ª dica de cada
  await page.evaluate(() => document.querySelector('#training-menu').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector('#training-start').click());
  await sleep(900);
  await page.keyboard.down('Control');
  await page.keyboard.press('d');
  await page.keyboard.up('Control');
  await sleep(400);
  const dica = await page.evaluate(() => document.querySelector('#t-m-feedback')?.textContent);
  log(`\n--- ${kind}: SIMULAÇÃO REAL, 1ª dica CTRL+D ---\n  ${dica}`);

  await page.evaluate(() => document.querySelector('#training-exit').click());
  await sleep(600);
  await page.evaluate(() => document.querySelector('#screen-training').click());
  await sleep(500);
}

log(`\nERROS: ${errors.length ? errors.join(' ; ') : '(nenhum)'}`);
writeFileSync('_treino-dump.txt', out.join('\n'), 'utf8');
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
