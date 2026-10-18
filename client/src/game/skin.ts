import * as THREE from "three";

/**
 * Minecraft skin support: loads a 64x64 skin texture (from Mojang CDN or a
 * custom data-URL) and UV-maps it onto box geometries for head/body/arms/legs.
 * Falls back to a procedurally drawn Steve skin when nothing is provided.
 */

const TEX = 64;

export interface SkinData {
  texture: THREE.Texture;
  model: "classic" | "slim";
}

// UV regions for each body part face, in skin pixel coords [x, y, w, h].
// BoxGeometry face order: +X (right), -X (left), +Y (top), -Y (bottom), +Z (front), -Z (back).
type Face = [number, number, number, number];

const HEAD: Record<string, Face> = {
  front: [8, 8, 8, 8],
  back: [24, 8, 8, 8],
  right: [0, 8, 8, 8],
  left: [16, 8, 8, 8],
  top: [8, 0, 8, 8],
  bottom: [16, 0, 8, 8],
};

const BODY: Record<string, Face> = {
  front: [20, 20, 8, 12],
  back: [32, 20, 8, 12],
  right: [16, 20, 4, 12],
  left: [28, 20, 4, 12],
  top: [20, 16, 8, 4],
  bottom: [28, 16, 8, 4],
};

const RIGHT_ARM: Record<string, Face> = {
  front: [44, 20, 4, 12],
  back: [52, 20, 4, 12],
  right: [40, 20, 4, 12],
  left: [48, 20, 4, 12],
  top: [44, 16, 4, 4],
  bottom: [48, 16, 4, 4],
};

const LEFT_ARM: Record<string, Face> = {
  front: [36, 52, 4, 12],
  back: [44, 52, 4, 12],
  right: [32, 52, 4, 12],
  left: [40, 52, 4, 12],
  top: [36, 48, 4, 4],
  bottom: [40, 48, 4, 4],
};

// Slim (Alex) arms are 3px wide on front/back.
const RIGHT_ARM_SLIM: Record<string, Face> = {
  front: [44, 20, 3, 12],
  back: [51, 20, 3, 12],
  right: [40, 20, 4, 12],
  left: [47, 20, 4, 12],
  top: [44, 16, 3, 4],
  bottom: [47, 16, 3, 4],
};

const LEFT_ARM_SLIM: Record<string, Face> = {
  front: [36, 52, 3, 12],
  back: [43, 52, 3, 12],
  right: [32, 52, 4, 12],
  left: [39, 52, 4, 12],
  top: [36, 48, 3, 4],
  bottom: [39, 48, 3, 4],
};

const RIGHT_LEG: Record<string, Face> = {
  front: [4, 20, 4, 12],
  back: [12, 20, 4, 12],
  right: [0, 20, 4, 12],
  left: [8, 20, 4, 12],
  top: [4, 16, 4, 4],
  bottom: [8, 16, 4, 4],
};

const LEFT_LEG: Record<string, Face> = {
  front: [20, 52, 4, 12],
  back: [28, 52, 4, 12],
  right: [16, 52, 4, 12],
  left: [24, 52, 4, 12],
  top: [20, 48, 4, 4],
  bottom: [24, 48, 4, 4],
};

/**
 * Remap a BoxGeometry's UVs so each face samples the correct skin region.
 * BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z.
 * regions: [right(+X), left(-X), top(+Y), bottom(-Y), front(+Z), back(-Z)]
 */
function applySkinUVs(geo: THREE.BoxGeometry, regions: Face[]): THREE.BoxGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let face = 0; face < 6; face++) {
    const [sx, sy, sw, sh] = regions[face];
    const uL = sx / TEX;
    const uR = (sx + sw) / TEX;
    // Three.js V axis is bottom-up; skin y is top-down.
    const vT = 1 - sy / TEX;
    const vB = 1 - (sy + sh) / TEX;
    const base = face * 4;
    // Vertex order per face: top-left, top-right, bottom-left, bottom-right.
    uv.setXY(base + 0, uL, vT);
    uv.setXY(base + 1, uR, vT);
    uv.setXY(base + 2, uL, vB);
    uv.setXY(base + 3, uR, vB);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Draw a classic Steve skin onto a 64x64 canvas (fallback). */
function drawSteveCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = TEX;
  c.height = TEX;
  const ctx = c.getContext("2d")!;

  const SKIN = "#b8825c";
  const HAIR = "#382818";
  const SHIRT = "#00a8a8";
  const PANTS = "#3c3c8c";
  const SHOE = "#4a4a4a";
  const EYE_W = "#ffffff";
  const EYE_P = "#3b5dc9";

  const fill = (r: Face, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(r[0], r[1], r[2], r[3]);
  };

  // Head base
  for (const key of ["front", "back", "right", "left", "top", "bottom"] as const) {
    fill(HEAD[key], SKIN);
  }
  // Hair on top + upper back + sides
  fill(HEAD.top, HAIR);
  fill([HEAD.back[0], HEAD.back[1], HEAD.back[2], 3], HAIR); // back top strip
  fill([HEAD.right[0], HEAD.right[1], HEAD.right[2], 2], HAIR);
  fill([HEAD.left[0], HEAD.left[1], HEAD.left[2], 2], HAIR);
  fill([HEAD.front[0], HEAD.front[1], HEAD.front[2], 2], HAIR); // fringe
  // Eyes
  const [fx, fy] = HEAD.front;
  ctx.fillStyle = EYE_W;
  ctx.fillRect(fx + 1, fy + 3, 2, 1);
  ctx.fillRect(fx + 5, fy + 3, 2, 1);
  ctx.fillStyle = EYE_P;
  ctx.fillRect(fx + 2, fy + 3, 1, 1);
  ctx.fillRect(fx + 6, fy + 3, 1, 1);
  // Mouth
  ctx.fillStyle = "#8a5a3c";
  ctx.fillRect(fx + 3, fy + 6, 2, 1);

  // Body
  for (const key of ["front", "back", "right", "left", "top", "bottom"] as const) {
    fill(BODY[key], SHIRT);
  }

  // Right arm: shirt top, skin hand bottom
  for (const key of ["front", "back", "right", "left", "top", "bottom"] as const) {
    fill(RIGHT_ARM[key], SHIRT);
  }
  // hand
  const ra = RIGHT_ARM.front;
  fill([ra[0], ra[1] + 9, ra[2], 3], SKIN);
  const rab = RIGHT_ARM.back;
  fill([rab[0], rab[1] + 9, rab[2], 3], SKIN);

  // Left arm mirror
  for (const key of ["front", "back", "right", "left", "top", "bottom"] as const) {
    fill(LEFT_ARM[key], SHIRT);
  }
  const la = LEFT_ARM.front;
  fill([la[0], la[1] + 9, la[2], 3], SKIN);
  const lab = LEFT_ARM.back;
  fill([lab[0], lab[1] + 9, lab[2], 3], SKIN);

  // Legs: pants top, shoes bottom
  for (const key of ["front", "back", "right", "left", "top", "bottom"] as const) {
    fill(RIGHT_LEG[key], PANTS);
    fill(LEFT_LEG[key], PANTS);
  }
  const rl = RIGHT_LEG.front;
  fill([rl[0], rl[1] + 10, rl[2], 2], SHOE);
  const rlb = RIGHT_LEG.back;
  fill([rlb[0], rlb[1] + 10, rlb[2], 2], SHOE);
  const ll = LEFT_LEG.front;
  fill([ll[0], ll[1] + 10, ll[2], 2], SHOE);
  const llb = LEFT_LEG.back;
  fill([llb[0], llb[1] + 10, llb[2], 2], SHOE);

  return c;
}

function canvasToTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  return tex;
}

/** Procedural Steve, always available. */
export function createSteveSkin(): SkinData {
  return { texture: canvasToTexture(drawSteveCanvas()), model: "classic" };
}

/**
 * Build a set of skinned geometries (head, body, arms, legs) ready to assemble
 * into a character group. All geometries share the provided texture via materials.
 */
export interface SkinnedParts {
  head: THREE.Mesh;
  body: THREE.Mesh;
  rightArm: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightLeg: THREE.Mesh;
  leftLeg: THREE.Mesh;
  dispose(): void;
}

export function buildSkinnedParts(skin: SkinData): SkinnedParts {
  const mat = new THREE.MeshLambertMaterial({ map: skin.texture });
  const slim = skin.model === "slim";

  const armW = slim ? 3 / 16 : 4 / 16;
  const armX = slim ? 0.39 : 0.4;

  const headGeo = applySkinUVs(
    new THREE.BoxGeometry(0.5, 0.5, 0.5),
    [HEAD.right, HEAD.left, HEAD.top, HEAD.bottom, HEAD.front, HEAD.back]
  );
  const bodyGeo = applySkinUVs(
    new THREE.BoxGeometry(0.5, 0.75, 0.25),
    [BODY.right, BODY.left, BODY.top, BODY.bottom, BODY.front, BODY.back]
  );
  const raRegions = slim ? RIGHT_ARM_SLIM : RIGHT_ARM;
  const laRegions = slim ? LEFT_ARM_SLIM : LEFT_ARM;
  const raGeo = applySkinUVs(
    new THREE.BoxGeometry(armW, 0.75, 0.25),
    [raRegions.right, raRegions.left, raRegions.top, raRegions.bottom, raRegions.front, raRegions.back]
  );
  const laGeo = applySkinUVs(
    new THREE.BoxGeometry(armW, 0.75, 0.25),
    [laRegions.right, laRegions.left, laRegions.top, laRegions.bottom, laRegions.front, laRegions.back]
  );
  const rlGeo = applySkinUVs(
    new THREE.BoxGeometry(0.25, 0.75, 0.25),
    [RIGHT_LEG.right, RIGHT_LEG.left, RIGHT_LEG.top, RIGHT_LEG.bottom, RIGHT_LEG.front, RIGHT_LEG.back]
  );
  const llGeo = applySkinUVs(
    new THREE.BoxGeometry(0.25, 0.75, 0.25),
    [LEFT_LEG.right, LEFT_LEG.left, LEFT_LEG.top, LEFT_LEG.bottom, LEFT_LEG.front, LEFT_LEG.back]
  );

  const head = new THREE.Mesh(headGeo, mat);
  head.position.y = 1.75;

  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.y = 1.125;

  // Arms pivot at shoulder (top of mesh). The model FACES +Z, which makes
  // its true right side -X (right = forward x up). Limbs used to sit on the
  // mirrored side, so the punch/wave animated the wrong arm visually.
  const rightArm = new THREE.Mesh(raGeo, mat);
  rightArm.geometry.translate(0, -0.375, 0);
  rightArm.position.set(-armX, 1.5, 0);

  const leftArm = new THREE.Mesh(laGeo, mat);
  leftArm.geometry.translate(0, -0.375, 0);
  leftArm.position.set(armX, 1.5, 0);

  const rightLeg = new THREE.Mesh(rlGeo, mat);
  rightLeg.geometry.translate(0, -0.375, 0);
  rightLeg.position.set(-0.125, 0.75, 0);

  const leftLeg = new THREE.Mesh(llGeo, mat);
  leftLeg.geometry.translate(0, -0.375, 0);
  leftLeg.position.set(0.125, 0.75, 0);

  return {
    head,
    body,
    rightArm,
    leftArm,
    rightLeg,
    leftLeg,
    dispose() {
      [headGeo, bodyGeo, raGeo, laGeo, rlGeo, llGeo].forEach((g) => g.dispose());
      mat.dispose();
    },
  };
}

