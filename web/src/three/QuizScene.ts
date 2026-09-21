import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type RevealKind = 'correct' | 'wrong' | 'identical';

export interface QuizSceneOptions {
  canvas: HTMLCanvasElement;
}

const CARD_W = 6.4;
const CARD_H = 3.6;
const CARD_D = 0.16;

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const SERIF = 'ui-serif, Georgia, "Times New Roman", serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function makeCanvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export class QuizScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private clock = new THREE.Clock();
  private frameId = 0;
  private disposed = false;
  private idleMode = false;

  private cardGroup: THREE.Group;
  private frontMaterial: THREE.MeshStandardMaterial;
  private backMaterial: THREE.MeshStandardMaterial;
  private sideMaterial: THREE.MeshStandardMaterial;
  private invisibleMaterial: THREE.MeshBasicMaterial;
  private frontTexture: THREE.CanvasTexture | null = null;
  private backTexture: THREE.CanvasTexture | null = null;

  private stamp: THREE.Mesh;
  private stampMaterial: THREE.MeshBasicMaterial;
  private stampTexture: THREE.CanvasTexture | null = null;
  private stampScale = 0;
  private stampTarget = 0;

  private ring: THREE.Mesh;
  private ringMaterial: THREE.MeshBasicMaterial;
  private glowPlane: THREE.Mesh;
  private glowMaterial: THREE.MeshBasicMaterial;

  private panelA: THREE.Mesh;
  private panelB: THREE.Mesh;
  private panelAMaterial: THREE.MeshStandardMaterial;
  private panelBMaterial: THREE.MeshStandardMaterial;

  private stars: THREE.Points;

  private pointer = new THREE.Vector2(0, 0);
  private tilt = new THREE.Vector2(0, 0);
  private targetTilt = new THREE.Vector2(0, 0);
  private flip = 0;
  private targetFlip = 0;
  private ringPulse = 0;
  private ringActive = false;
  private ringColor = new THREE.Color(0x4ade80);
  private flareA = 0;
  private flareB = 0;
  private panelTargetOpacity = 0;
  private panelOpacity = 0;
  private cardScale = 0;
  private cardTargetScale = 1;

  private onPointerMove: (e: PointerEvent) => void;
  private onResize: () => void;

  constructor(options: QuizSceneOptions) {
    const canvas = options.canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060f, 0.03);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(0, 0, 9.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 20;
    this.controls.enabled = false;

    // ---------------------------------------------------------------- lights
    this.scene.add(new THREE.AmbientLight(0x8fa2ff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 5, 8);
    this.scene.add(key);
    const rimA = new THREE.PointLight(0x5b8cff, 26, 30);
    rimA.position.set(-6.5, 2.5, 4.5);
    this.scene.add(rimA);
    const rimB = new THREE.PointLight(0xff6ec7, 22, 30);
    rimB.position.set(6.5, -2.5, 4.5);
    this.scene.add(rimB);

    // ----------------------------------------------------------------- stars
    const starCount = 1100;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 80;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 50;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50 - 14;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        color: 0x9fb4ff,
        size: 0.075,
        transparent: true,
        opacity: 0.65,
        sizeAttenuation: true,
      }),
    );
    this.scene.add(this.stars);

    // ------------------------------------------------------------ glow plane
    this.glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x4f7dff,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(12, 7.5), this.glowMaterial);
    this.glowPlane.position.z = -1.8;
    this.scene.add(this.glowPlane);

    // ------------------------------------------------------------------ card
    this.cardGroup = new THREE.Group();
    this.scene.add(this.cardGroup);

    this.frontMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.45,
      metalness: 0.05,
    });
    this.sideMaterial = new THREE.MeshStandardMaterial({
      color: 0xdfe4f5,
      roughness: 0.5,
      metalness: 0.1,
    });
    this.backMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.4,
      metalness: 0.08,
    });
    // Makes the box's rear face invisible so the flip reveals the back plate.
    this.invisibleMaterial = new THREE.MeshBasicMaterial({ visible: false });

    const boxGeo = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, 6, 0.16);
    // BoxGeometry material order: +x, -x, +y, -y, +z (front), -z (back)
    const boxMaterials = [
      this.sideMaterial,
      this.sideMaterial,
      this.sideMaterial,
      this.sideMaterial,
      this.frontMaterial,
      this.invisibleMaterial,
    ];
    const cardBox = new THREE.Mesh(boxGeo, boxMaterials);
    this.cardGroup.add(cardBox);

    const backGeo = new THREE.PlaneGeometry(CARD_W - 0.08, CARD_H - 0.08);
    const backPlate = new THREE.Mesh(backGeo, this.backMaterial);
    backPlate.rotation.y = Math.PI;
    backPlate.position.z = -CARD_D / 2 - 0.004;
    this.cardGroup.add(backPlate);

    // ------------------------------------------------------------ stamp
    this.stampMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    this.stamp = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.5), this.stampMaterial);
    this.stamp.position.set(0, -0.05, CARD_D / 2 + 0.02);
    this.stamp.renderOrder = 10;
    this.cardGroup.add(this.stamp);

    // ------------------------------------------------------------- ring
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(4.1, 4.34, 96), this.ringMaterial);
    this.ring.position.z = -0.4;
    this.scene.add(this.ring);

    // ------------------------------------------------------- guess panels
    const panelGeo = new RoundedBoxGeometry(3.5, 1.5, 0.22, 5, 0.12);
    this.panelAMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a4fd8,
      emissive: new THREE.Color(0x2f6bff),
      emissiveIntensity: 0.55,
      roughness: 0.3,
      metalness: 0.35,
      transparent: true,
      opacity: 0,
    });
    this.panelBMaterial = new THREE.MeshStandardMaterial({
      color: 0xd82a86,
      emissive: new THREE.Color(0xff3fa4),
      emissiveIntensity: 0.55,
      roughness: 0.3,
      metalness: 0.35,
      transparent: true,
      opacity: 0,
    });
    this.panelA = new THREE.Mesh(panelGeo, this.panelAMaterial);
    this.panelA.position.set(-2.55, -3.15, 0.7);
    this.panelA.rotation.x = -0.1;
    this.panelB = new THREE.Mesh(panelGeo, this.panelBMaterial);
    this.panelB.position.set(2.55, -3.15, 0.7);
    this.panelB.rotation.x = -0.1;
    this.scene.add(this.panelA, this.panelB);

    // ------------------------------------------------------------ listeners
    this.onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      const y = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1;
      this.pointer.set(x, y);
      this.targetTilt.set(y * 0.16, x * 0.28);
    };
    this.onResize = () => this.resize();
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.animate();
  }

  // ------------------------------------------------------------------ public

  setCardText(prompt: string, text: string): void {
    this.frontTexture?.dispose();
    this.frontTexture = makeCanvasTexture(1024, 576, (ctx, w, h) => {
      ctx.fillStyle = '#f7f8fc';
      ctx.fillRect(0, 0, w, h);

      // Prompt chip
      ctx.font = `500 26px ${SANS}`;
      const chipLabel = `PROMPT · ${prompt}`;
      const chipX = 56;
      const chipY = 44;
      const chipWidth = Math.min(ctx.measureText(chipLabel).width + 44, w - chipX * 2);
      ctx.fillStyle = '#e6eaff';
      ctx.beginPath();
      ctx.roundRect(chipX, chipY, chipWidth, 50, 25);
      ctx.fill();

      ctx.fillStyle = '#3b4a8a';
      ctx.save();
      ctx.beginPath();
      ctx.rect(chipX + 18, chipY, chipWidth - 36, 50);
      ctx.clip();
      ctx.fillText(chipLabel, chipX + 22, chipY + 33);
      ctx.restore();

      // Body text
      ctx.fillStyle = '#101425';
      ctx.font = `400 34px ${SERIF}`;
      const lines = wrapText(ctx, text, w - 128);
      const lineHeight = 48;
      const maxLines = Math.floor((h - 210) / lineHeight);
      const shown = lines.slice(0, maxLines);
      if (lines.length > maxLines && shown.length > 0) {
        const last = shown.length - 1;
        shown[last] = `${(shown[last] ?? '').replace(/\s+\S*$/, '')} …`;
      }
      shown.forEach((line, i) => {
        ctx.fillText(line, 64, 176 + i * lineHeight);
      });
    });
    this.frontMaterial.map = this.frontTexture;
    this.frontMaterial.needsUpdate = true;
  }

  private setBackText(label: string, sub: string, accent: string): void {
    this.backTexture?.dispose();
    this.backTexture = makeCanvasTexture(1024, 576, (ctx, w, h) => {
      ctx.fillStyle = '#0b1024';
      ctx.fillRect(0, 0, w, h);

      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, accent);
      gradient.addColorStop(1, '#0b1024');
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;

      ctx.textAlign = 'center';
      ctx.fillStyle = '#93a6da';
      ctx.font = `600 30px ${SANS}`;
      ctx.fillText('WRITTEN BY', w / 2, h / 2 - 96);

      ctx.fillStyle = '#ffffff';
      ctx.font = `700 76px ${SANS}`;
      let name = label;
      while (ctx.measureText(name).width > w - 120 && name.length > 8) {
        name = name.slice(0, -2);
      }
      if (name !== label) name = `${name}…`;
      ctx.fillText(name, w / 2, h / 2 + 4);

      ctx.fillStyle = accent;
      ctx.font = `500 34px ${MONO}`;
      ctx.fillText(sub, w / 2, h / 2 + 74);
      ctx.textAlign = 'left';
    });
    this.backMaterial.map = this.backTexture;
    this.backMaterial.needsUpdate = true;
  }

  private setStamp(accent: string): void {
    this.stampTexture?.dispose();
    this.stampTexture = makeCanvasTexture(1024, 336, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-0.13);
      ctx.translate(-w / 2, -h / 2);

      ctx.strokeStyle = accent;
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.roundRect(52, 44, w - 104, h - 88, 26);
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.14;
      ctx.beginPath();
      ctx.roundRect(52, 44, w - 104, h - 88, 26);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.textAlign = 'center';
      ctx.font = `800 92px ${SANS}`;
      ctx.fillText('IDENTICAL', w / 2, h / 2 + 12);
      ctx.font = `600 30px ${MONO}`;
      ctx.fillText('BOTH MODELS WROTE THE SAME TEXT', w / 2, h / 2 + 66);
      ctx.textAlign = 'left';
    });
    this.stampMaterial.map = this.stampTexture;
    this.stampMaterial.needsUpdate = true;
  }

  /** Show a new card and reset all reveal state. */
  showCard(prompt: string, text: string): void {
    this.setCardText(prompt, text);
    this.flip = 0;
    this.targetFlip = 0;
    this.cardGroup.rotation.set(0, 0, 0);
    this.cardScale = 0;
    this.cardTargetScale = 1;
    this.ringActive = false;
    this.ringMaterial.opacity = 0;
    this.ringPulse = 0;
    this.stampScale = 0;
    this.stampTarget = 0;
    this.stampMaterial.opacity = 0;
    this.panelTargetOpacity = 1;
    this.flareA = 0;
    this.flareB = 0;
  }

  flarePanel(slot: 'A' | 'B'): void {
    if (slot === 'A') this.flareA = 1;
    else this.flareB = 1;
  }

  /**
   * Flip the card in 3D to the attribution face and pulse a verdict ring.
   * `identical` also raises the IDENTICAL stamp.
   */
  reveal(truthLabel: string, sub: string, kind: RevealKind): void {
    const accent = kind === 'correct' ? '#4ade80' : kind === 'wrong' ? '#f87171' : '#fbbf24';
    this.setBackText(truthLabel, sub, accent);
    this.targetFlip = Math.PI;
    this.ringActive = true;
    this.ringColor = new THREE.Color(
      kind === 'correct' ? 0x4ade80 : kind === 'wrong' ? 0xf87171 : 0xfbbf24,
    );
    this.ringMaterial.color = this.ringColor;
    this.ringPulse = 0;
    this.panelTargetOpacity = 0;
    if (kind === 'identical') {
      this.setStamp(accent);
      this.stampTarget = 1;
    }
  }

  hidePanels(): void {
    this.panelTargetOpacity = 0;
  }

  setOrbitEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
    if (!enabled) {
      this.camera.position.set(0, 0, 9.2);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
  }

  setIdleMode(enabled: boolean): void {
    this.idleMode = enabled;
  }

  /** Hide the card entirely (score screen). */
  setCardVisible(visible: boolean): void {
    this.cardTargetScale = visible ? 1 : 0;
    if (!visible) {
      this.stampTarget = 0;
      this.ringActive = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.frontTexture?.dispose();
    this.backTexture?.dispose();
    this.stampTexture?.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
    this.renderer.dispose();
  }

  // ----------------------------------------------------------------- private

  private resize(): void {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    const width = parent?.clientWidth ?? window.innerWidth;
    const height = parent?.clientHeight ?? window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // Parallax tilt eases toward the pointer.
    this.tilt.x += (this.targetTilt.x - this.tilt.x) * Math.min(1, dt * 5);
    this.tilt.y += (this.targetTilt.y - this.tilt.y) * Math.min(1, dt * 5);

    // Flip easing (ease-out cubic toward the target).
    this.flip += (this.targetFlip - this.flip) * Math.min(1, dt * 4.2);
    const flipProgress = Math.min(1, this.flip / Math.PI);
    const tiltFade = 1 - flipProgress;

    this.cardGroup.rotation.y = this.flip + this.tilt.y * tiltFade;
    this.cardGroup.rotation.x = this.tilt.x * tiltFade;
    this.cardGroup.position.y = Math.sin(t * 0.7) * 0.09 + 0.4;
    this.cardGroup.position.z = Math.sin(t * 0.5) * 0.12;

    this.cardScale += (this.cardTargetScale - this.cardScale) * Math.min(1, dt * 6);
    this.cardGroup.scale.setScalar(0.88 + this.cardScale * 0.12);
    this.cardGroup.visible = this.cardScale > 0.02;

    // Ring pulse.
    if (this.ringActive) {
      this.ringPulse = Math.min(1, this.ringPulse + dt * 1.3);
      const eased = 1 - Math.pow(1 - this.ringPulse, 3);
      this.ring.scale.setScalar(0.74 + eased * 0.4);
      this.ringMaterial.opacity = Math.sin(eased * Math.PI) * 0.95;
      this.ring.rotation.z += dt * 0.22;
    } else {
      this.ringMaterial.opacity *= 0.9;
    }

    // IDENTICAL stamp pops in once the flip is mostly done.
    const stampGate = flipProgress > 0.55 ? this.stampTarget : 0;
    this.stampScale += (stampGate - this.stampScale) * Math.min(1, dt * 5.5);
    this.stamp.scale.setScalar(Math.max(0.001, this.stampScale));
    this.stampMaterial.opacity = this.stampScale;
    this.stamp.visible = this.stampScale > 0.01;

    // Panels fade and flare.
    this.panelOpacity += (this.panelTargetOpacity - this.panelOpacity) * Math.min(1, dt * 6);
    this.flareA = Math.max(0, this.flareA - dt * 1.6);
    this.flareB = Math.max(0, this.flareB - dt * 1.6);
    this.panelAMaterial.opacity = this.panelOpacity;
    this.panelBMaterial.opacity = this.panelOpacity;
    this.panelAMaterial.emissiveIntensity = 0.55 + this.flareA * 2.8;
    this.panelBMaterial.emissiveIntensity = 0.55 + this.flareB * 2.8;
    this.panelA.scale.setScalar(1 + this.flareA * 0.1);
    this.panelB.scale.setScalar(1 + this.flareB * 0.1);
    this.panelA.position.y = -3.15 + Math.sin(t * 1.1) * 0.045;
    this.panelB.position.y = -3.15 + Math.sin(t * 1.1 + 1.4) * 0.045;
    this.panelA.visible = this.panelOpacity > 0.01;
    this.panelB.visible = this.panelOpacity > 0.01;

    // Ambient glow follows the verdict colour.
    this.glowMaterial.color.lerp(this.ringColor, Math.min(1, dt * 2));
    this.glowMaterial.opacity = 0.13 + Math.sin(t * 0.9) * 0.03 + this.ringPulse * 0.1;

    this.stars.rotation.y += dt * 0.012;
    this.stars.rotation.x = this.tilt.x * 0.05;

    if (this.idleMode) {
      this.camera.position.x = Math.sin(t * 0.16) * 1.6;
      this.camera.position.y = Math.cos(t * 0.21) * 0.9;
      this.camera.position.z = 9.2;
      this.camera.lookAt(0, 0, 0);
    } else if (this.controls.enabled) {
      this.controls.update();
    }

    this.renderer.render(this.scene, this.camera);
  };
}