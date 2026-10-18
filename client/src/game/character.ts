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
  // Head AND arms are CHILDREN of the torso holder (pivot at the hip,
  // y0.75): a crouch lean carries the whole upper body as one connected
  // unit, and the shoulder pivots move with it so the arms can't detach.
  const bodyHolder = new THREE.Group();
  bodyHolder.position.y = 0.75;
  parts.body.position.y = 0.375;
  bodyHolder.add(parts.body);
  root.add(bodyHolder);

  const head = new THREE.Group();
  head.position.y = 0.75; // neck sits at world y1.5 (bodyHolder origin is 0.75)
  parts.head.position.y = 0.25;
  head.add(parts.head);
  bodyHolder.add(head);

  // Arms: shoulder pivots at world y1.5 = local y0.75 inside the torso holder.
  const rightArm = new THREE.Group();
  rightArm.add(parts.rightArm);
  rightArm.position.set(parts.rightArm.position.x, parts.rightArm.position.y - 0.75, 0);
  parts.rightArm.position.set(0, 0, 0);
  bodyHolder.add(rightArm);

  const leftArm = new THREE.Group();
  leftArm.add(parts.leftArm);
  leftArm.position.set(parts.leftArm.position.x, parts.leftArm.position.y - 0.75, 0);
  parts.leftArm.position.set(0, 0, 0);
  bodyHolder.add(leftArm);

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

      // Swap meshes inside their holders/groups (pivots live on the holders;
      // bodyHolder.clear() also detaches head + arms, so re-add them).
      head.clear();
      parts.head.position.y = 0.25;
      head.add(parts.head);
      rightArm.clear();
      parts.rightArm.position.set(0, 0, 0);
      rightArm.add(parts.rightArm);
      leftArm.clear();
      parts.leftArm.position.set(0, 0, 0);
      leftArm.add(parts.leftArm);
      bodyHolder.clear();
      parts.body.position.y = 0.375;
      bodyHolder.add(parts.body);
      bodyHolder.add(head);
      bodyHolder.add(rightArm);
      bodyHolder.add(leftArm);

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
        // Minecraft sneak: the whole upper body (torso + head + shoulder
        // pivots) leans forward as ONE rigid piece; the head COUNTER-rotates
        // by the lean amount so the face stays looking straight ahead when
        // fully crouched; legs stay perfectly straight; arms hang vertically
        // — counter-rotated by the torso lean so they remain world-down
        // while the shoulders ride forward with the body.
        leanTo(0.42);
        head.rotation.x +=
          (-bodyHolder.rotation.x - head.rotation.x) * Math.min(1, dt * 12);
        leftLeg.rotation.x *= 0.85; // legs straight down
        rightLeg.rotation.x *= 0.85;
        const s = moving ? Math.sin(phase) * 0.05 : 0;
        if (moving) phase += dt * 6;
        leftArm.rotation.x = -bodyHolder.rotation.x + s;
        rightArm.rotation.x = -bodyHolder.rotation.x - s;
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
