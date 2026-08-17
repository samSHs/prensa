import * as THREE from 'three';
import { clamp, lerp } from '../core/rng';

/**
 * Geometria do abatedouro.
 *
 * Tudo é bloco. O passe ASCII come detalhe fino, então o que importa aqui é
 * silhueta, contraste e movimento: a prensa é uma massa preta que engole a luz,
 * o sujeito é um vulto claro, e o Zelador é um recorte escuro contra a janela
 * acesa da cabine — a única coisa na sala que olha de volta.
 *
 * Eixo X: prensa em 0, esteira correndo para +X, escotilha no fim.
 * Câmera fica em +Z olhando para a lateral, como uma CFTV mal posicionada.
 */

export interface WorldView {
  /** metros entre o sujeito e o prato da prensa */
  distance: number;
  hatch: number;
  /** m/s; positivo = puxando para a prensa */
  beltVel: number;
  /** 0..1 dentro do ciclo da prensa */
  pressPhase: number;
  danger: number;
  time: number;
  /** decai de 1 a 0 depois de cada impacto */
  slam: number;
  /** 1 enquanto o Zelador fala */
  voice: number;
  shake: number;
  dead: boolean;
  escaped: boolean;
  /** segundos desde o esmagamento; 0 enquanto vivo */
  crush: number;
  /** chaves digitais que já soltaram as travas da escotilha */
  keys?: number;
  keysNeeded?: number;
}

const PRESS_IMPACT_PHASE = 0.72;

const dark = (c: number, rough = 0.92, metal = 0.25) =>
  new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: metal });

export class World {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private ram: THREE.Group;
  private ramLight: THREE.PointLight;
  private pressLamp: THREE.SpotLight;
  private subject: THREE.Group;
  private workLamp: THREE.PointLight;
  private slats: THREE.InstancedMesh;
  private slatOffset = 0;
  private warnStrips: THREE.MeshStandardMaterial;
  private boothPanel: THREE.MeshBasicMaterial;
  private boothLight: THREE.PointLight;
  private keeper: THREE.Group;
  private keeperHead: THREE.Group;
  private horns: THREE.MeshStandardMaterial;
  private hatchGlow: THREE.MeshBasicMaterial;
  private hatchLight: THREE.PointLight;
  private hatchLocks: THREE.Mesh[] = [];
  private sparks: Sparks;
  private dust: THREE.Points;
  private crushFrom = -1;
  private camShake = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private tmpP = new THREE.Vector3();

  constructor(aspect: number, hatch: number) {
    const s = this.scene;
    s.background = new THREE.Color(0x040303);
    s.fog = new THREE.FogExp2(0x070505, 0.019);

    this.camera = new THREE.PerspectiveCamera(46, aspect, 0.1, 260);

    // ---------------------------------------------------------------- sala
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(96, 22, 34),
      new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 1, metalness: 0, side: THREE.BackSide }),
    );
    shell.position.set(hatch * 0.5 + 2, 9, 0);
    s.add(shell);

    // pilares de concreto ao fundo — dão paralaxe e cortam a luz
    for (let i = 0; i < 7; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.6, 18, 1.6), dark(0x2e2825, 1, 0));
      p.position.set(-6 + i * 8.5, 9, -11.5);
      s.add(p);
    }

    // ---------------------------------------------------------------- esteira
    const beltMat = dark(0x3a322c, 0.95, 0.15);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(hatch + 14, 0.5, 3.6), beltMat);
    belt.position.set((hatch + 14) / 2 - 5, 0.25, 0);
    s.add(belt);

    const railMat = dark(0x5a4d44, 0.7, 0.6);
    for (const z of [-2.05, 2.05]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(hatch + 14, 0.9, 0.3), railMat);
      rail.position.set((hatch + 14) / 2 - 5, 0.6, z);
      s.add(rail);
    }

    // pernas da estrutura
    for (let x = -3; x < hatch + 8; x += 4.5) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.2, 0.35), railMat);
      leg.position.set(x, -0.6, 1.7);
      s.add(leg);
      const leg2 = leg.clone();
      leg2.position.z = -1.7;
      s.add(leg2);
    }

    // ripas que correm — a leitura de velocidade do jogador vem daqui
    const SLATS = 120;
    this.slats = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.3, 0.14, 3.5),
      dark(0x6b5c50, 0.85, 0.4),
      SLATS,
    );
    this.slats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    s.add(this.slats);

    // ---------------------------------------------------------------- prensa
    const press = new THREE.Group();
    const frameMat = dark(0x3d3733, 0.85, 0.55);

    for (const z of [-3.2, 3.2]) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(1.5, 13, 1.5), frameMat);
      col.position.set(0, 6.5, z);
      press.add(col);
    }
    const crown = new THREE.Mesh(new THREE.BoxGeometry(5.4, 2.2, 8.4), frameMat);
    crown.position.set(0, 12.4, 0);
    press.add(crown);

    // bigorna: o sujeito é empurrado exatamente para cima dela
    const anvil = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.6, 5.2), dark(0x2b2523, 0.8, 0.7));
    anvil.position.set(0, -0.35, 0);
    press.add(anvil);

    // faixas de advertência (emissivas — viram um filete branco no ASCII)
    this.warnStrips = new THREE.MeshStandardMaterial({
      color: 0x2a1a08,
      emissive: new THREE.Color(0xff6a10),
      emissiveIntensity: 1.4,
      roughness: 1,
    });
    for (const z of [-3.2, 3.2]) {
      for (let i = 0; i < 4; i++) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.16, 1.56), this.warnStrips);
        strip.position.set(0, 1.2 + i * 0.55, z);
        press.add(strip);
      }
    }

    // martelo
    this.ram = new THREE.Group();
    const ramBody = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.0, 4.8), dark(0x211d1b, 0.7, 0.8));
    this.ram.add(ramBody);
    const ramFace = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.5, 5.2), dark(0x6a5a52, 0.4, 0.95));
    ramFace.position.y = -1.6;
    this.ram.add(ramFace);
    for (const z of [-1.6, 0, 1.6]) {
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 9, 6), dark(0x8a7d72, 0.35, 0.9));
      piston.position.set(0, 5.2, z);
      this.ram.add(piston);
    }
    this.ram.position.set(0, 7.6, 0);
    press.add(this.ram);

    this.ramLight = new THREE.PointLight(0xff3a18, 0, 26, 2);
    this.ramLight.position.set(0, 2.4, 0);
    press.add(this.ramLight);

    this.pressLamp = new THREE.SpotLight(0xffd9a0, 900, 40, 0.7, 0.6, 1.2);
    this.pressLamp.position.set(0, 13, 0);
    this.pressLamp.target.position.set(0, 0, 0);
    press.add(this.pressLamp, this.pressLamp.target);

    s.add(press);

    // ---------------------------------------------------------------- sujeito
    this.subject = buildSubject();
    s.add(this.subject);

    this.workLamp = new THREE.PointLight(0xffc07a, 260, 22, 2);
    this.workLamp.position.set(0, 3.4, 2.2);
    s.add(this.workLamp);

    // ---------------------------------------------------------------- cabine
    const booth = new THREE.Group();
    booth.position.set(hatch * 0.42, 8.6, -12.2);

    this.boothPanel = new THREE.MeshBasicMaterial({ color: 0xffa040 });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(11, 5.2), this.boothPanel);
    glow.position.z = -0.9;
    booth.add(glow);

    const boothFrame = new THREE.Mesh(new THREE.BoxGeometry(12.6, 6.6, 0.5), dark(0x0a0908, 1, 0));
    boothFrame.position.z = -1.4;
    booth.add(boothFrame);

    // grade vertical: corta a luz em tiras, o ASCII adora
    for (let i = -5; i <= 5; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 5.2, 0.16), dark(0x090807, 1, 0));
      bar.position.set(i * 1.05, 0, -0.4);
      booth.add(bar);
    }

    this.keeper = new THREE.Group();
    this.keeperHead = buildKeeper(this.keeper);
    this.keeper.position.set(0, -1.5, -0.55);
    booth.add(this.keeper);

    this.boothLight = new THREE.PointLight(0xff9a44, 420, 60, 2);
    this.boothLight.position.set(0, 0, 2.4);
    booth.add(this.boothLight);

    s.add(booth);

    // ---------------------------------------------------------------- alto-falantes
    this.horns = new THREE.MeshStandardMaterial({
      color: 0x1a1512,
      emissive: new THREE.Color(0xff7a2a),
      emissiveIntensity: 0,
      roughness: 1,
    });
    for (const [x, z] of [[4, -10.5], [hatch * 0.75, -10.5], [hatch * 0.3, 10.5]] as const) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(1.0, 1.9, 8, 1, true), this.horns);
      horn.rotation.z = Math.PI / 2;
      horn.rotation.y = z > 0 ? Math.PI : 0;
      horn.position.set(x, 11.5, z);
      s.add(horn);
    }

    // ---------------------------------------------------------------- escotilha
    const hatchFrame = new THREE.Mesh(new THREE.BoxGeometry(0.6, 6.4, 5.4), dark(0x0b0a09, 1, 0));
    hatchFrame.position.set(hatch + 3.2, 3.0, 0);
    s.add(hatchFrame);

    this.hatchGlow = new THREE.MeshBasicMaterial({ color: 0x741d15 });
    const hatchGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.2, 5.4),
      this.hatchGlow,
    );
    hatchGlow.rotation.y = -Math.PI / 2;
    hatchGlow.position.set(hatch + 2.85, 3.0, 0);
    s.add(hatchGlow);

    this.hatchLight = new THREE.PointLight(0xff3f2f, 120, 22, 2);
    this.hatchLight.position.set(hatch + 1.6, 3.0, 0);
    s.add(this.hatchLight);

    // Quatro ferrolhos luminosos deixam a condição da saída legível no próprio
    // mundo, não só no HUD. Eles somem um a um quando uma missão rende chave.
    for (let i = 0; i < 4; i++) {
      const lockMat = new THREE.MeshStandardMaterial({
        color: 0x2a0d0a,
        emissive: new THREE.Color(0xff3020),
        emissiveIntensity: 2.2,
        roughness: 0.65,
        metalness: 0.75,
      });
      const lock = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.38, 4.65), lockMat);
      lock.position.set(hatch + 2.52, 1.15 + i * 1.22, 0);
      lock.userData.lockIndex = i;
      this.hatchLocks.push(lock);
      s.add(lock);
    }

    // ---------------------------------------------------------------- luz geral
    s.add(new THREE.AmbientLight(0x6b4a30, 1.5));

    const rim = new THREE.DirectionalLight(0x8fb0cc, 1.5);
    rim.position.set(-12, 14, -18);
    s.add(rim);

    const fill = new THREE.DirectionalLight(0xffa860, 0.55);
    fill.position.set(20, 8, 16);
    s.add(fill);

    // ---------------------------------------------------------------- partículas
    this.sparks = new Sparks(300);
    s.add(this.sparks.points);
    this.dust = buildDust(hatch);
    s.add(this.dust);
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Modo desempenho no lado da cena: menos partículas e menos ripas. A cena
   * 3D é barata (o alvo é minúsculo), mas em GPU antiga cada draw call ainda
   * pesa, e poeira/faísca são o que menos faz falta.
   */
  setDetail(high: boolean): void {
    this.dust.visible = high;
    this.sparks.points.visible = high;
    this.slats.count = high ? this.slats.instanceMatrix.count : Math.floor(this.slats.instanceMatrix.count / 3);
  }

  onSlam(): void {
    this.sparks.burst(new THREE.Vector3(0, 0.9, 0), 90);
  }

  update(dt: number, v: WorldView): void {
    const t = v.time;

    // ---- martelo
    const charging = chargeOf(v.pressPhase);

    if (v.crush > 0) {
      // Morte: o ciclo acaba. A massa desce até abaixo da linha da esteira e
      // NÃO sobe mais — o peso parado é o que vende o golpe, não a queda.
      if (this.crushFrom < 0) this.crushFrom = this.ram.position.y;
      const k = clamp(v.crush / 0.16, 0, 1);
      const settle = clamp((v.crush - 0.16) / 2.2, 0, 1);
      this.ram.position.y = lerp(this.crushFrom, RAM_BOTTOM - 0.62, k * k) - settle * 0.16;
      this.ramLight.intensity = 380 * Math.exp(-v.crush * 0.8);
      this.pressLamp.intensity = 60 + 900 * Math.exp(-v.crush * 2.4);
      this.warnStrips.emissiveIntensity = 3.2 * Math.exp(-v.crush * 0.5);
    } else {
      this.crushFrom = -1;
      this.ram.position.y = ramHeight(v.pressPhase);
      this.ramLight.intensity = 4 + charging * charging * 90 + v.slam * 160;
      this.pressLamp.intensity = 620 + v.slam * 900;
      this.warnStrips.emissiveIntensity =
        0.5 + 2.2 * (0.5 + 0.5 * Math.sin(t * (5 + v.danger * 16))) * (0.35 + charging);
    }

    // ---- ripas da esteira
    this.slatOffset = (this.slatOffset - v.beltVel * dt * 1.35) % 0.9;
    const span = 132;
    for (let i = 0; i < this.slats.count; i++) {
      const x = -6 + ((i * 0.9 + this.slatOffset + span) % span);
      this.tmpP.set(x, 0.53, 0);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.slats.setMatrixAt(i, this.tmpM);
    }
    this.slats.instanceMatrix.needsUpdate = true;

    // ---- sujeito
    const px = v.distance;
    this.subject.position.set(px, 0.5, 0);
    const panic = clamp(1 - v.distance / 9, 0, 1);
    const struggle = v.dead ? 0 : (0.5 + panic * 2.6);
    this.subject.rotation.z = Math.sin(t * (3 + panic * 9)) * 0.02 * struggle;
    this.subject.children.forEach((c, i) => {
      if (c.userData.limb) {
        c.rotation.x = Math.sin(t * (5 + panic * 12) + i) * 0.16 * struggle;
      }
    });
    // achatado quando morre, sumido quando escapa — reversível para o restart
    this.subject.scale.y = v.dead ? 0.2 : 1;
    this.subject.position.y = v.dead ? 0.42 : 0.5;
    this.subject.visible = !v.escaped;

    this.workLamp.position.set(px + 1.5, 3.6, 2.6);
    this.workLamp.intensity = 7 + Math.sin(t * 37) * 0.7 + v.slam * 8;

    // ---- Zelador: balança devagar, vira a cabeça para acompanhar o sujeito
    this.keeper.position.y = -1.5 + Math.sin(t * 0.7) * 0.05;
    this.keeperHead.rotation.y = clamp((px - 12) * 0.02, -0.5, 0.5) + Math.sin(t * 0.31) * 0.09;
    this.keeperHead.rotation.z = Math.sin(t * 0.23) * 0.03;

    const boothPulse = 0.62 + 0.38 * Math.sin(t * 2.1) * (v.voice > 0 ? 1 : 0.18);
    this.boothPanel.color.setRGB(1.0 * boothPulse, 0.6 * boothPulse, 0.24 * boothPulse);
    this.boothLight.intensity = 10 + v.voice * 12 + Math.sin(t * 31) * 0.8;
    this.horns.emissiveIntensity = v.voice * (1.4 + Math.sin(t * 44) * 0.5);

    // ---- escotilha: vermelha e gradeada enquanto faltam chaves; ciano frio
    // quando o último ferrolho cai.
    const keysNeeded = Math.max(1, v.keysNeeded ?? 4);
    const keys = clamp(v.keys ?? 0, 0, keysNeeded);
    const unlocked = keys >= keysNeeded;
    this.hatchGlow.color.setHex(unlocked ? 0x3fe0d0 : 0x741d15);
    this.hatchLight.color.setHex(unlocked ? 0x50e8d6 : 0xff3f2f);
    this.hatchLight.intensity = unlocked
      ? 300 + Math.sin(t * 2.4) * 35
      : 90 + Math.sin(t * (2.8 + keys)) * 28;
    for (const lock of this.hatchLocks) {
      const lockIndex = lock.userData.lockIndex as number;
      lock.visible = lockIndex >= keys;
      const mat = lock.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 1.5 + Math.max(0, Math.sin(t * 4.5 + lockIndex)) * 1.8;
    }

    // ---- partículas
    this.sparks.update(dt);
    (this.dust.material as THREE.PointsMaterial).opacity = 0.08 + v.danger * 0.12;
    this.dust.rotation.y += dt * 0.006;

    // ---- câmera: mantém prensa (x=0) E sujeito (x=px) no quadro ao mesmo
    // tempo. Meia-abertura horizontal ≈ 35°, então tan ≈ 0.70 dá a distância
    // mínima para caber a metade da cena mais uma margem.
    const cx = px * 0.5;
    const back = clamp((px * 0.5 + 5.5) / 0.7, 12, 32);
    const shakeAmt = v.shake + v.slam * 0.5;
    this.camShake.set(
      (Math.random() - 0.5) * shakeAmt,
      (Math.random() - 0.5) * shakeAmt,
      (Math.random() - 0.5) * shakeAmt * 0.4,
    );

    // na morte a câmera abandona o enquadramento e cai em cima da bigorna
    const crushing = v.crush > 0;
    const targetX = crushing ? 4.4 : cx + 2.4 + Math.sin(t * 0.19) * 0.5;
    const targetY = crushing ? 3.1 : 6.1 + px * 0.06 + Math.sin(t * 0.27) * 0.16;
    const targetZ = crushing ? 8.4 : back;
    const ease = 1 - Math.pow(crushing ? 0.05 : 0.001, dt);

    this.camera.position.set(
      lerp(this.camera.position.x, targetX, ease) + this.camShake.x,
      lerp(this.camera.position.y, targetY, ease) + this.camShake.y,
      lerp(this.camera.position.z, targetZ, ease) + this.camShake.z,
    );
    // mira ABAIXO da esteira de propósito: joga a linha da esteira para o
    // terço superior do quadro, onde o terminal não cobre
    this.camera.lookAt(crushing ? 0 : cx + 0.2, crushing ? 1.2 : -0.9 + v.slam * 0.4, 0);
    this.camera.rotation.z += Math.sin(t * 0.41) * 0.006 + this.camShake.x * 0.01;
  }
}

const RAM_TOP = 7.6;
const RAM_BOTTOM = 1.35;

/**
 * Curva do martelo, medida A PARTIR do instante do impacto.
 *
 * Isso não é estilo: a versão anterior colocava a queda DEPOIS de
 * PRESS_IMPACT_PHASE, então o estrondo, o clarão e a morte disparavam com a
 * massa ainda lá em cima — e como a morte congela o ciclo, o martelo ficava
 * pendurado no ar para sempre. `p = 0` tem que ser o fundo.
 */
function ramHeight(phase: number): number {
  const p = (((phase - PRESS_IMPACT_PHASE) % 1) + 1) % 1;

  if (p < 0.06) {
    // fundo: bate e ricocheteia dentro do curso
    return RAM_BOTTOM + Math.sin((p / 0.06) * Math.PI) * 0.16;
  }
  if (p < 0.22) {
    // recuo pesado
    const k = (p - 0.06) / 0.16;
    return lerp(RAM_BOTTOM, RAM_TOP, k * k * (3 - 2 * k));
  }
  if (p < 0.66) {
    // espera no alto — quase imóvel, só um tremor de bomba ligada
    return RAM_TOP + Math.sin(p * 47) * 0.035;
  }
  if (p < 0.90) {
    // ENGATILHA: sobe visivelmente e vibra. É o aviso de que vai cair.
    const k = (p - 0.66) / 0.24;
    return RAM_TOP + 1.05 * k * k + Math.sin(p * 120) * 0.09 * k;
  }
  // queda livre — 10% do ciclo, o suficiente para o olho registrar o borrão
  const k = (p - 0.90) / 0.10;
  return lerp(RAM_TOP + 1.05, RAM_BOTTOM, k * k);
}

/** 0..1 conforme a prensa engatilha; 1 no instante da queda */
function chargeOf(phase: number): number {
  const p = (((phase - PRESS_IMPACT_PHASE) % 1) + 1) % 1;
  return clamp((p - 0.6) / 0.4, 0, 1);
}

export const pressImpactPhase = PRESS_IMPACT_PHASE;

/** Corpo amarrado à esteira. Peças grandes: o ASCII não lê dedos. */
function buildSubject(): THREE.Group {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8c9a6, roughness: 0.85, metalness: 0 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0xcfccc2, roughness: 1, metalness: 0 });
  const strap = new THREE.MeshStandardMaterial({ color: 0x241c16, roughness: 1, metalness: 0.2 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.52, 0.86), cloth);
  torso.position.set(0.1, 0.28, 0);
  g.add(torso);

  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.46, 0.8), cloth);
  hips.position.set(1.05, 0.26, 0);
  g.add(hips);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 10, 8), skin);
  head.position.set(-0.95, 0.34, 0);
  g.add(head);

  for (const z of [-0.52, 0.52]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.24, 0.24), skin);
    arm.position.set(-0.05, 0.24, z);
    arm.userData.limb = true;
    g.add(arm);

    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 0.3), cloth);
    leg.position.set(1.9, 0.24, z * 0.55);
    leg.userData.limb = true;
    g.add(leg);
  }

  for (const x of [-0.4, 0.55, 1.7]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.62, 1.1), strap);
    s.position.set(x, 0.26, 0);
    g.add(s);
  }

  return g;
}

/** Silhueta na janela: casaco longo, máscara de gás, aba de chapéu. */
function buildKeeper(parent: THREE.Group): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, metalness: 0 });

  const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 1.05, 3.0, 7), mat);
  coat.position.y = 1.5;
  parent.add(coat);

  const shoulders = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.42, 0.7), mat);
  shoulders.position.y = 2.85;
  parent.add(shoulders);

  const head = new THREE.Group();
  head.position.y = 3.3;

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.44, 10, 8), mat);
  head.add(skull);

  // filtro/bico — a assinatura da máscara
  const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.3, 0.95, 7), mat);
  snout.rotation.x = Math.PI / 2.05;
  snout.position.set(0, -0.16, 0.55);
  head.add(snout);

  // lentes: levemente emissivas, dois pontos vivos num recorte preto
  const lens = new THREE.MeshStandardMaterial({
    color: 0x100804,
    emissive: new THREE.Color(0xffe0a0),
    emissiveIntensity: 0.9,
    roughness: 0.3,
  });
  for (const x of [-0.24, 0.24]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.145, 8, 6), lens);
    l.position.set(x, 0.06, 0.36);
    head.add(l);
  }

  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.09, 12), mat);
  brim.position.y = 0.42;
  head.add(brim);

  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.5, 10), mat);
  crown.position.y = 0.66;
  head.add(crown);

  parent.add(head);
  return head;
}

function buildDust(hatch: number): THREE.Points {
  const N = 260;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = -8 + Math.random() * (hatch + 22);
    pos[i * 3 + 1] = Math.random() * 15;
    pos[i * 3 + 2] = -12 + Math.random() * 24;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffcc99,
    size: 0.06,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

class Sparks {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private head = 0;

  constructor(private n: number) {
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = -999;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: 0xffd08a, size: 0.14, transparent: true, opacity: 0.95, depthWrite: false }),
    );
  }

  burst(at: THREE.Vector3, count: number): void {
    for (let k = 0; k < count; k++) {
      const i = this.head = (this.head + 1) % this.n;
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * 3.2;
      this.pos[i * 3 + 1] = at.y + Math.random() * 0.4;
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * 4.2;
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 10;
      this.vel[i * 3] = Math.cos(a) * sp;
      this.vel[i * 3 + 1] = 2 + Math.random() * 7;
      this.vel[i * 3 + 2] = Math.sin(a) * sp * 0.8;
      this.life[i] = 0.6 + Math.random() * 0.9;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 22 * dt;
      this.pos[i * 3] += this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2]! * dt;
      if (this.pos[i * 3 + 1]! < 0.55) {
        this.pos[i * 3 + 1] = 0.55;
        this.vel[i * 3 + 1] = Math.abs(this.vel[i * 3 + 1]!) * 0.32;
        this.vel[i * 3] *= 0.7;
      }
      if (this.life[i]! <= 0) this.pos[i * 3 + 1] = -999;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}
