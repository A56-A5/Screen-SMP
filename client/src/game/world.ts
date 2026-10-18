import * as THREE from "three";
import {
  createBlockMaterials,
  grassBlock,
  uniformBlock,
  texturedBox,
  block,
  type BlockMaterials,
} from "./textures";

/**
 * A Minecraft-style world built at strict block scale:
 * - every shape is a box with textures tiling exactly once per 1x1 block
 * - grass ground with a stone-brick path
 * - a big cinema (20 wide x 20 deep) with stadium-tier seating:
 *   3 rows on rising platforms so back rows see over the front
 * - proper theater chairs: seat pan + backrest + armrests, 2.2 blocks apart
 * - lounge, trees, glowstone lamps
 * Seats face the screen (-Z): backrests are on the +Z side.
 */

export interface Collider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
}

export interface SeatSpot {
  /** Sit root position (character root when seated). */
  x: number;
  y: number;
  z: number;
}

export interface WorldResult {
  group: THREE.Group;
  colliders: Collider[];
  seats: SeatSpot[];
  screenMesh: THREE.Mesh;
  spawn: THREE.Vector3;
  materials: BlockMaterials;
}

export function buildWorld(): WorldResult {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const seats: SeatSpot[] = [];
  const mats = createBlockMaterials();

  // --- Ground: grass blocks under everything (x -20..20, z -30..20) ---
  const groundGeo = new THREE.BoxGeometry(1, 1, 1);
  const ground = new THREE.InstancedMesh(
    groundGeo,
    new THREE.MeshLambertMaterial({ map: mats.grassTop.map }),
    40 * 50
  );
  const dummy = new THREE.Object3D();
  let gi = 0;
  for (let x = -20; x < 20; x++) {
    for (let z = -30; z < 20; z++) {
      dummy.position.set(x + 0.5, -0.5, z + 0.5);
      dummy.updateMatrix();
      ground.setMatrixAt(gi, dummy.matrix);
      gi++;
    }
  }
  ground.instanceMatrix.needsUpdate = true;
  ground.receiveShadow = true;
  group.add(ground);
  groundGeo.dispose();

  // Path from spawn to cinema (stone bricks, 1 block wide, thin slab)
  for (let z = 12; z >= -5; z--) {
    const p = block(1, 0.1, 1, mats.stoneBrick);
    p.position.set(0.5, 0.05, z + 0.5);
    group.add(p);
  }

  // --- Cinema building: interior x [-10, 10], z [-6, -26], height 8 ---
  // Back wall (screen wall)
  const backWall = block(20, 8, 1, mats.stoneBrick);
  backWall.position.set(0, 4, -26);
  group.add(backWall);
  colliders.push({ minX: -10, maxX: 10, minZ: -26.5, maxZ: -25.5, top: 8 });

  // Side walls
  const leftWall = block(1, 8, 20, mats.stoneBrick);
  leftWall.position.set(-10, 4, -16);
  group.add(leftWall);
  colliders.push({ minX: -10.5, maxX: -9.5, minZ: -26, maxZ: -6, top: 8 });

  const rightWall = block(1, 8, 20, mats.stoneBrick);
  rightWall.position.set(10, 4, -16);
  group.add(rightWall);
  colliders.push({ minX: 9.5, maxX: 10.5, minZ: -26, maxZ: -6, top: 8 });

  // Roof (wood planks)
  const roof = block(21, 1, 21, mats.woodPlank);
  roof.position.set(0, 8.5, -16);
  group.add(roof);

  // Front lintel over the open entrance
  const lintel = block(21, 2, 1, mats.woodPlank);
  lintel.position.set(0, 7, -6);
  group.add(lintel);

  // --- Stadium tiers: rows rise AWAY from the screen (real theatre layout) ---
  // Front row (z=-19, nearest the screen) sits on ground level.
  // Middle row (z=-14.5) on a +1 platform. Back row (z=-10) on a +2 platform.
  // Entry step (top y=1) at the door so the 2-high back tier is climbable
  // with normal jumps (max jump ≈ 1.18 blocks).

  // Entry step: z -6.5..-8
  const entryStep = block(19, 1, 1.5, mats.stoneBrick);
  entryStep.position.set(0, 0.5, -7.25);
  group.add(entryStep);
  colliders.push({ minX: -9.5, maxX: 9.5, minZ: -8, maxZ: -6.5, top: 1 });

  // Back tier (top y=2): z -8..-12.5 — solid 2-high so it reads as stacked blocks
  const backTier = block(19, 2, 4.5, mats.stoneBrick);
  backTier.position.set(0, 1, -10.25);
  group.add(backTier);
  colliders.push({ minX: -9.5, maxX: 9.5, minZ: -12.5, maxZ: -8, top: 2 });

  // Middle tier (top y=1): z -12.5..-17
  const midTier = block(19, 1, 4.5, mats.stoneBrick);
  midTier.position.set(0, 0.5, -14.75);
  group.add(midTier);
  colliders.push({ minX: -9.5, maxX: 9.5, minZ: -17, maxZ: -12.5, top: 1 });

  // Red carpet: ground zone by the screen, then one strip per tier top
  const carpetFront = block(19, 0.1, 8.5, mats.carpet); // z -17..-25.5, ground
  carpetFront.position.set(0, 0.05, -21.25);
  group.add(carpetFront);

  const carpetMid = block(19, 0.1, 4.5, mats.carpet); // middle tier top
  carpetMid.position.set(0, 1.05, -14.75);
  group.add(carpetMid);

  const carpetBack = block(19, 0.1, 4.5, mats.carpet); // back tier top
  carpetBack.position.set(0, 2.05, -10.25);
  group.add(carpetBack);

  const carpetStep = block(19, 0.1, 1.5, mats.carpet); // entry step top
  carpetStep.position.set(0, 1.05, -7.25);
  group.add(carpetStep);

  // --- The big screen (on back wall, facing +Z toward seats) ---
  const frame = block(15, 8, 0.4, mats.screenFrame);
  frame.position.set(0, 4, -25.6);
  group.add(frame);

  const screenGeo = new THREE.PlaneGeometry(14, 7.5);
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
  const screenMesh = new THREE.Mesh(screenGeo, screenMat);
  screenMesh.position.set(0, 4, -25.35);
  group.add(screenMesh);

  colliders.push({ minX: -7, maxX: 7, minZ: -25.7, maxZ: -25.3, top: 8 });

  // --- Theater chairs: pan + backrest + two armrests ---
  // Rows rise 1 block each AWAY from the screen: front row on ground,
  // middle +1, back +2 (highest). 7 seats per row, 2.2 blocks apart.
  const rowTiers: { z: number; tier: number }[] = [
    { z: -19, tier: 0 }, // front row — nearest the screen, ground level
    { z: -14.5, tier: 1 }, // middle row — +1
    { z: -10, tier: 2 }, // back row — +2, highest, near the entrance
  ];
  for (const { z, tier } of rowTiers) {
    for (let col = 0; col < 7; col++) {
      const x = -6.6 + col * 2.2;

      // Seat pan: 1.2 wide, 0.7 tall — top at tier + 0.7
      const pan = block(1.2, 0.7, 1.2, mats.seat);
      pan.position.set(x, tier + 0.35, z);
      group.add(pan);

      // Backrest on +Z side (behind the sitter who faces -Z/screen),
      // rises from pan top to tier + 1.8
      const back = block(1.2, 1.1, 0.3, mats.seat);
      back.position.set(x, tier + 1.25, z + 0.45);
      group.add(back);

      // Armrests (wood) beside the pan, from tier to tier + 0.8
      const armL = block(0.2, 0.8, 1.2, mats.woodPlank);
      armL.position.set(x - 0.7, tier + 0.4, z);
      group.add(armL);
      const armR = block(0.2, 0.8, 1.2, mats.woodPlank);
      armR.position.set(x + 0.7, tier + 0.4, z);
      group.add(armR);

      colliders.push({
        minX: x - 0.8,
        maxX: x + 0.8,
        minZ: z - 0.6,
        maxZ: z + 0.6,
        top: tier + 0.7,
      });
      // Seat spot = pan TOP: sitters sink below it (hip height 0.75), and
      // standing up snaps feet onto it.
      seats.push({ x, y: tier + 0.7, z });
    }
  }

  // --- Glowstone lamps on log posts along the path ---
  const lampSpots: [number, number][] = [
    [-3, 10],
    [3, 10],
    [-3, 4],
    [3, 4],
    [-3, -2],
    [3, -2],
  ];
  for (const [lx, lz] of lampSpots) {
    const post = block(0.3, 3, 0.3, mats.logSide);
    post.position.set(lx, 1.5, lz);
    group.add(post);
    const bulb = block(0.6, 0.6, 0.6, mats.glowstone);
    bulb.position.set(lx, 3.3, lz);
    group.add(bulb);
    const light = new THREE.PointLight(0xffdf9e, 0.6, 9);
    light.position.set(lx, 3.6, lz);
    group.add(light);
  }

  // --- Trees (log trunk + leaf cubes) ---
  const treeSpots: [number, number][] = [
    [-14, 8],
    [14, 8],
    [-12, -4],
    [12, -4],
    [-16, 0],
    [16, 0],
    [-10, 14],
    [10, 14],
  ];
  for (const [tx, tz] of treeSpots) {
    const trunk = block(1, 3, 1, mats.logSide);
    trunk.position.set(tx, 1.5, tz);
    group.add(trunk);
    colliders.push({ minX: tx - 0.4, maxX: tx + 0.4, minZ: tz - 0.4, maxZ: tz + 0.4, top: 3 });
    // Leaves: stacked cubes for a fuller canopy
    const leaf1 = block(3, 3, 3, mats.leaves);
    leaf1.position.set(tx, 4, tz);
    group.add(leaf1);
    const leaf2 = block(2, 2, 2, mats.leaves);
    leaf2.position.set(tx, 6, tz);
    group.add(leaf2);
  }

  // --- Lounge benches (wood) beside the path ---
  const bench1 = block(3, 1, 1, mats.woodPlank);
  bench1.position.set(-10, 0.5, 6);
  group.add(bench1);
  colliders.push({ minX: -11.5, maxX: -8.5, minZ: 5.5, maxZ: 6.5, top: 1 });

  const bench2 = block(3, 1, 1, mats.woodPlank);
  bench2.position.set(10, 0.5, 6);
  group.add(bench2);
  colliders.push({ minX: 8.5, maxX: 11.5, minZ: 5.5, maxZ: 6.5, top: 1 });

  // --- Small planter boxes with leaves ---
  for (const [px, pz] of [
    [-6, 8],
    [6, 8],
    [-6, 2],
    [6, 2],
  ] as [number, number][]) {
    const box = block(1, 0.6, 1, mats.woodPlank);
    box.position.set(px, 0.3, pz);
    group.add(box);
    const bush = block(0.8, 0.7, 0.8, mats.leaves);
    bush.position.set(px, 1, pz);
    group.add(bush);
    colliders.push({ minX: px - 0.5, maxX: px + 0.5, minZ: pz - 0.5, maxZ: pz + 0.5, top: 0.6 });
  }

  // --- Lighting ---
  const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x3a5a2a, 0.85);
  group.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff2d0, 0.75);
  dir.position.set(12, 22, 8);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.left = -25;
  dir.shadow.camera.right = 25;
  dir.shadow.camera.top = 25;
  dir.shadow.camera.bottom = -25;
  group.add(dir);
  // Warm interior light for the cinema
  const cinemaLight = new THREE.PointLight(0xffe0b0, 0.6, 18);
  cinemaLight.position.set(0, 6, -16);
  group.add(cinemaLight);

  const spawn = new THREE.Vector3(0, 0, 12);
  return { group, colliders, seats, screenMesh, spawn, materials: mats };
}

// re-export for textures used elsewhere
export { texturedBox, grassBlock, uniformBlock };
