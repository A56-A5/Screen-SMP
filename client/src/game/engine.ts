import * as THREE from "three";
import { buildWorld, type Collider, type SeatSpot } from "./world";
import { createCharacter, punchCurve, type VoxelCharacter } from "./character";
import { createSteveSkin, type SkinData } from "./skin";
import type { Appearance, PlayerState, Vec3 } from "../net/types";

export interface GameCallbacks {
  onMove: (position: Vec3, rotationY: number, animation: string) => void;
  /** E key (any distance): open movie settings. */
  onInteract: () => void;
  onFirstPersonChange: (firstPerson: boolean) => void;
  /** Fired when the local player punches (broadcast as an emote). */
  onPunch?: () => void;
}

interface RemoteEntry {
  character: VoxelCharacter;
  targetPos: THREE.Vector3;
  targetRotY: number;
  animState: { moving: boolean; running: boolean; sitting: boolean; jumping: boolean; crouching: boolean };
}

const MOVE_SEND_RATE_MS = 100;
const INTERP_LERP = 12;
const EYE_HEIGHT = 1.62;
const CROUCH_EYE_DROP = 0.35;
const SPRINT_DOUBLE_TAP_MS = 300;

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private colliders: Collider[] = [];
  private seats: SeatSpot[] = [];
  private screenMesh: THREE.Mesh;
  private videoTexture: THREE.VideoTexture | null = null;

  private localChar: VoxelCharacter;
  private localSkin: SkinData;
  private remotes = new Map<string, RemoteEntry>();

  private velocityY = 0;
  private onGround = true;
  private yaw = 0;
  private pitch = -0.1;
  private sitting = false;
  private seatPos: THREE.Vector3 | null = null;
  private crouching = false;
  private sprinting = false;
  private lastWTap = 0;

  // First-person by default; F5 toggles.
  private firstPerson = true;

  private keys = new Set<string>();
  private lastSend = 0;
  private disposed = false;

  private pointerLocked = false;

  // First-person hand (a small skinned arm in front of the camera).
  private fpHand: THREE.Group | null = null;
  private fpHandPhase = 0;
  private fpPunchT = -1;

  constructor(
    private container: HTMLElement,
    localName: string,
    localAppearance: Appearance,
    private callbacks: GameCallbacks
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.domElement.className = "game-canvas";
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x87ceeb); // Minecraft daytime sky
    this.scene.fog = new THREE.Fog(0x87ceeb, 40, 90);

    this.camera = new THREE.PerspectiveCamera(
      70,
      container.clientWidth / container.clientHeight,
      0.1,
      200
    );

    const world = buildWorld();
    this.scene.add(world.group);
    this.colliders = world.colliders;
    this.seats = world.seats;
    this.screenMesh = world.screenMesh;

    this.localSkin = createSteveSkin();
    this.localChar = createCharacter(localName, this.localSkin);
    this.localChar.root.position.copy(world.spawn);
    this.localChar.root.visible = false; // hidden in first person
    this.scene.add(this.localChar.root);

    // Build a first-person hand from the same skin.
    this.buildFpHand();
    this.applyAppearance(localAppearance);

    this.bindEvents();
    this.animate();
  }

  private buildFpHand() {
    // A simple box "arm" parented to the camera, bottom-right of view.
    const geo = new THREE.BoxGeometry(0.22, 0.55, 0.22);
    const mat = new THREE.MeshLambertMaterial({ color: 0xb8825c });
    const mesh = new THREE.Mesh(geo, mat);
    this.fpHand = new THREE.Group();
    this.fpHand.add(mesh);
    mesh.position.set(0, -0.27, 0);
    this.fpHand.position.set(0.45, -0.35, -0.7);
    this.fpHand.rotation.set(-0.4, 0.3, 0.15);
    this.camera.add(this.fpHand);
    this.scene.add(this.camera);
  }

  applyAppearance(appearance: Appearance) {
    this.localChar.applyAppearance({
      skinUrl: appearance.skinUrl,
      skinData: appearance.skinData,
      model: appearance.model,
    });
  }

  setLocalName(name: string) {
    // Rebuild nametag texture.
    const old = this.localChar.nametag;
    const mat = old.material as THREE.SpriteMaterial;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "bold 64px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#000000";
    ctx.fillText(name.slice(0, 16), 256 + 4, 64 + 4);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(name.slice(0, 16), 256, 64);
    mat.map?.dispose();
    mat.map = new THREE.CanvasTexture(canvas);
    mat.needsUpdate = true;
  }

  // ---------- input ----------
  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    // F5: toggle perspective (prevent browser refresh).
    if (e.code === "F5") {
      e.preventDefault();
      this.togglePerspective();
      return;
    }
    // Double-tap W = sprint (Minecraft Java style; avoids Ctrl+W closing the tab).
    if (e.code === "KeyW" && !this.keys.has("KeyW")) {
      const now = performance.now();
      if (now - this.lastWTap < SPRINT_DOUBLE_TAP_MS) this.sprinting = true;
      this.lastWTap = now;
    }
    // Changing direction cancels sprint.
    if (e.code === "KeyS" || e.code === "KeyA" || e.code === "KeyD") this.sprinting = false;

    this.keys.add(e.code);
    if (e.code === "KeyE") this.handleE();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === "KeyW") this.sprinting = false;
  };
  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.yaw -= e.movementX * 0.0025;
    this.pitch -= e.movementY * 0.0025;
    this.pitch = Math.max(-1.2, Math.min(0.6, this.pitch));
  };
  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      // Left click just grabs the pointer (Minecraft-style). No interact.
      if (!this.pointerLocked) {
        this.renderer.domElement.requestPointerLock();
      }
    } else if (e.button === 2 && this.pointerLocked) {
      // Right click: punch.
      this.punch();
    }
  };
  private onContextMenu = (e: Event) => e.preventDefault();
  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
  };
  private onResize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  // Touch controls
  private touchStart: { x: number; y: number } | null = null;
  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      this.touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };
  private onTouchMove = (e: TouchEvent) => {
    if (!this.touchStart || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - this.touchStart.x;
    const dy = e.touches[0].clientY - this.touchStart.y;
    this.yaw -= dx * 0.005;
    this.pitch -= dy * 0.005;
    this.pitch = Math.max(-1.2, Math.min(0.6, this.pitch));
    this.touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  private onTouchEnd = () => {
    this.touchStart = null;
  };

  setJoystick(forward: number, right: number) {
    this.inputForward = forward;
    this.inputRight = right;
  }
  private inputForward = 0;
  private inputRight = 0;

  togglePerspective() {
    this.firstPerson = !this.firstPerson;
    this.localChar.root.visible = !this.firstPerson;
    if (this.fpHand) this.fpHand.visible = this.firstPerson;
    this.callbacks.onFirstPersonChange(this.firstPerson);
  }

  isFirstPerson() {
    return this.firstPerson;
  }

  private bindEvents() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    window.addEventListener("resize", this.onResize);
    this.renderer.domElement.addEventListener("mousedown", this.onMouseDown);
    this.renderer.domElement.addEventListener("contextmenu", this.onContextMenu);
    this.renderer.domElement.addEventListener("touchstart", this.onTouchStart, { passive: true });
    this.renderer.domElement.addEventListener("touchmove", this.onTouchMove, { passive: true });
    this.renderer.domElement.addEventListener("touchend", this.onTouchEnd);
  }

  releasePointer() {
    if (this.pointerLocked) document.exitPointerLock();
  }

  isPointerLocked() {
    return this.pointerLocked;
  }

  // ---------- interactions ----------
  /**
   * E: stand up if sitting; sit if a chair is in the crosshair (within ~3
   * blocks); otherwise open movie settings — works from anywhere.
   */
  private handleE() {
    if (this.sitting) {
      this.stand();
      return;
    }
    const seat = this.seatInSight();
    if (seat) {
      this.sitOn(seat);
      return;
    }
    this.releasePointer();
    this.callbacks.onInteract();
  }

  /** Is a seat within ~3 blocks and inside a ~50° cone of the look dir? */
  private seatInSight(): SeatSpot | null {
    const p = this.localChar.root.position;
    const fx = -Math.sin(this.yaw) * Math.cos(this.pitch);
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.yaw) * Math.cos(this.pitch);
    const eye = p.y + EYE_HEIGHT;
    let best: SeatSpot | null = null;
    let bestScore = Infinity;
    for (const s of this.seats) {
      const dx = s.x - p.x;
      const dy = s.y + 0.4 - eye; // aim at the seat pan, not the floor
      const dz = s.z - p.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 3 || d < 0.001) continue;
      const inv = 1 / d;
      const dot = fx * dx * inv + fy * dy * inv + fz * dz * inv;
      if (dot < 0.65) continue;
      const score = d - dot;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  private sitOn(best: SeatSpot) {
    this.sitting = true;
    this.velocityY = 0;
    this.seatPos = new THREE.Vector3(best.x, best.y, best.z);
    // Model front is +Z; π rotates it to face the screen at -Z.
    this.localChar.root.rotation.y = Math.PI;
    this.localChar.setSitting(true);
  }

  private stand() {
    this.sitting = false;
    this.seatPos = null;
    this.localChar.setSitting(false);
  }

  /** /sit: sit on the nearest seat within 1.6 blocks, or stand back up. */
  toggleSit() {
    if (this.sitting) {
      this.stand();
      return;
    }
    const p = this.localChar.root.position;
    let best: SeatSpot | null = null;
    let bestD = Infinity;
    for (const s of this.seats) {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < 1.6 && d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) this.sitOn(best);
  }

  wave() {
    this.localChar.wave();
  }

  punch() {
    this.localChar.punch();
    this.fpPunchT = 0;
    this.callbacks.onPunch?.();
  }

  punchRemote(playerId: string) {
    const entry = this.remotes.get(playerId);
    entry?.character.punch();
  }

  waveRemote(playerId: string) {
    const entry = this.remotes.get(playerId);
    entry?.character.wave();
  }

  // ---------- remote players ----------
  addRemote(player: PlayerState) {
    if (this.remotes.has(player.id)) return;
    const skin = createSteveSkin();
    const ch = createCharacter(player.name, skin);
    ch.applyAppearance({
      skinUrl: player.appearance.skinUrl,
      skinData: player.appearance.skinData,
      model: player.appearance.model,
    });
    ch.root.position.set(player.position.x, player.position.y, player.position.z);
    this.scene.add(ch.root);
    this.remotes.set(player.id, {
      character: ch,
      targetPos: new THREE.Vector3(player.position.x, player.position.y, player.position.z),
      targetRotY: player.rotationY,
      animState: {
        moving: player.animation === "walking" || player.animation === "running",
        running: player.animation === "running",
        sitting: player.animation === "sitting",
        jumping: player.animation === "jumping",
        crouching: player.animation === "crouching",
      },
    });
  }

  removeRemote(playerId: string) {
    const entry = this.remotes.get(playerId);
    if (!entry) return;
    this.scene.remove(entry.character.root);
    entry.character.dispose();
    this.remotes.delete(playerId);
  }

  moveRemote(playerId: string, position: Vec3, rotationY: number, animation: string) {
    const entry = this.remotes.get(playerId);
    if (!entry) return;
    entry.targetPos.set(position.x, position.y, position.z);
    entry.targetRotY = rotationY;
    // Decode animation string into flags. "walking"/"running" set moving=true
    // even if the remote is mid-air — matches the Minecraft swing rule.
    const crouching = animation === "crouching";
    entry.animState.moving = animation === "walking" || animation === "running";
    entry.animState.running = animation === "running";
    entry.animState.sitting = animation === "sitting";
    entry.animState.jumping = animation === "jumping";
    entry.animState.crouching = crouching;
  }

  setRemoteSpeaking(playerId: string, speaking: boolean) {
    const entry = this.remotes.get(playerId);
    if (!entry) return;
    entry.character.setSpeaking(speaking);
  }

  syncRemoteList(players: PlayerState[], localId: string) {
    const ids = new Set(players.map((p) => p.id));
    for (const id of [...this.remotes.keys()]) {
      if (!ids.has(id) || id === localId) this.removeRemote(id);
    }
    for (const p of players) {
      if (p.id === localId) continue;
      if (!this.remotes.has(p.id)) this.addRemote(p);
    }
  }

  // ---------- video screen ----------
  attachVideo(video: HTMLVideoElement) {
    this.detachVideo(); // dispose the previous texture (source switches)
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    const mat = this.screenMesh.material as THREE.MeshBasicMaterial;
    mat.map = this.videoTexture;
    mat.color.set(0xffffff);
    mat.needsUpdate = true;
  }

  detachVideo() {
    if (this.videoTexture) {
      this.videoTexture.dispose();
      this.videoTexture = null;
    }
    const mat = this.screenMesh.material as THREE.MeshBasicMaterial;
    mat.map = null;
    mat.color.set(0x0a0a0a);
    mat.needsUpdate = true;
  }

  setSpeaking(speaking: boolean) {
    this.localChar.setSpeaking(speaking);
  }

  // ---------- movement & collision ----------
  private moveAndCollide(dt: number) {
    const pos = this.localChar.root.position;

    if (this.sitting && this.seatPos) {
      pos.lerp(this.seatPos, Math.min(1, dt * 10));
      this.localChar.setMoving(false);
      this.localChar.setJumping(false);
      this.localChar.setCrouching(false);
      return;
    }

    let f = this.inputForward;
    let r = this.inputRight;
    if (this.keys.has("KeyW")) f += 1;
    if (this.keys.has("KeyS")) f -= 1;
    if (this.keys.has("KeyA")) r -= 1;
    if (this.keys.has("KeyD")) r += 1;
    // Shift = crouch (Minecraft sneak); sprint comes from double-tap W.
    this.crouching =
      (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) && !this.sitting;
    const running = this.sprinting && !this.crouching;
    if (this.keys.has("Space") && this.onGround) {
      this.velocityY = 7.2;
      this.onGround = false;
    }

    const len = Math.hypot(f, r);
    if (len > 0.01) {
      f /= Math.max(1, len);
      r /= Math.max(1, len);
    }

    const speed = this.crouching ? 1.8 : running ? 7.5 : 4.5;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dx = (r * cos - f * sin) * speed * dt;
    const dz = (-r * sin - f * cos) * speed * dt;

    const nextX = pos.x + dx;
    if (!this.collides(nextX, pos.y, pos.z)) pos.x = nextX;
    const nextZ = pos.z + dz;
    if (!this.collides(pos.x, pos.y, nextZ)) pos.z = nextZ;

    // Gravity + land on the highest platform/seat under the player
    // (stadium tiers, benches, seats) instead of only y=0.
    this.velocityY -= 22 * dt;
    pos.y += this.velocityY * dt;
    const groundY = this.groundHeightAt(pos.x, pos.z, pos.y);
    if (pos.y <= groundY) {
      pos.y = groundY;
      this.velocityY = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    pos.x = Math.max(-19, Math.min(19, pos.x));
    pos.z = Math.max(-25, Math.min(19, pos.z));

    const moving = len > 0.01;
    if (moving) {
      this.localChar.root.rotation.y = this.yaw + Math.PI;
    }

    // Animation flags — Minecraft rule: keep swinging while moving even
    // mid-air. Only show the jump pose when airborne AND stationary.
    this.localChar.setMoving(moving);
    this.localChar.setRunning(running && moving);
    this.localChar.setJumping(!this.onGround && !moving);
    this.localChar.setCrouching(this.crouching);
    this.localChar.setSitting(false);
  }

  /** Highest collider top under (x,z) that the player can stand on at height y. */
  private groundHeightAt(x: number, z: number, y: number): number {
    let top = 0;
    const r = 0.2;
    for (const c of this.colliders) {
      if (x + r < c.minX || x - r > c.maxX) continue;
      if (z + r < c.minZ || z - r > c.maxZ) continue;
      if (c.top > y + 0.15) continue; // too tall to step onto from here
      if (c.top > top) top = c.top;
    }
    return top;
  }

  private collides(x: number, y: number, z: number): boolean {
    const radius = 0.35;
    const feet = y;
    const head = y + 1.8;
    for (const c of this.colliders) {
      if (c.top <= feet + 0.05) continue;
      if (x + radius < c.minX || x - radius > c.maxX) continue;
      if (z + radius < c.minZ || z - radius > c.maxZ) continue;
      if (head <= 0) continue;
      return true;
    }
    return false;
  }

  // ---------- main loop ----------
  private animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    this.moveAndCollide(dt);
    this.localChar.update(dt);

    const p = this.localChar.root.position;
    const eye = EYE_HEIGHT - (this.crouching && !this.sitting ? CROUCH_EYE_DROP : 0);

    if (this.firstPerson) {
      // Camera at eye level, looking in yaw/pitch direction.
      this.camera.position.set(p.x, p.y + eye, p.z);
      const lookX = p.x - Math.sin(this.yaw) * Math.cos(this.pitch);
      const lookY = p.y + eye + Math.sin(this.pitch);
      const lookZ = p.z - Math.cos(this.yaw) * Math.cos(this.pitch);
      this.camera.lookAt(lookX, lookY, lookZ);

      // First-person hand: bob while walking, jab while punching.
      if (this.fpHand) {
        if (this.fpPunchT >= 0) {
          this.fpPunchT += dt;
          if (this.fpPunchT > 0.28) this.fpPunchT = -1;
        }
        const punching = this.fpPunchT >= 0;
        const moving = this.keys.has("KeyW") || this.keys.has("KeyS") || this.keys.has("KeyA") || this.keys.has("KeyD") || this.inputForward !== 0 || this.inputRight !== 0;
        if (punching) {
          const k = punchCurve(this.fpPunchT);
          this.fpHand.rotation.x = -0.4 - 1.25 * k;
          this.fpHand.position.set(0.45 - 0.15 * k, -0.35, -0.7 - 0.4 * k);
        } else if (moving) {
          this.fpHandPhase += dt * 9;
          this.fpHand.position.y = -0.35 + Math.sin(this.fpHandPhase) * 0.04;
          this.fpHand.position.z = -0.7;
          this.fpHand.rotation.x = -0.4 + Math.sin(this.fpHandPhase) * 0.12;
        } else {
          this.fpHandPhase += dt * 1.5;
          this.fpHand.position.y = -0.35 + Math.sin(this.fpHandPhase) * 0.008;
          this.fpHand.position.z = -0.7;
          this.fpHand.rotation.x = -0.4;
        }
        this.fpHand.visible = !this.sitting;
      }
    } else {
      // Third-person orbit camera behind the player.
      const camDist = 5.5;
      const camHeight = 2.6;
      const cx = p.x + Math.sin(this.yaw) * camDist;
      const cz = p.z + Math.cos(this.yaw) * camDist;
      const cy = p.y + camHeight - this.pitch * 3;
      this.camera.position.lerp(new THREE.Vector3(cx, cy, cz), 0.2);
      this.camera.lookAt(p.x, p.y + 1.5, p.z);
      if (this.fpHand) this.fpHand.visible = false;
    }

    // Interpolate remotes.
    for (const entry of this.remotes.values()) {
      entry.character.root.position.lerp(entry.targetPos, Math.min(1, dt * INTERP_LERP));
      const cur = entry.character.root.rotation.y;
      let diff = entry.targetRotY - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      entry.character.root.rotation.y = cur + diff * Math.min(1, dt * INTERP_LERP);
      const a = entry.animState;
      entry.character.setMoving(a.moving);
      entry.character.setRunning(a.running);
      entry.character.setSitting(a.sitting);
      entry.character.setJumping(a.jumping);
      entry.character.setCrouching(a.crouching);
      entry.character.update(dt);
    }

    // Send movement at limited rate.
    const now = performance.now();
    if (now - this.lastSend > MOVE_SEND_RATE_MS) {
      this.lastSend = now;
      let anim = "idle";
      if (this.sitting) anim = "sitting";
      else if (this.crouching) anim = "crouching";
      else {
        const moving =
          this.keys.has("KeyW") ||
          this.keys.has("KeyS") ||
          this.keys.has("KeyA") ||
          this.keys.has("KeyD") ||
          this.inputForward !== 0 ||
          this.inputRight !== 0;
        if (moving) anim = this.sprinting ? "running" : "walking";
        else if (!this.onGround) anim = "jumping";
      }
      this.callbacks.onMove(
        { x: p.x, y: p.y, z: p.z },
        this.localChar.root.rotation.y,
        anim
      );
    }

    if (this.videoTexture) this.videoTexture.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    window.removeEventListener("resize", this.onResize);
    this.renderer.domElement.removeEventListener("mousedown", this.onMouseDown);
    this.renderer.domElement.removeEventListener("contextmenu", this.onContextMenu);
    this.renderer.domElement.removeEventListener("touchstart", this.onTouchStart);
    this.renderer.domElement.removeEventListener("touchmove", this.onTouchMove);
    this.renderer.domElement.removeEventListener("touchend", this.onTouchEnd);
    this.detachVideo();
    this.localChar.dispose();
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
