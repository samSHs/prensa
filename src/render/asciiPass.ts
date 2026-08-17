import * as THREE from 'three';
import type { Atlas } from './fontAtlas';

/**
 * Passe final: transforma o render 3D numa grade de caracteres.
 *
 * Não é um "filtro de ASCII art" ingênuo. Para cada célula da grade:
 *   1. amostra 2x2 da cena (o render target tem 2x a resolução da grade);
 *   2. calcula Sobel sobre a luminância das células vizinhas;
 *   3. se o gradiente for forte, desenha um glifo de aresta orientado
 *      (- / | \) — é o que dá silhueta às formas no escuro;
 *   4. senão, escolhe um glifo da rampa de densidade pela luminância.
 *
 * A cor vem do próprio tom da cena (vermelho da prensa, ciano da escotilha)
 * multiplicado pelo fósforo âmbar, mais scanline, jitter e bloom barato.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tScene;
uniform sampler2D tGlyphs;
uniform vec2  uCells;      // colunas, linhas
uniform float uCount;      // total de glifos no atlas
uniform float uRamp;       // quantos deles sao rampa de densidade
uniform float uTime;
uniform float uDanger;     // 0..1
uniform float uGlitch;     // 0..1
uniform float uEdge;       // limiar do sobel
uniform float uEdges;      // 1 = detecta arestas; 0 = modo desempenho
uniform float uSuper;      // 1 = supersample 2x2 no centro da celula
uniform vec3  uPhosphor;
uniform vec3  uBlood;
uniform vec3  uCold;

varying vec2 vUv;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

/** centro da célula: 2x2 em qualidade alta, 1 leitura em modo desempenho */
vec3 sampleCenter(vec2 cell) {
  vec2 c = (cell + 0.5) / uCells;
  if (uSuper < 0.5) return texture2D(tScene, c).rgb;
  vec2 h = 0.25 / uCells;
  vec3 s = texture2D(tScene, c + vec2(-h.x, -h.y)).rgb;
  s += texture2D(tScene, c + vec2( h.x, -h.y)).rgb;
  s += texture2D(tScene, c + vec2(-h.x,  h.y)).rgb;
  s += texture2D(tScene, c + vec2( h.x,  h.y)).rgb;
  return s * 0.25;
}

/** vizinho para o Sobel: UMA leitura. Antes eram 4 por vizinho — 36 leituras
 *  de textura por pixel de tela, o que sozinho matava GPU antiga. */
float lumAt(vec2 cell) {
  return luma(texture2D(tScene, (cell + 0.5) / uCells).rgb);
}

void main() {
  vec2 uv = vUv;

  // ---- glitch: bandas horizontais deslocadas + rasgo vertical ocasional
  if (uGlitch > 0.001) {
    float band = floor(uv.y * 42.0);
    float n = hash(vec2(band, floor(uTime * 17.0)));
    float amt = step(1.0 - uGlitch * 0.55, n) * (n - 0.5) * 0.09 * uGlitch;
    uv.x += amt;
    uv.y += (hash(vec2(floor(uTime * 9.0), 3.0)) - 0.5) * 0.01 * uGlitch;
  }

  vec2 cell = floor(uv * uCells);
  vec2 cellUv = fract(uv * uCells);

  vec3 scene = sampleCenter(cell);
  float l = luma(scene);

  // ---- Sobel sobre a vizinhanca 3x3 de CELULAS (contorno grosso, proposital)
  float gx = 0.0;
  float gy = 0.0;
  float mag = 0.0;

  if (uEdges > 0.5) {
    float l00 = lumAt(cell + vec2(-1.0, -1.0));
    float l10 = lumAt(cell + vec2( 0.0, -1.0));
    float l20 = lumAt(cell + vec2( 1.0, -1.0));
    float l01 = lumAt(cell + vec2(-1.0,  0.0));
    float l21 = lumAt(cell + vec2( 1.0,  0.0));
    float l02 = lumAt(cell + vec2(-1.0,  1.0));
    float l12 = lumAt(cell + vec2( 0.0,  1.0));
    float l22 = lumAt(cell + vec2( 1.0,  1.0));

    gx = (l00 + 2.0 * l01 + l02) - (l20 + 2.0 * l21 + l22);
    gy = (l00 + 2.0 * l10 + l20) - (l02 + 2.0 * l12 + l22);
    mag = length(vec2(gx, gy));
  }

  // ---- curva de tom: escurece o meio-tom, preserva o brilho especular
  float tone = pow(clamp(l * 1.32, 0.0, 1.0), 0.78);

  float index;
  bool isEdge = uEdges > 0.5 && mag > uEdge && tone > 0.035;

  if (isEdge) {
    // direcao da ARESTA = gradiente + 90deg, dobrada em [0, PI)
    float ang = atan(gy, gx) + 1.57079633;
    ang = mod(ang, 3.14159265) / 3.14159265;      // 0..1
    float bucket = mod(floor(ang * 4.0 + 0.5), 4.0);
    index = uRamp + bucket;
  } else {
    index = floor(tone * (uRamp - 0.001));
  }

  vec2 gUv = vec2((index + cellUv.x) / uCount, 1.0 - cellUv.y);
  float ink = texture2D(tGlyphs, gUv).r;

  // ---- cor: o proprio tom da cena decide se puxa para sangue ou frio
  float warm = clamp((scene.r - scene.b) * 2.2, 0.0, 1.0);
  float cold = clamp((scene.b - scene.r) * 2.6, 0.0, 1.0);
  vec3 tint = uPhosphor;
  tint = mix(tint, uBlood, max(warm * 0.85, uDanger * 0.45));
  tint = mix(tint, uCold, cold * 0.9);

  float bright = isEdge ? (0.42 + 0.85 * tone + min(mag, 0.6)) : (0.16 + 1.05 * tone);
  vec3 col = tint * ink * bright;

  // sangramento de fosforo: um resto da cena vaza entre os glifos
  col += scene * 0.055 * (0.4 + tone);

  // ---- scanline + flicker por celula + cintilacao global
  float scan = 0.86 + 0.14 * sin(gl_FragCoord.y * 3.14159265);
  float flick = 0.94 + 0.06 * hash(cell + floor(uTime * 24.0));
  float mains = 0.965 + 0.035 * sin(uTime * 61.7) + uDanger * 0.03 * sin(uTime * 7.3);
  col *= scan * flick * mains;

  // aberracao cromatica sutil nas bordas da tela (so em qualidade alta)
  if (uEdges > 0.5) {
    float r = length(vUv - 0.5);
    col.r *= 1.0 + r * 0.10;
    col.b *= 1.0 - r * 0.06;
  }

  // gamma
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));

  gl_FragColor = vec4(col, 1.0);
}
`;

export class AsciiPass {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;

  constructor(atlas: Atlas) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: null },
        tGlyphs: { value: atlas.texture },
        uCells: { value: new THREE.Vector2(160, 60) },
        uCount: { value: atlas.count },
        uRamp: { value: atlas.rampCount },
        uTime: { value: 0 },
        uDanger: { value: 0 },
        uGlitch: { value: 0 },
        uEdge: { value: 0.1 },
        uEdges: { value: 1 },
        uSuper: { value: 1 },
        uPhosphor: { value: new THREE.Color(1.0, 0.72, 0.34) },
        uBlood: { value: new THREE.Color(1.0, 0.2, 0.13) },
        uCold: { value: new THREE.Color(0.42, 0.92, 0.86) },
      },
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setSource(tex: THREE.Texture, cols: number, rows: number): void {
    this.material.uniforms.tScene!.value = tex;
    (this.material.uniforms.uCells!.value as THREE.Vector2).set(cols, rows);
  }

  /** Modo desempenho: sem Sobel, sem supersample, sem aberração cromática. */
  setQuality(high: boolean): void {
    this.material.uniforms.uEdges!.value = high ? 1 : 0;
    this.material.uniforms.uSuper!.value = high ? 1 : 0;
  }

  set(time: number, danger: number, glitch: number): void {
    this.material.uniforms.uTime!.value = time;
    this.material.uniforms.uDanger!.value = danger;
    this.material.uniforms.uGlitch!.value = glitch;
  }
}
