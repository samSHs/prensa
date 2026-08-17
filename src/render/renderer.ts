import * as THREE from 'three';
import { buildAtlas } from './fontAtlas';
import { AsciiPass } from './asciiPass';

/**
 * A cena 3D é renderizada num alvo de resolução ridiculamente baixa —
 * exatamente 2x a grade de caracteres. Isso é de propósito: a "resolução"
 * final do jogo é a grade, então renderizar em 1080p seria jogar pixels fora.
 * Efeito colateral feliz: roda a 200fps num notebook velho.
 */

const CELL_W = 8;
const CELL_H = 14;

/**
 * O custo do jogo NÃO é a cena 3D (ela é renderizada num alvo minúsculo).
 * É o passe ASCII, que roda em cada pixel da tela. Modo desempenho ataca as
 * duas variáveis que importam: leituras de textura por pixel e quantidade
 * de pixels.
 */
export interface Quality {
  /** supersample do render target por eixo */
  ss: number;
  /** escala do buffer da tela (CSS estica de volta) */
  scale: number;
  /** detecção de arestas no shader */
  edges: boolean;
}

export const QUALITY_HIGH: Quality = { ss: 2, scale: 1, edges: true };
export const QUALITY_LOW: Quality = { ss: 1, scale: 0.7, edges: false };

export class AsciiRenderer {
  readonly gl: THREE.WebGLRenderer;
  readonly pass: AsciiPass;
  private rt: THREE.WebGLRenderTarget;
  cols = 0;
  rows = 0;
  private quality: Quality = QUALITY_HIGH;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.gl.setPixelRatio(1);
    this.gl.autoClear = true;

    this.rt = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
    });

    this.pass = new AsciiPass(buildAtlas(CELL_W, CELL_H));
    this.pass.setQuality(this.quality.edges);
    this.resize();
  }

  get aspect(): number {
    return this.cols * CELL_W / Math.max(1, this.rows * CELL_H);
  }

  /** Troca de qualidade em tempo real; nao recria nada de GPU pesado. */
  setQuality(q: Quality): void {
    this.quality = q;
    this.pass.setQuality(q.edges);
    this.resize();
  }

  get isHigh(): boolean {
    return this.quality.edges;
  }

  resize(): void {
    const w = Math.max(320, window.innerWidth);
    const h = Math.max(240, window.innerHeight);
    const q = this.quality;

    // A grade de caracteres acompanha o TAMANHO CSS, nao o buffer: em modo
    // desempenho o jogo continua com o mesmo numero de colunas, so que
    // rasterizado em menos pixels e esticado. Layout identico, custo menor.
    this.cols = Math.max(40, Math.floor(w / CELL_W));
    this.rows = Math.max(20, Math.floor(h / CELL_H));

    const bw = Math.round(w * q.scale);
    const bh = Math.round(h * q.scale);
    this.gl.setSize(bw, bh, false);
    const c = this.gl.domElement;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;

    this.rt.setSize(this.cols * q.ss, this.rows * q.ss);
    this.pass.setSource(this.rt.texture, this.cols, this.rows);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, time: number, danger: number, glitch: number): void {
    this.gl.setRenderTarget(this.rt);
    this.gl.clear();
    this.gl.render(scene, camera);

    this.gl.setRenderTarget(null);
    this.pass.set(time, danger, glitch);
    this.gl.render(this.pass.scene, this.pass.camera);
  }
}
