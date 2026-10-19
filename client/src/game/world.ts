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
 * - a BIG sunken cinema (28 wide x 28 deep) BELOW ground level in grey
 *   concrete: flat entrance at y0 via a 3-deep vestibule that swallows
 *   direct sun (walk straight in, no jump), floor steps DOWN toward the
 *   screen (front at y-3), 4 rows of 9 seats rising 1 block per row away
 *   from the screen (back row = entrance height)
 * - huge 18-wide 16:9 screen, ceiling light panels, light lever beside it
 * - proper theater chairs: seat pan + backrest + armrests, 2.2 blocks apart
 * - lounge, trees, glowstone lamps
 * Seats face the screen (-Z): backrests are on the +Z side.
 * All structure overlaps (walls into roof, roof overhangs) so the sun
 * cannot leak through seams when the theatre lights are off.
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
  /** Outdoor lamp point lights (dimmed when the theatre lights go down). */
  lampLights: THREE.PointLight[];
  /** Warm interior cinema lights (mid-room + near the screen). */
  cinemaLight: THREE.PointLight;
  interiorLights: THREE.PointLight[];
  /** Shared glowstone material (emissive dims with the lamps). */
  glowstoneMat: THREE.MeshLambertMaterial;
  /** Sky/ground fill light — killing its intensity is what darkens the room. */
  hemi: THREE.HemisphereLight;
  /** Sun (shadow-casting; the roof already keeps most of it out inside). */
  sun: THREE.DirectionalLight;
  /** Pivoting lever handle mesh beside the screen. */
  leverHandle: THREE.Mesh;
  /** Interaction point for the lever (E while looking at it). */
  leverSpot: { x: number; y: number; z: number };
  /** White ceiling light panels inside the cinema (toggle with lights). */
  ceilingPanels: THREE.Mesh[];
}

export function buildWorld(): WorldResult {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const seats: SeatSpot[] = [];
  const mats = createBlockMaterials();

  // --- Ground: grass blocks (x -20..20, z -40..20). The sunken cinema's
  // footprint is skipped (the theatre fills it below y0), and the ground
  // CASTS shadows so no sun reaches anything underneath it.
  const groundGeo = new THREE.BoxGeometry(1, 1, 1);
  const ground = new THREE.InstancedMesh(
    groundGeo,
    new THREE.MeshLambertMaterial({ map: mats.grassTop.map }),
    40 * 60
  );
  const dummy = new THREE.Object3D();
  let gi = 0;
  for (let x = -20; x < 20; x++) {
    for (let z = -40; z < 20; z++) {
      // Skip grass only for cells FULLY inside the theatre footprint —
      // boundary cells stay (hidden inside the thick walls/zones) so there
      // is no void trench around the building that shows up as black holes.
      // Also skip the vestibule doorway floor (filled by the threshold block).
      const inFootprint =
        (x >= -14 && x <= 13 && z >= -34 && z <= -7) ||
        (x >= -2 && x <= 1 && z >= -6 && z <= -4);
      if (inFootprint) continue;
      dummy.position.set(x + 0.5, -0.5, z + 0.5);
      dummy.updateMatrix();
      ground.setMatrixAt(gi, dummy.matrix);
      gi++;
    }
  }
  ground.count = gi;
  ground.instanceMatrix.needsUpdate = true;
  ground.receiveShadow = true;
  ground.castShadow = true; // blocks the sun from the sunken interior
  group.add(ground);
  groundGeo.dispose();

  // Path from spawn to the cinema door (stone bricks, 1 block wide, thin slab)
  for (let z = 12; z >= -2; z--) {
    const p = block(1, 0.1, 1, mats.stoneBrick);
    p.position.set(0.5, 0.05, z + 0.5);
    group.add(p);
  }

  // --- Sunken cinema: interior x [-14, 14], z [-34, -6], ceiling y8 ---
  // Walls run y-4..9 (well below the sunken floor and into the roof) and
  // overlap each other / the roof so no seam can leak light.

  // Side walls (overlap front + back wall ends by 0.5)
  const leftWall = block(1, 13, 28, mats.concrete);
  leftWall.position.set(-14, 2.5, -20);
  group.add(leftWall);
  colliders.push({ minX: -14.5, maxX: -13.5, minZ: -34, maxZ: -6, top: 9 });

  const rightWall = block(1, 13, 28, mats.concrete);
  rightWall.position.set(14, 2.5, -20);
  group.add(rightWall);
  colliders.push({ minX: 13.5, maxX: 14.5, minZ: -34, maxZ: -6, top: 9 });

  // Screen wall (back, z=-34): full width, overlaps side walls
  const backWall = block(30, 13, 1, mats.concrete);
  backWall.position.set(0, 2.5, -34);
  group.add(backWall);
  colliders.push({ minX: -15, maxX: 15, minZ: -34.5, maxZ: -33.5, top: 9 });

  // Front wall is a 3-deep vestibule (z -6..-3) with the same centered
  // doorway (x ±2, height 3) — flat threshold at y0 so you walk straight
  // in, no jump. The tunnel swallows direct sun: rays entering the outer
  // mouth hit the tunnel floor/walls long before the seats, so toggling
  // the lights down actually darkens the room.
  const frontLeft = block(12.5, 13, 3, mats.concrete);
  frontLeft.position.set(-8.25, 2.5, -4.5);
  group.add(frontLeft);
  colliders.push({ minX: -14.5, maxX: -2, minZ: -6, maxZ: -3, top: 9 });

  const frontRight = block(12.5, 13, 3, mats.concrete);
  frontRight.position.set(8.25, 2.5, -4.5);
  group.add(frontRight);
  colliders.push({ minX: 2, maxX: 14.5, minZ: -6, maxZ: -3, top: 9 });

  // Lintel over the door through the full tunnel depth — visual only, NO
  // collider: colliders are solid from the ground up, so a lintel collider
  // would plug the doorway shut. A max jump (head 2.98) cannot reach y3.
  const doorLintel = block(4, 5, 3, mats.concrete);
  doorLintel.position.set(0, 5.5, -4.5);
  group.add(doorLintel);

  // Solid threshold floor under the doorway (kills the old void strip).
  const threshold = block(4, 4, 3, mats.concrete);
  threshold.position.set(0, -2, -4.5); // y-4..0, x±2, z-6..-3
  group.add(threshold);

  // Entrance curtains: two thin panels hung just inside the doorway to
  // swallow the last daylight slivers that leaked around the door jambs
  // when the lights go down. Walk-through — NO collider, so you push past
  // them like real theatre curtains. castShadow is set by the group traverse
  // below, which is what seals the remaining bright edge.
  for (const cx of [-0.95, 0.95]) {
    const curtain = block(2.2, 3.2, 0.08, mats.curtain);
    curtain.position.set(cx, 1.6, -4.5);
    group.add(curtain);
  }

  // Roof: oversized so it overhangs every wall incl. the vestibule
  const roof = block(30.4, 1, 33, mats.concrete);
  roof.position.set(0, 8.5, -19);
  group.add(roof);

  // --- Sunken floor zones: flat at the door (y0), stepping DOWN toward the
  // screen (final floor y-3). Seats rise 1 block per row AWAY from the
  // screen, so the back row sits at entrance height — walk in, no jump.
  const zones: { z0: number; z1: number; top: number }[] = [
    { z0: -6, z1: -12, top: 0 }, // back row zone — flat with outside ground
    { z0: -12, z1: -17, top: -1 },
    { z0: -17, z1: -22, top: -2 },
    { z0: -22, z1: -34, top: -3 }, // front floor + screen area
  ];
  for (const { z0, z1, top } of zones) {
    const depth = z1 - z0;
    const zone = block(28, 4 + top, depth, mats.concrete); // y-4 .. top
    zone.position.set(0, (top - 4) / 2, (z0 + z1) / 2);
    group.add(zone);
    colliders.push({ minX: -14, maxX: 14, minZ: z1, maxZ: z0, top });
    // Red carpet strip on the zone top — raised 0.02 so its bottom face is
    // NOT coplanar with the zone top (z-fighting showed as glitchy patches).
    const carpet = block(28, 0.12, depth, mats.carpet);
    carpet.position.set(0, top + 0.08, (z0 + z1) / 2);
    group.add(carpet);
  }

  // --- Riser faces: the zone boxes' front faces are backface-culled from the
  // seat side (you look at the -Z face of the block in front), so each step
  // edge had NO visible vertical texture. Thin concrete slabs flush with the
  // zone front faces give every riser a proper textured nose. They sit
  // entirely INSIDE the upper zone (front face flush with the step edge at
  // z, extending +Z) so nothing extrudes into the walking aisle. Visual
  // only — the zone colliders already block movement.
  for (const { z, top } of [
    { z: -12, top: 0 },
    { z: -17, top: -1 },
    { z: -22, top: -2 },
  ]) {
    const riser = block(28, 1.25, 0.5, mats.concrete);
    riser.position.set(0, top - 0.575, z + 0.25); // spans z..z+0.5, flush
    group.add(riser);
  }

  // --- The huge 16:9 cinema screen on the back wall, facing +Z toward seats
  // (18 wide, floor to near-ceiling — fills the wall like a real theatre) ---
  const frame = block(19, 11, 0.4, mats.screenFrame);
  frame.position.set(0, 2, -33.6);
  group.add(frame);

  const screenGeo = new THREE.PlaneGeometry(18, 10.125); // exact 16:9
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a });
  const screenMesh = new THREE.Mesh(screenGeo, screenMat);
  screenMesh.position.set(0, 2, -33.35);
  group.add(screenMesh);

  colliders.push({ minX: -9.5, maxX: 9.5, minZ: -33.7, maxZ: -33.3, top: 9 });

  // --- Theater chairs: 4 rows x 9 seats, rising 1 block per row away from
  // the screen (row tiers match the sunken floor zones) ---
  const rowTiers: { z: number; tier: number }[] = [
    { z: -10, tier: 0 }, // back row — entrance height
    { z: -15, tier: -1 },
    { z: -20, tier: -2 },
    { z: -25, tier: -3 }, // front row — nearest the screen
  ];
  for (const { z, tier } of rowTiers) {
    for (let col = 0; col < 9; col++) {
      const x = -8.8 + col * 2.2;

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

      // Pan collider (stand on / sit on the seat).
      colliders.push({
        minX: x - 0.8,
        maxX: x + 0.8,
        minZ: z - 0.6,
        maxZ: z + 0.6,
        top: tier + 0.7,
      });
      // Backrest collider: jumping from the row behind used to fall
      // straight through the visual backrest (its collider was pan-height
      // only). This plugs the gap up to the backrest top. The engine's
      // stand() now ejects the player to the FRONT of the chair, so being
      // trapped on the pan by the taller collider is impossible.
      colliders.push({
        minX: x - 0.65,
        maxX: x + 0.65,
        minZ: z + 0.25,
        maxZ: z + 0.65,
        top: tier + 1.8,
      });
      // Seat spot = pan TOP: sitters sink below it (hip height 0.75), and
      // standing up snaps feet onto it.
      seats.push({ x, y: tier + 0.7, z });
    }
  }

  // --- Interior ceiling slab: hides EVERY wall/ceiling seam from inside.
  // Sunlight was bleeding as a thin bright line along the top front edge
  // (shadow-map bleed at the wall/roof corner). This slab sits just under
  // the roof bottom (y8) and laps 0.6 into the side walls, burying the
  // corner where the walls meet the roof. Visual only, no collider.
  const ceilingSlab = block(28.2, 0.3, 28, mats.concrete);
  ceilingSlab.position.set(0, 7.85, -20); // y7.7..8.0, x±14.1, z-34..-6
  group.add(ceilingSlab);

  // --- Interior corner trims: sunlight was bleeding down all FOUR vertical
  // wall creases (side wall meeting front/back wall). These columns lap
  // over both walls at every corner, burying the crease. Visual only.
  for (const [cx, cz, cd] of [
    [-13.35, -33.35, 0.7], // back-left  (crease x-13.5, z-33.5)
    [13.35, -33.35, 0.7], // back-right
    [-13.35, -6.3, 0.8], // front-left  (crease x-13.5, z-6)
    [13.35, -6.3, 0.8], // front-right
  ] as [number, number, number][]) {
    const trim = block(0.7, 13, cd, mats.concrete);
    trim.position.set(cx, 2.5, cz); // full wall height y-4..9
    group.add(trim);
  }

  // --- Ceiling light panels (white squares hung just under the slab) ---
  const ceilingPanels: THREE.Mesh[] = [];
  const panelMat = new THREE.MeshBasicMaterial({ color: 0xf2f4ff });
  for (const px of [-6, 6]) {
    for (const pz of [-12, -19, -26]) {
      const panel = block(1.4, 0.08, 1.4, mats.concrete);
      panel.position.set(px, 7.66, pz); // top flush with slab bottom (7.7)
      group.add(panel);
      const glow = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 1.2), panelMat);
      glow.position.set(px, 7.62, pz);
      group.add(glow);
      ceilingPanels.push(glow);
    }
  }

  // --- Glowstone lamps on log posts along the path ---
  const lampLights: THREE.PointLight[] = [];
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
    const light = new THREE.PointLight(0xffdf9e, 15, 12);
    light.position.set(lx, 3.6, lz);
    group.add(light);
    lampLights.push(light);
  }

  // --- Theatre light lever: inside, against the screen wall just LEFT of
  // the frame (frame spans x ±8.5 — lever at x -11.5, on the front floor).
  const leverX = -11.5;
  const leverZ = -33;
  const leverBaseY = -3; // front floor top
  const leverPost = block(0.4, 1.8, 0.4, mats.logSide);
  leverPost.position.set(leverX, leverBaseY + 0.9, leverZ);
  group.add(leverPost);
  const leverMount = block(0.5, 0.35, 0.5, mats.stoneBrick);
  leverMount.position.set(leverX, leverBaseY + 1.55, leverZ);
  group.add(leverMount);
  // Pivoting stone handle, pivot at the mount top. Up = lights on.
  const leverHandleGeo = new THREE.BoxGeometry(0.14, 0.55, 0.14);
  leverHandleGeo.translate(0, 0.275, 0);
  const leverHandle = new THREE.Mesh(leverHandleGeo, mats.stoneBrick);
  leverHandle.position.set(leverX, leverBaseY + 1.7, leverZ);
  leverHandle.rotation.x = -0.6;
  group.add(leverHandle);
  colliders.push({
    minX: leverX - 0.25,
    maxX: leverX + 0.25,
    minZ: leverZ - 0.25,
    maxZ: leverZ + 0.25,
    top: leverBaseY + 1.8,
  });

  // --- Trees (log trunk + leaf cubes) ---
  const treeSpots: [number, number][] = [
    [-14, 8],
    [14, 8],
    [-12, 2], // moved off the sunken cinema footprint
    [12, 2],
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
  dir.shadow.mapSize.set(2048, 2048);
  // Frustum was ±30: the back wall corners (x±15, z-34) fell OUTSIDE the
  // shadow map, so the sun shone through the un-shadowed region and lit a
  // band of the back wall right of the screen plus a bright line near the
  // ceiling. ±45 comfortably covers the whole building from this direction.
  dir.shadow.camera.left = -45;
  dir.shadow.camera.right = 45;
  dir.shadow.camera.top = 45;
  dir.shadow.camera.bottom = -45;
  // Aim the shadow camera at the cinema (target at 0,0,0 is too far +Z),
  // so the map is centred on the building instead of the spawn lawn.
  dir.target.position.set(0, 0, -10);
  group.add(dir.target);
  dir.shadow.camera.updateProjectionMatrix();
  dir.shadow.bias = -0.0005;
  dir.shadow.normalBias = 0.05;
  group.add(dir);
  // Warm interior lights for the cinema. Three.js point lights use inverse-
  // square falloff (decay 2), so intensities must be high to actually read
  // across an 8+-block room.
  const cinemaLight = new THREE.PointLight(0xffe0b0, 45, 28);
  cinemaLight.position.set(0, 6, -19);
  cinemaLight.userData.onIntensity = 45;
  group.add(cinemaLight);
  const screenLight = new THREE.PointLight(0xffe0b0, 25, 18);
  screenLight.position.set(0, 5, -30);
  screenLight.userData.onIntensity = 25;
  group.add(screenLight);
  const interiorLights = [cinemaLight, screenLight];

  // Every structural/decor mesh must CAST shadows — otherwise the sun
  // leaks straight through the walls and roof and lights the interior
  // unevenly (bright toward +x, black away from it) even with "lights off".
  // The ground casts too (the cinema is sunken BELOW y0 — grass blocks are
  // the only roof over the front zones).
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh !== ground && (mesh as THREE.Mesh).isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  const spawn = new THREE.Vector3(0, 0, 12);
  return {
    group,
    colliders,
    seats,
    screenMesh,
    spawn,
    materials: mats,
    lampLights,
    cinemaLight,
    interiorLights,
    glowstoneMat: mats.glowstone,
    hemi,
    sun: dir,
    leverHandle,
    leverSpot: { x: leverX, y: leverBaseY + 1.5, z: leverZ },
    ceilingPanels,
  };
}

// re-export for textures used elsewhere
export { texturedBox, grassBlock, uniformBlock };
