import {
  CLOSET,
  EXIT,
  HUNT,
  INVESTIGATE,
  KEY,
  PHONE,
  RADIO_SCRUB_SECONDS,
  SEARCH,
  SECTOR_NAMES,
  WALL,
  bfs,
  findTile,
  idx,
  isLit,
  killerVisible,
  sectorOf,
  tileLabel,
  type LabState,
} from './sim';

/**
 * Planta baixa em ASCII. O que você vê aqui é *tudo* o que você sabe:
 * setor sem energia não mostra piso, e o caçador só aparece se alguma câmera
 * ou a própria pessoa estiver com ele no campo de visão. Fora isso, sobra o
 * `?` — a última posição confirmada, envelhecendo a cada turno.
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const span = (cls: string, ch: string): string => `<span class="${cls}">${esc(ch)}</span>`;

export function renderMap(s: LabState): string {
  const visible = killerVisible(s);
  let out = '';

  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const lit = isLit(s, x, y);
      const t = s.tiles[idx(s, x, y)]!;

      // entidades primeiro
      if (s.sur.x === x && s.sur.y === y) {
        out += span(s.sur.hidden ? 'hide' : 'me', s.sur.hidden ? 'n@' : '@ ');
        continue;
      }
      if (visible && s.kil.x === x && s.kil.y === y) {
        out += span('him', '† ');
        continue;
      }
      if (!visible && s.seen && s.seen.x === x && s.seen.y === y) {
        out += span('ghost', '? ');
        continue;
      }
      if (s.radio.samples.some((sample) => sample.x === x && sample.y === y)) {
        out += span('bad', '△ ');
        continue;
      }

      if (t === WALL) {
        out += span(lit ? 'w' : 'dark', '██');
      } else if (t === EXIT) {
        out += span('exit', '][');
      } else if (t === KEY) {
        out += lit ? span('key', '$ ') : span('dark', '  ');
      } else if (t === CLOSET) {
        out += lit ? span('hide', tileLabel(s, idx(s, x, y))) : span('dark', '  ');
      } else if (t === PHONE) {
        out += lit ? span('lure', tileLabel(s, idx(s, x, y))) : span('dark', '  ');
      } else {
        out += lit ? span('f', '· ') : '  ';
      }
    }
    out += '\n';
  }

  const mode =
    s.kil.mode === HUNT ? '<span class="bad">CAÇANDO</span>'
    : s.kil.mode === INVESTIGATE ? '<span class="key">INVESTIGANDO</span>'
    : s.kil.mode === SEARCH ? '<span class="key">PROCURANDO</span>'
    : '<span class="f">PATRULHANDO</span>';

  // ---- rumo: onde está o objetivo e a que distância está o caçador.
  // Sem isto o jogador gasta o cronômetro inteiro procurando o `$` no mapa,
  // que é exatamente o que ninguém que testou conseguiu fazer a tempo.
  const goalIdx = findTile(s, s.sur.key ? EXIT : KEY);
  let bearing = '';
  if (goalIdx >= 0) {
    const gx = goalIdx % s.w;
    const gy = (goalIdx / s.w) | 0;
    const walk = bfs(s, gx, gy)[idx(s, s.sur.x, s.sur.y)]!;
    const nome = s.sur.key
      ? '<span class="exit">SAÍDA</span>'
      : '<span class="key">CHAVE</span>';
    if (s.difficulty < 1.2) {
      const dx = gx - s.sur.x;
      const dy = gy - s.sur.y;
      const dirs: string[] = [];
      if (dx) dirs.push(`${Math.abs(dx)} a ${dx > 0 ? 'LESTE' : 'OESTE'}`);
      if (dy) dirs.push(`${Math.abs(dy)} ao ${dy > 0 ? 'SUL' : 'NORTE'}`);
      bearing = `${nome}: ${walk < 0 ? '—' : walk} células de caminho${dirs.length ? `  (${dirs.join(', ')})` : ''}`;
    } else {
      const range = walk < 0 ? 'SEM ROTA' : walk <= 5 ? 'PERTO' : walk <= 12 ? 'DISTÂNCIA MÉDIA' : 'LONGE';
      bearing = `${nome}: SETOR ${SECTOR_NAMES[sectorOf(s, gx, gy)]} · ${range}`;
    }
  }

  const kWalk = bfs(s, s.kil.x, s.kil.y)[idx(s, s.sur.x, s.sur.y)]!;
  const kRange = kWalk < 0 ? '—' : kWalk <= 4 ? 'MUITO PERTO' : kWalk <= 9 ? 'PERTO' : 'DISTANTE';
  const kInfo = visible
    ? s.difficulty < 1.2
      ? `<span class="him">CAÇADOR</span>: ${kWalk < 0 ? '—' : kWalk} células dela · ${mode}`
      : `<span class="him">CAÇADOR</span>: ${kRange} · ${mode}`
    : `<span class="him">CAÇADOR</span>: <span class="ghost">sem sinal há ${s.turn - (s.seen?.turn ?? 0)} turno(s)</span>`;

  const dark = SECTOR_NAMES.filter((_, i) => !s.lights[i]);
  const status = [
    `EXPOSIÇÃO ${String(s.turn).padStart(2, '0')}/${s.maxTurns}`,
    `CHAVE ${s.sur.key ? '<span class="ok">SIM</span>' : '<span class="bad">NÃO</span>'}`,
  ].join('   ');

  const radioState =
    s.sur.trust <= 0
      ? '<span class="bad">NÃO RESPONDE</span>'
      : s.sur.trust === 1 || s.sur.panic >= 2
        ? '<span class="key">TREMENDO</span>'
        : '<span class="ok">CONFIA</span>';
  const tx = s.radio.txOpen
    ? '<span class="ok">ABERTO</span>'
    : '<span class="bad">CORTADO</span> · RX ABERTO';
  const traceLoad = Math.min(2, s.radio.samples.length);
  const network =
    traceLoad >= 2
      ? '<span class="bad">TRIANGULADA</span>'
      : traceLoad === 1
        ? '<span class="key">PORTADORA CAPTADA</span>'
        : '<span class="ok">LIMPA</span>';
  const scrub =
    !s.radio.txOpen && traceLoad > 0
      ? ` · LIMPANDO ${(Math.max(0, RADIO_SCRUB_SECONDS - s.radio.cutFor)).toFixed(1)}s`
      : '';
  const traceDetails = s.radio.samples.length
    ? `\n${s.radio.samples
        .map(
          (sample, sampleIndex) =>
            `<span class="bad">△${sampleIndex + 1}</span> ` +
            `${SECTOR_NAMES[sectorOf(s, sample.x, sample.y)]} · ${Math.max(0, sample.left).toFixed(1)}s`,
        )
        .join('   ')}`
    : '';
  const intent =
    s.sur.intent.k === 'MOVE'
      ? `SEGUINDO ${s.sur.intent.dy < 0 ? 'NORTE' : s.sur.intent.dx > 0 ? 'LESTE' : s.sur.intent.dy > 0 ? 'SUL' : 'OESTE'} · AUTOMÁTICO`
      : s.sur.intent.k === 'HIDE'
        ? `INDO AO ${tileLabel(s, idx(s, s.sur.intent.x, s.sur.intent.y))}`
        : s.sur.hidden
          ? 'ESCONDIDA'
          : 'PARADA';
  const commandState =
    s.sur.intent.k === 'MOVE' || s.sur.intent.k === 'HIDE' || s.sur.pending || s.sur.hesitate > 0
      ? '<span class="ghost">CORREDOR EM EXECUÇÃO · A PRÓXIMA LISTA SÓ APARECE NUMA DECISÃO REAL</span>'
      : '<span class="ok">DECISÃO ABERTA · COMANDOS CONGELADOS ATÉ VOCÊ ESCOLHER</span>';

  const legend =
    '<span class="me">@</span> refém   ' +
    '<span class="him">†</span> caçador   ' +
    '<span class="exit">][</span> saída   ' +
    '<span class="key">$</span> chave   ' +
    '<span class="hide">A1</span> armário   ' +
    '<span class="lure">F1</span> telefone   ' +
    '<span class="bad">△</span> amostra do rádio   ' +
    '<span class="ghost">?</span> último contato';

  const power = dark.length ? `\n<span class="ghost">SEM ENERGIA: ${dark.join(', ')}</span>` : '';

  // objetivo sempre à vista: o jogador não deveria precisar lembrar do cartão
  const goal = s.sur.key
    ? '<span class="hl">OBJETIVO:</span> leve <span class="me">@</span> até a saída <span class="exit">][</span> — a chave já está com ela'
    : '<span class="hl">OBJETIVO:</span> leve <span class="me">@</span> até a chave <span class="key">$</span>, depois até a saída <span class="exit">][</span>';

  return (
    `${goal}\n${bearing}\n${kInfo}\n` +
    `TX: ${tx} <span class="ghost">[0 ALTERNA]</span> · REDE: ${network}${scrub}${traceDetails}\n` +
    `VÍTIMA: ${radioState} · ${intent}\n` +
    `${commandState} · <span class="ghost">A BARRA É DO CAÇADOR</span>\n` +
    `<span class="ghost">ÚLTIMO SINAL: ${esc(s.lastEvent)}</span>\n\n` +
    `${out}\n${status}${power}\n` +
    `<span class="f">${legend}</span>`
  );
}
