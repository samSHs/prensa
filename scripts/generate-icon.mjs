import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const size = 256;
const rgba = Buffer.alloc(size * (size * 4 + 1));

function inRect(x, y, left, top, right, bottom) {
  return x >= left && x < right && y >= top && y < bottom;
}

for (let y = 0; y < size; y += 1) {
  const row = y * (size * 4 + 1);
  rgba[row] = 0;
  for (let x = 0; x < size; x += 1) {
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    const vignette = Math.max(0, 9 - Math.floor(edge / 9));
    let r = 10 + vignette;
    let g = 7;
    let b = 5;

    const hash =
      inRect(x, y, 74, 49, 101, 207) ||
      inRect(x, y, 151, 49, 178, 207) ||
      inRect(x, y, 45, 88, 207, 116) ||
      inRect(x, y, 45, 141, 207, 169);
    const highlight =
      inRect(x, y, 78, 53, 86, 203) ||
      inRect(x, y, 155, 53, 163, 203) ||
      inRect(x, y, 49, 92, 203, 100) ||
      inRect(x, y, 49, 145, 203, 153);
    const frame =
      inRect(x, y, 18, 18, 238, 23) ||
      inRect(x, y, 18, 233, 238, 238) ||
      inRect(x, y, 18, 18, 23, 238) ||
      inRect(x, y, 233, 18, 238, 238);

    if (frame) [r, g, b] = [98, 20, 13];
    if (hash) [r, g, b] = [211, 65, 26];
    if (highlight) [r, g, b] = [255, 177, 62];

    const pixel = row + 1 + x * 4;
    rgba[pixel] = r;
    rgba[pixel + 1] = g;
    rgba[pixel + 2] = b;
    rgba[pixel + 3] = 255;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(rgba, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = 0;
icoHeader[7] = 0;
icoHeader[8] = 0;
icoHeader[9] = 0;
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);

const buildDir = path.resolve('build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([icoHeader, png]));

// O executável portátil é um autoextrator NSIS. Na primeira abertura o
// Defender pode analisar ~100 MB antes de Electron existir; este BMP é
// exibido pelo próprio autoextrator durante esse intervalo, portanto aparece
// muito antes de qualquer HTML ou JavaScript do jogo.
const splashWidth = 640;
const splashHeight = 360;
const splashRowSize = (splashWidth * 3 + 3) & ~3;
const splashPixels = splashRowSize * splashHeight;
const splash = Buffer.alloc(54 + splashPixels);
splash.write('BM', 0, 'ascii');
splash.writeUInt32LE(splash.length, 2);
splash.writeUInt32LE(54, 10);
splash.writeUInt32LE(40, 14);
splash.writeInt32LE(splashWidth, 18);
splash.writeInt32LE(splashHeight, 22);
splash.writeUInt16LE(1, 26);
splash.writeUInt16LE(24, 28);
splash.writeUInt32LE(splashPixels, 34);
splash.writeInt32LE(2835, 38);
splash.writeInt32LE(2835, 42);

function splashPixel(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= splashWidth || y >= splashHeight) return;
  const offset = 54 + (splashHeight - 1 - y) * splashRowSize + x * 3;
  splash[offset] = b;
  splash[offset + 1] = g;
  splash[offset + 2] = r;
}

function splashRect(left, top, right, bottom, color) {
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) splashPixel(x, y, ...color);
  }
}

for (let y = 0; y < splashHeight; y++) {
  for (let x = 0; x < splashWidth; x++) {
    const edge = Math.min(x, y, splashWidth - 1 - x, splashHeight - 1 - y);
    const glow = Math.max(0, 1 - Math.hypot(x - splashWidth / 2, y - splashHeight * 0.42) / 410);
    const grain = ((x * 17 + y * 31 + ((x * y) % 19)) % 7) - 3;
    splashPixel(
      x,
      y,
      Math.max(3, Math.round(7 + glow * 13 + grain)),
      Math.max(2, Math.round(5 + glow * 7 + grain * 0.35)),
      Math.max(2, Math.round(4 + glow * 3)),
    );
    if (edge < 3) splashPixel(x, y, 92, 19, 12);
  }
}

const FONT = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

function splashText(text, y, scale, color) {
  const width = (text.length * 6 - 1) * scale;
  const startX = Math.floor((splashWidth - width) / 2);
  for (let index = 0; index < text.length; index++) {
    const glyph = FONT[text[index]] ?? FONT[' '];
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== '1') continue;
        splashRect(
          startX + (index * 6 + col) * scale,
          y + row * scale,
          startX + (index * 6 + col + 1) * scale,
          y + (row + 1) * scale,
          color,
        );
      }
    }
  }
}

// A mesma linguagem visual do terminal: aço escuro, sangue e fósforo âmbar.
splashRect(70, 42, 570, 46, [102, 20, 13]);
splashText('PRENSA', 67, 9, [244, 166, 64]);
splashRect(188, 145, 452, 149, [92, 19, 12]);
splashText('PREPARANDO O JOGO', 174, 3, [218, 116, 48]);
splashText('A PRIMEIRA VEZ PODE DEMORAR', 222, 2, [156, 98, 54]);
splashText('AGUARDE', 269, 4, [239, 190, 113]);
splashRect(70, 326, 570, 330, [102, 20, 13]);

fs.writeFileSync(path.join(buildDir, 'splash.bmp'), splash);
console.log(`Ícones e splash gerados em ${buildDir}`);
