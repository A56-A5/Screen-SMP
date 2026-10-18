import * as THREE from "three";
import { buildSkinnedParts, type SkinData } from "./skin";

/**
 * A Minecraft-style player: skinned box body (head/body/arms/legs), a
 * floating white name tag with drop shadow, and procedural walk/run/sit
 * animation. Legs and arms keep swinging while airborne if the player is
 * still moving horizontally — matching Minecraft's behavior.
 */
export interface VoxelCharacter {
  root: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  nametag: THREE.Sprite;
  /** True while limbs should swing (walking/running, even mid-air). */
  setMoving(moving: boolean): void;
  setRunning(running: boolean): void;
  setSitting(sitting: boolean): void;
  setJumping(jumping: boolean): void;
  setCrouching(crouching: boolean): void;
  setSpeaking(speaking: boolean): void;
  /** Right-arm punch animation (~0.3s), overwrites arm swing while active. */
  punch(): void;
  /** Right-arm wave animation (~1.2s), overwrites arm swing while active. */
  wave(): void;
  setSkin(skin: SkinData): void;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Punch motion curve over 0.28s: fast ease-out strike (~90ms), smoothstep
 * return. Snappy like Minecraft's attack swing instead of a floaty sine.
 */
export function punchCurve(t: number): number {
  if (t < 0.09) {
    const k = t / 0.09;
    return 1 - (1 - k) * (1 - k);
  }
  const k = Math.min(1, (t - 0.09) / 0.19);
  return 1 - k * k * (3 - 2 * k);
}

/** Draw a Minecraft-style name tag: white pixel text with a hard dark shadow. */
function makeNametag(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 128);
  ctx.font = "bold 64px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Hard drop shadow, 4px offset — the Minecraft look.
  ctx.fillStyle = "#000000";
  ctx.fillText(text.slice(0, 16), 256 + 4, 64 + 4);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text.slice(0, 16), 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = 2.25;
  sprite.renderOrder = 999;
  return sprite;
}

export function createCharacter(name: string, skin: SkinData): VoxelCharacter {
  const root = new THREE.Group();

  let parts = buildSkinnedParts(skin);

  // Wrap limb meshes in pivot Groups so rotation is at the shoulder/hip.
  // Head pivots at the neck (y1.5) and the body at the hip (y0.75) so a
  // crouch lean reads as a torso bend instead of swinging the whole mesh
  // around the feet.
  const head = new THREE.Group();
  head.position.y = 1.5;
  parts.head.position.y = 0.25;
  head.add(parts.head);
  root.add(head);

  const bodyHolder = new THREE.Group();
  bodyHolder.position.y = 0.75;
  parts.body.position.y = 0.375;
  bodyHolder.add(parts.body);
  root.add(bodyHolder);

  const rightArm = new THREE.Group();
  rightArm.add(parts.rightArm);
  rightArm.position.copy(parts.rightArm.position);
  parts.rightArm.position.set(0, 0, 0);
  root.add(rightArm);

  const leftArm = new THREE.Group();
  leftArm.add(parts.leftArm);
  leftArm.position.copy(parts.leftArm.position);
  parts.leftArm.position.set(0, 0, 0);
  root.add(leftArm);

  const rightLeg = new THREE.Group();
  rightLeg.add(parts.rightLeg);
  rightLeg.position.copy(parts.rightLeg.position);
  parts.rightLeg.position.set(0, 0, 0);
  root.add(rightLeg);

  const leftLeg = new THREE.Group();
  leftLeg.add(parts.leftLeg);
  leftLeg.position.copy(parts.leftLeg.position);
  parts.leftLeg.position.set(0, 0, 0);
  root.add(leftLeg);

  const nametag = makeNametag(name);
  root.add(nametag);

  let phase = 0;
  let moving = false;
  let running = false;
  let sitting = false;
  let crouching = false;
  let punchT = -1; // >= 0 while a punch animation plays
  let waveT = -1; // >= 0 while a wave animation plays
  let currentSkin = skin;

  const character: VoxelCharacter = {
    root,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    nametag,

    setMoving(v) {
      moving = v;
    },
    setRunning(v) {
      running = v;
    },
    setSitting(v) {
      sitting = v;
    },
    setJumping() {
      // Kept for the network animation payload; physical jumping is handled
      // by the engine and has no dedicated pose anymore.
    },
    setCrouching(v) {
      crouching = v;
    },
    punch() {
      punchT = 0;
    },
    wave() {
      waveT = 0;
    },
    setSpeaking(v) {
      // Minecraft-ish: tint the nametag green while speaking.
      const mat = nametag.material as THREE.SpriteMaterial;
      mat.color.set(v ? "#7dffb0" : "#ffffff");
    },

    setSkin(newSkin) {
      if (newSkin === currentSkin) return;
      // Replace limb meshes with newly skinned ones, keeping pivots.
      const oldParts = parts;
      parts = buildSkinnedParts(newSkin);
      currentSkin = newSkin;

      // Swap meshes inside their holders/groups (pivots live on the holders).
      head.clear();
      parts.head.position.y = 0.25;
      head.add(parts.head);
      bodyHolder.clear();
      parts.body.position.y = 0.375;
      bodyHolder.add(parts.body);

      parts.rightArm.position.set(0, 0, 0);
      rightArm.clear();
      rightArm.add(parts.rightArm);

      parts.leftArm.position.set(0, 0, 0);
      leftArm.clear();
      leftArm.add(parts.leftArm);

      parts.rightLeg.position.set(0, 0, 0);
      rightLeg.clear();
      rightLeg.add(parts.rightLeg);

      parts.leftLeg.position.set(0, 0, 0);
      leftLeg.clear();
      leftLeg.add(parts.leftLeg);

      oldParts.dispose();
    },

    update(dt: number) {
      // Advance timers first so punch/wave can overlay any pose.
      if (punchT >= 0) {
        punchT += dt;
        if (punchT > 0.28) punchT = -1;
      }
      if (waveT >= 0) {
        waveT += dt;
        if (waveT > 1.2) waveT = -1;
      }
      const applyGestures = () => {
        if (waveT >= 0) {
          rightArm.rotation.x = -2.4;
          rightArm.rotation.z = -Math.PI * 0.75 * Math.abs(Math.sin(waveT * 8));
        }
        if (punchT >= 0) {
          // Quick forward jab: fast strike out, smooth return — straight arm,
          // no sideways drift.
          rightArm.rotation.x = -1.55 * punchCurve(punchT);
          rightArm.rotation.z = 0;
        }
      };
      // Smoothly ease the torso lean toward a target angle (radians).
      const leanTo = (target: number) => {
        bodyHolder.rotation.x += (target - bodyHolder.rotation.x) * Math.min(1, dt * 12);
      };

      // Minecraft rule: limbs swing whenever the player moves horizontally,
      // even while jumping. Only a stationary mid-air pose tucks the limbs.
      const swing = moving && !sitting;

      if (sitting) {
        leanTo(0);
        leftLeg.rotation.x = -Math.PI / 2;
        rightLeg.rotation.x = -Math.PI / 2;
        leftArm.rotation.x = 0.3;
        rightArm.rotation.x = 0.3;
        leftArm.rotation.z = 0;
        rightArm.rotation.z = 0;
        applyGestures();
        return;
      }

      if (crouching) {
        // Sneak: whole torso leans forward (hip pivot), head follows a
        // little, legs stay nearly straight with a tiny shuffle, arms hang
        // forward with the lean.
        leanTo(0.55);
        head.rotation.x += (0.25 - head.rotation.x) * Math.min(1, dt * 12);
        const s = moving ? Math.sin(phase) * 0.12 : 0;
        if (moving) phase += dt * 6;
        leftLeg.rotation.x = -0.12 + s;
        rightLeg.rotation.x = -0.12 - s;
        leftArm.rotation.x = -0.45 - s * 0.5;
        rightArm.rotation.x = -0.45 + s * 0.5;
        leftArm.rotation.z = 0.05;
        rightArm.rotation.z = -0.05;
        applyGestures();
        return;
      }

      leanTo(0);

      if (swing) {
        const speed = running ? 11 : 7.5;
        const amp = running ? 1.05 : 0.7;
        phase += dt * speed;
        const s = Math.sin(phase) * amp;
        leftLeg.rotation.x = s;
        rightLeg.rotation.x = -s;
        leftArm.rotation.x = -s * 0.85;
        rightArm.rotation.x = s * 0.85;
        leftArm.rotation.z = 0;
        rightArm.rotation.z = 0;
      } else {
        // Idle: subtle breathing on arms, legs straight.
        phase += dt * 1.8;
        const s = Math.sin(phase) * 0.03;
        leftLeg.rotation.x *= 0.82;
        rightLeg.rotation.x *= 0.82;
        leftArm.rotation.x = s;
        rightArm.rotation.x = -s;
        leftArm.rotation.z = 0;
        rightArm.rotation.z = 0;
      }

      applyGestures();

      // Head looks slightly toward camera pitch handled by caller if needed.
      head.rotation.x *= 0.9;
      head.rotation.y *= 0.9;
    },

    dispose() {
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) {
          obj.geometry?.dispose();
          const m = obj.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
      parts.dispose();
    },
  };

  return character;
}
