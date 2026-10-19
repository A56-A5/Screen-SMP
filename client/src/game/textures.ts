import * as THREE from "three";

/**
 * Procedural 16x16 Minecraft-style block textures drawn on canvas.
 * NearestFilter keeps the pixel look crisp.
 * Every texture is designed to tile once per 1x1x1 block.
 */

function makeTex(draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  draw(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * Minecraft textures are mostly flat color with sparse single-pixel specks —
 * not heavy per-pixel noise. Low density keeps the official clean look.
 */
function speck(ctx: CanvasRenderingContext2D, base: string, variants: string[], density = 0.22) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 16, 16);
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      if (Math.random() < density) {
        ctx.fillStyle = variants[Math.floor(Math.random() * variants.length)];
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

export const texGrassTop = () =>
  makeTex((ctx) => speck(ctx, "#79c05a", ["#6fb052", "#84cc63", "#68a54d"], 0.28));

export const texGrassSide = () =>
  makeTex((ctx) => {
    speck(ctx, "#8b6647", ["#7d5b3e", "#987151", "#755438"], 0.24);
    // Grass overhang: jagged 3-5 pixel fringe like Minecraft.
    for (let x = 0; x < 16; x++) {
      const depth = 3 + (Math.random() < 0.55 ? 1 : 0) + (Math.random() < 0.2 ? 1 : 0);
      ctx.fillStyle = ["#79c05a", "#6fb052", "#84cc63"][Math.floor(Math.random() * 3)];
      ctx.fillRect(x, 0, 1, depth);
      if (Math.random() < 0.4) {
        ctx.fillStyle = "#68a54d";
        ctx.fillRect(x, depth, 1, 1);
      }
    }
  });

export const texDirt = () =>
  makeTex((ctx) => speck(ctx, "#8b6647", ["#7d5b3e", "#987151", "#755438"], 0.26));

export const texStone = () =>
  makeTex((ctx) => {
    speck(ctx, "#7d7d7d", ["#747474", "#868686", "#6e6e6e"], 0.2);
    // A few darker clusters like real stone.
    ctx.fillStyle = "#6a6a6a";
    ctx.fillRect(3, 4, 2, 1);
    ctx.fillRect(11, 9, 1, 2);
    ctx.fillRect(7, 13, 2, 1);
  });

export const texStoneBrick = () =>
  makeTex((ctx) => {
    speck(ctx, "#7a7a7a", ["#707070", "#848484"], 0.16);
    ctx.fillStyle = "#5c5c5c";
    // Mortar: horizontal lines every 8 rows, offset vertical seams per row.
    ctx.fillRect(0, 0, 16, 1);
    ctx.fillRect(0, 8, 16, 1);
    ctx.fillRect(7, 1, 1, 7);
    ctx.fillRect(0, 9, 1, 7);
    ctx.fillRect(15, 9, 1, 7);
  });

/** Smooth grey concrete (cinema interior) — flat, no mortar, clean. */
export const texConcrete = () =>
  makeTex((ctx) => speck(ctx, "#8a8a8e", ["#828286", "#929296", "#7e7e82"], 0.14));

export const texWoodPlank = () =>
  makeTex((ctx) => {
    speck(ctx, "#9c7f4e", ["#927647", "#a58755", "#8a6f42"], 0.2);
    ctx.fillStyle = "#6e5836";
    // Horizontal plank seams every 4 rows.
    ctx.fillRect(0, 3, 16, 1);
    ctx.fillRect(0, 7, 16, 1);
    ctx.fillRect(0, 11, 16, 1);
    ctx.fillRect(0, 15, 16, 1);
    // Staggered vertical seams per plank row.
    ctx.fillRect(11, 0, 1, 3);
    ctx.fillRect(4, 4, 1, 3);
    ctx.fillRect(13, 8, 1, 3);
    ctx.fillRect(6, 12, 1, 3);
  });

export const texLogSide = () =>
  makeTex((ctx) => {
    speck(ctx, "#6b5030", ["#614829", "#755837", "#574024"], 0.22);
    // Vertical bark stripes.
    ctx.fillStyle = "#54401f";
    ctx.fillRect(2, 0, 1, 16);
    ctx.fillRect(6, 0, 2, 16);
    ctx.fillRect(11, 0, 1, 16);
    ctx.fillRect(14, 0, 1, 16);
    ctx.fillStyle = "#7a5c38";
    ctx.fillRect(4, 0, 1, 16);
    ctx.fillRect(9, 0, 1, 16);
  });

export const texLogTop = () =>
  makeTex((ctx) => {
    speck(ctx, "#a08050", ["#947548", "#ac8c58"], 0.2);
    ctx.fillStyle = "#6b5030";
    // Ring pattern.
    ctx.strokeRect(2.5, 2.5, 11, 11);
    ctx.strokeRect(5.5, 5.5, 5, 5);
    ctx.fillRect(7, 7, 2, 2);
  });

export const texLeaves = () =>
  makeTex((ctx) => {
    ctx.clearRect(0, 0, 16, 16);
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        if (Math.random() < 0.88) {
          ctx.fillStyle = ["#3d6b2e", "#356028", "#467a35", "#2e5524"][Math.floor(Math.random() * 4)];
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  });

export const texSeat = () =>
  makeTex((ctx) => speck(ctx, "#a03030", ["#942c2c", "#ac3636", "#882828"], 0.22));

export const texGlowstone = () =>
  makeTex((ctx) => {
    speck(ctx, "#e8c86a", ["#f0d47a", "#dcb85c", "#ffe89a"], 0.3);
    ctx.fillStyle = "#fff4c0";
    ctx.fillRect(6, 6, 4, 4);
    ctx.fillRect(5, 7, 1, 2);
    ctx.fillRect(10, 7, 1, 2);
  });

export const texScreenFrame = () =>
  makeTex((ctx) => speck(ctx, "#1a1a22", ["#15151c", "#20202a"], 0.2));

export const texPath = () =>
  makeTex((ctx) => {
    speck(ctx, "#8e8e82", ["#84847a", "#99998d", "#7c7c72"], 0.25);
    ctx.fillStyle = "#6e6e62";
    ctx.fillRect(0, 0, 16, 1);
    ctx.fillRect(0, 8, 16, 1);
    ctx.fillRect(8, 1, 1, 7);
    ctx.fillRect(3, 9, 1, 7);
  });

export const texCarpet = () =>
  makeTex((ctx) => speck(ctx, "#8a2a2a", ["#7e2626", "#963030"], 0.2));

/** Materials built from the textures (reused, shared). */
export interface BlockMaterials {
  grassTop: THREE.MeshLambertMaterial;
  grassSide: THREE.MeshLambertMaterial;
  dirt: THREE.MeshLambertMaterial;
  stone: THREE.MeshLambertMaterial;
  stoneBrick: THREE.MeshLambertMaterial;
  concrete: THREE.MeshLambertMaterial;
  woodPlank: THREE.MeshLambertMaterial;
  logSide: THREE.MeshLambertMaterial;
  logTop: THREE.MeshLambertMaterial;
  leaves: THREE.MeshLambertMaterial;
  seat: THREE.MeshLambertMaterial;
  glowstone: THREE.MeshLambertMaterial;
  screenFrame: THREE.MeshLambertMaterial;
  path: THREE.MeshLambertMaterial;
  carpet: THREE.MeshLambertMaterial;
  dispose(): void;
}

export function createBlockMaterials(): BlockMaterials {
  const mats: BlockMaterials = {
    grassTop: new THREE.MeshLambertMaterial({ map: texGrassTop() }),
    grassSide: new THREE.MeshLambertMaterial({ map: texGrassSide() }),
    dirt: new THREE.MeshLambertMaterial({ map: texDirt() }),
    stone: new THREE.MeshLambertMaterial({ map: texStone() }),
    stoneBrick: new THREE.MeshLambertMaterial({ map: texStoneBrick() }),
    concrete: new THREE.MeshLambertMaterial({ map: texConcrete() }),
    woodPlank: new THREE.MeshLambertMaterial({ map: texWoodPlank() }),
    logSide: new THREE.MeshLambertMaterial({ map: texLogSide() }),
    logTop: new THREE.MeshLambertMaterial({ map: texLogTop() }),
    leaves: new THREE.MeshLambertMaterial({ map: texLeaves(), transparent: true, alphaTest: 0.3 }),
    seat: new THREE.MeshLambertMaterial({ map: texSeat() }),
    glowstone: new THREE.MeshLambertMaterial({ map: texGlowstone(), emissive: 0x886622, emissiveIntensity: 0.6 }),
    screenFrame: new THREE.MeshLambertMaterial({ map: texScreenFrame() }),
    path: new THREE.MeshLambertMaterial({ map: texPath() }),
    carpet: new THREE.MeshLambertMaterial({ map: texCarpet() }),
    dispose() {
      Object.values(mats).forEach((m) => {
        if (m instanceof THREE.MeshLambertMaterial) {
          m.map?.dispose();
          m.dispose();
        }
      });
    },
  };
  return mats;
}

/**
 * Multi-material box: one texture per face, matching Minecraft block faces.
 * faceOrder: [px, nx, py, ny, pz, nz]
 */
export function texturedBox(
  w: number,
  h: number,
  d: number,
  materials: [THREE.Material, THREE.Material, THREE.Material, THREE.Material, THREE.Material, THREE.Material]
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  return new THREE.Mesh(geo, materials);
}

/**
 * A block built from a shared material where the texture tiles exactly once
 * per 1x1 block on every face (Minecraft texture scale). E.g. block(4,2,1)
 * shows the texture 4x on the wide faces, 2x vertically — no stretching.
 * Requires the base material's map to use RepeatWrapping (set at creation).
 */
export function block(w: number, h: number, d: number, base: THREE.MeshLambertMaterial): THREE.Mesh {
  const mkFaceMat = (rx: number, ry: number): THREE.MeshLambertMaterial => {
    const m = base.clone();
    const src = base.map;
    if (src) {
      const t = src.clone();
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.needsUpdate = true;
      m.map = t;
    }
    return m;
  };
  // BoxGeometry material order: px, nx, py, ny, pz, nz.
  // px/nx faces span (d x h), py/ny span (w x d), pz/nz span (w x h).
  const materials: THREE.MeshLambertMaterial[] = [
    mkFaceMat(d, h),
    mkFaceMat(d, h),
    mkFaceMat(w, d),
    mkFaceMat(w, d),
    mkFaceMat(w, h),
    mkFaceMat(w, h),
  ];
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials);
}

/** Common: grass block with grass top, grass sides, dirt bottom (1 unit). */
export function grassBlock(mats: BlockMaterials, size = 1): THREE.Mesh {
  return texturedBox(size, size, size, [
    mats.grassSide,
    mats.grassSide,
    mats.grassTop,
    mats.dirt,
    mats.grassSide,
    mats.grassSide,
  ]);
}

/** Uniform all-faces block. */
export function uniformBlock(size: number, mat: THREE.Material): THREE.Mesh {
  return texturedBox(size, size, size, [mat, mat, mat, mat, mat, mat]);
}
