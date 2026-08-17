/**
 * A cara do Zelador. Nada de rosto: chapéu de aba, duas lentes redondas e o
 * filtro cilíndrico descendo do queixo.
 *
 * Desenhado por espelhamento: cada linha é a metade esquerda + ela invertida.
 * Com blocos cheios isso garante simetria perfeita — máscara torta a olho nu
 * lê como caveira, e caveira já é outro bicho.
 *
 * IMPORTANTE: quem renderiza isso precisa de `letter-spacing: 0` e
 * `line-height: 1`. Qualquer espaçamento parte os `█` em listras verticais.
 */

const mirror = (halves: readonly string[]): string =>
  halves.map((h) => h + [...h].reverse().join('')).join('\n');

// Cada linha tem exatamente 22 colunas (a metade de 44). A leitura depende de
// três massas em ordem decrescente de largura: aba do chapéu > crânio > filtro.
const KEEPER_A = [
  '                ▄▄▄▄▄▄', // coroa
  '                ██████',
  '                ██████',
  '      ▄▄▄▄▄▄▄▄▄▄██████', // aba: o elemento mais largo
  '      ████████████████',
  '      ████████████████',
  '      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '            ▄▄▄▄▄▄████', // crânio
  '         █████████████',
  '        ██████████████',
  '        ███▀▀▀▀▀██████', // sobrancelha
  '        ██        ████', // lente: buraco de 8 colunas
  '        █         ████',
  '        █    ██   ████', // pupila
  '        █         ████',
  '        ██        ████',
  '        ███▄▄▄▄▄██████',
  '         █████████████',
  '          ████████████',
  '           ▀▀▀▀▀▀█████',
  '               ▄▄▄████', // filtro: cilindro de lados retos
  '               ███████',
  '               ███████',
  '               ███████',
  '               ▀▀▀████',
];

/** frame B: a luz pega as lentes de outro jeito e o filtro "respira" */
const KEEPER_B = [
  '                ▄▄▄▄▄▄',
  '                ██████',
  '                ██████',
  '      ▄▄▄▄▄▄▄▄▄▄██████',
  '      ████████████████',
  '      ████████████████',
  '      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '            ▄▄▄▄▄▄████',
  '         █████████████',
  '        ██████████████',
  '        ███▀▀▀▀▀██████',
  '        ██        ████',
  '        █    ▄▄   ████',
  '        █    ██   ████',
  '        █    ▀▀   ████',
  '        ██        ████',
  '        ███▄▄▄▄▄██████',
  '         █████████████',
  '          ████████████',
  '           ▀▀▀▀▀▀█████',
  '               ▄▄▄████',
  '               ███████',
  '               ███████',
  '               ▀▀▀████',
  '                 ▀▀███',
];

export const MASK_FRAMES = [mirror(KEEPER_A), mirror(KEEPER_B)] as const;

// Buracos centrais (nariz) precisam de espaços no FIM da metade — é ali que
// fica a linha de espelho.
export const SKULL = mirror([
  '        ▄▄▄▄▄▄▄▄',
  '     ███████████',
  '   █████████████',
  '  ██████████████',
  ' ███████████████',
  ' ███▀▀▀▀▀▀██████',
  ' ██        █████',
  ' █         █████',
  ' █         █████',
  ' ██        █████',
  ' ███▄▄▄▄▄▄██████',
  '  ███████████   ',
  '  ████████████  ',
  '  █████████████ ',
  '   █████████████',
  '    ▀▀▀▀████████',
  '      ██████████',
  '       █ █ █ █ █',
]);

export const DOOR = mirror([
  '████████████',
  '██          ',
  '██  ▄▄▄▄▄▄▄▄',
  '██  ████████',
  '██  ████████',
  '██  ████████',
  '██  ████████',
  '██  ███████ ',
  '██  ████████',
  '██  ▀▀▀▀▀▀▀▀',
  '██          ',
  '████████████',
]);
