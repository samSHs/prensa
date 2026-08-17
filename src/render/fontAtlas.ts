import * as THREE from 'three';

/**
 * Atlas de glifos gerado em runtime (nenhum asset externo).
 *
 * Linha única de N células. Os primeiros RAMP.length glifos estão ordenados
 * por densidade de tinta (do vazio ao sólido); os 4 finais são glifos de
 * *aresta*, usados pelo shader quando o Sobel detecta uma borda forte —
 * é isso que dá contorno às formas e faz a cena parecer desenhada, não
 * apenas pontilhada.
 */

/** ordenado por densidade — não reordenar sem reavaliar o gamma do shader */
export const RAMP = [' ', '.', "'", ':', ';', '~', '=', '+', 'c', 'o', 'x', '*', '%', '&', '#', '@'] as const;

/** horizontal, diagonal-sobe, vertical, diagonal-desce — a ordem importa */
export const EDGES = ['-', '/', '|', '\\'] as const;

export const GLYPHS: readonly string[] = [...RAMP, ...EDGES];

export interface Atlas {
  texture: THREE.Texture;
  count: number;
  rampCount: number;
  cellW: number;
  cellH: number;
}

export function buildAtlas(cellW: number, cellH: number, scale = 3): Atlas {
  const cw = cellW * scale;
  const ch = cellH * scale;

  const canvas = document.createElement('canvas');
  canvas.width = cw * GLYPHS.length;
  canvas.height = ch;

  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Um pouco menor que a célula: glifos encostando na borda viram blocos.
  ctx.font = `${Math.round(ch * 0.92)}px "Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';

  GLYPHS.forEach((g, i) => {
    ctx.fillText(g, i * cw + cw / 2, ch / 2 + ch * 0.04);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  return { texture, count: GLYPHS.length, rampCount: RAMP.length, cellW, cellH };
}
