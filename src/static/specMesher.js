// Build Three.js geometry from a spec bundle (the same shape
// compute_geometry_specs / computeGeometrySpecs produce).
//
// Two entry points:
//   specsToGroup(bundle)  – translucent overlay used by the debug toggle.
//   specsToRoom(bundle, opts) – full room preview (walls with cutouts, roof,
//     floor, edges) — replaces buildRoom + buildRoof.
//
// Door/window panes still come from the legacy makeOpeningGroup; they're not
// in the spec contract.

import * as THREE from "three";

const DEFAULT_OVERLAY_MAT = new THREE.MeshStandardMaterial({
  color: 0xF9BC06,
  transparent: true,
  opacity: 0.35,
  side: THREE.DoubleSide,
});


/* ─────────────────── Translucent overlay (Step 6 toggle) ─────────────────── */

export function specsToGroup(specBundle, material) {
  const mat = material || DEFAULT_OVERLAY_MAT;
  const group = new THREE.Group();
  const all = [
    ...(specBundle.walls   || []),
    ...(specBundle.roof    || []),
    ...(specBundle.doors   || []),
    ...(specBundle.windows || []),
  ];
  for (const s of all) {
    const geo = specToGeometry(s);
    if (geo) group.add(new THREE.Mesh(geo, mat));
  }
  return group;
}


/* ─────────────────── Full room preview (Step 7) ─────────────────── */

// Renders exterior walls (with cutouts driven by spec doors+windows), roof,
// and floor. Caller passes materials. Walls are tagged with userData.isWall
// and userData.wallIdx for raycasting (matching legacy buildRoom).
//
// Interior walls and door/window panes are NOT rendered here — those stay
// with rebuildInteriorWalls and makeOpeningGroup.
export function specsToRoom(bundle, opts = {}) {
  const {
    wallMat,
    edgeMat,
    floorMat,
    drawFloor = true,
    drawEdges = true,
  } = opts;

  const group = new THREE.Group();

  // Bundle walls have exterior first (4 of them) followed by interior walls.
  const exteriorWalls = (bundle.walls || []).slice(0, 4);
  const bbox = computeBox(exteriorWalls);
  const allOpenings = [...(bundle.doors || []), ...(bundle.windows || [])];

  for (let i = 0; i < exteriorWalls.length; i++) {
    const wall = exteriorWalls[i];
    const info = wallToRenderInfo(wall, bbox);
    if (!info) continue;

    const cutouts = allOpenings
      .filter(o => o.wall_idx === i)
      .map(o => cutoutToLocalRect(o, info))
      .filter(c => c !== null);

    const meshes = buildSpecWallMesh(info, cutouts, wallMat, edgeMat, drawEdges);
    for (const m of meshes) {
      m.userData.isWall = true;
      m.userData.wallIdx = i;
      group.add(m);
    }
  }

  if (drawFloor && bbox && exteriorWalls.length > 0) {
    const t = deriveWallThickness(exteriorWalls);
    const floor = makeFloor(bbox, t, floorMat);
    if (floor) group.add(floor);
  }

  return group;
}


// Render the roof spec list as its own group (kept separate from
// specsToRoom's output because the legacy code toggles roof visibility
// independently of walls).
export function specsToRoofGroup(roofSpecs, opts = {}) {
  const { roofMat, edgeMat, drawEdges = true } = opts;
  const group = new THREE.Group();
  for (const r of (roofSpecs || [])) {
    const geo = specToGeometry(r);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, roofMat);
    mesh.castShadow = true;
    group.add(mesh);
    if (drawEdges && edgeMat) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      group.add(edges);
    }
  }
  return group;
}


/* ─────────────────── Internal helpers ─────────────────── */

function specToGeometry(spec) {
  if (spec.kind === "box") return boxGeometry(spec);
  if (spec.kind === "extruded") {
    const pts = spec.pts.slice();
    if (pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pts.pop();
    }
    return prismGeometry(pts, spec.dir);
  }
  if (spec.kind === "planar_solid") {
    return prismGeometry(spec.profile, spec.dir);
  }
  return null;
}


function boxGeometry({ x, y, z }) {
  const sx = x[1] - x[0], sy = y[1] - y[0], sz = z[1] - z[0];
  const geo = new THREE.BoxGeometry(sx, sy, sz);
  geo.translate((x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2);
  return geo;
}


// Sweep a convex polygon `pts` (n unique vertices coplanar perpendicular to
// `dir`) along `dir`. Bottom cap (fan from vert 0) + top cap (reverse-fan)
// + n side quads.
function prismGeometry(pts, dir) {
  const n = pts.length;
  if (n < 3) return null;

  const positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    positions[i * 3]         = pts[i][0];
    positions[i * 3 + 1]     = pts[i][1];
    positions[i * 3 + 2]     = pts[i][2];
    positions[(i + n) * 3]     = pts[i][0] + dir[0];
    positions[(i + n) * 3 + 1] = pts[i][1] + dir[1];
    positions[(i + n) * 3 + 2] = pts[i][2] + dir[2];
  }

  const indices = [];
  for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1);
  for (let i = 1; i < n - 1; i++) indices.push(n, n + i + 1, n + i);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j);
    indices.push(i, n + j, n + i);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}


// Wall spec → render info { from, to, outward, topPoints, t }.
// Convention (matches legacy buildRoom): walking from→to has the outer face
// on the right (CCW around the building footprint in plan view).
function wallToRenderInfo(wall, bbox) {
  if (wall.kind === "box") return boxWallInfo(wall, bbox);
  if (wall.kind === "extruded") return extrudedWallInfo(wall);
  return null;
}


function boxWallInfo(wall, bbox) {
  const dx = wall.x[1] - wall.x[0];
  const dy = wall.y[1] - wall.y[0];
  const t = Math.min(dx, dy);
  const EPS = 1;

  const isS = dy < dx && Math.abs(wall.y[0] - bbox.minY) < EPS;
  const isN = dy < dx && Math.abs(wall.y[1] - bbox.maxY) < EPS;
  const isW = dx < dy && Math.abs(wall.x[0] - bbox.minX) < EPS;
  const isE = dx < dy && Math.abs(wall.x[1] - bbox.maxX) < EPS;

  if (isS) return { from: [wall.x[0], wall.y[0]], to: [wall.x[1], wall.y[0]],
                    outward: [0, -1], topPoints: [[0, wall.z[1]], [1, wall.z[1]]], t };
  if (isN) return { from: [wall.x[1], wall.y[1]], to: [wall.x[0], wall.y[1]],
                    outward: [0,  1], topPoints: [[0, wall.z[1]], [1, wall.z[1]]], t };
  if (isW) return { from: [wall.x[0], wall.y[1]], to: [wall.x[0], wall.y[0]],
                    outward: [-1, 0], topPoints: [[0, wall.z[1]], [1, wall.z[1]]], t };
  if (isE) return { from: [wall.x[1], wall.y[0]], to: [wall.x[1], wall.y[1]],
                    outward: [ 1, 0], topPoints: [[0, wall.z[1]], [1, wall.z[1]]], t };
  return null;
}


// Pentagon (gable) or trapezoid (sloped flat). Polygon is the outer face,
// dir extrudes inward by wall thickness.
function extrudedWallInfo(wall) {
  const pts = wall.pts.slice();
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pts.pop();
  }
  if (pts.length < 4) return null;

  const dir = wall.dir;
  const t = Math.hypot(dir[0], dir[1], dir[2]);
  if (t < 1e-6) return null;
  const dirN = [dir[0] / t, dir[1] / t];
  // outward = opposite of (planar) inward direction
  const outward = [-dirN[0], -dirN[1]];

  // Find the bottom edge — two consecutive vertices at z=0.
  // For our pentagon/trapezoid shapes these are pts[0] and pts[1].
  let bot0 = -1, bot1 = -1;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i][2]) < 0.01) {
      if (bot0 === -1) bot0 = i;
      else { bot1 = i; break; }
    }
  }
  if (bot0 === -1 || bot1 === -1) return null;

  // walkDir = 90° CCW rotation of outward (so outward is on the right)
  const walkDir = [-outward[1], outward[0]];

  // Pick from/to so walking from→to runs along walkDir.
  const A = pts[bot0], B = pts[bot1];
  const dot = (B[0] - A[0]) * walkDir[0] + (B[1] - A[1]) * walkDir[1];
  let from, to, fromIdx, toIdx;
  if (dot > 0) {
    from = [A[0], A[1]]; to = [B[0], B[1]]; fromIdx = bot0; toIdx = bot1;
  } else {
    from = [B[0], B[1]]; to = [A[0], A[1]]; fromIdx = bot1; toIdx = bot0;
  }

  const wallLen = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (wallLen < 1) return null;
  const wd = [(to[0] - from[0]) / wallLen, (to[1] - from[1]) / wallLen];

  // Walk from `to` around the top side back to `from`. The "top side" is the
  // direction whose first step doesn't land on the other bottom vertex.
  let step = 1;
  if (((toIdx + step + pts.length) % pts.length) === fromIdx) step = -1;
  const topPoints = [];
  let i = (toIdx + step + pts.length) % pts.length;
  let safety = pts.length + 2;
  while (i !== fromIdx && safety-- > 0) {
    const p = pts[i];
    if (Math.abs(p[2]) > 0.01) {
      const u = ((p[0] - from[0]) * wd[0] + (p[1] - from[1]) * wd[1]) / wallLen;
      topPoints.push([Math.max(0, Math.min(1, u)), p[2]]);
    }
    i = (i + step + pts.length) % pts.length;
  }
  // Legacy convention: topPoints in increasing u.
  topPoints.sort((a, b) => a[0] - b[0]);

  return { from, to, outward, topPoints, t };
}


// Project an axis-aligned cutter box onto the wall's local (length, height)
// 2D space. Returns { left, right, bot, top } or null if no overlap.
function cutoutToLocalRect(cutter, info) {
  const { from, to } = info;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const wd = [dx / len, dy / len];

  // Project the cutter's 4 horizontal corners onto walkDir.
  const corners = [
    [cutter.x[0], cutter.y[0]],
    [cutter.x[1], cutter.y[0]],
    [cutter.x[1], cutter.y[1]],
    [cutter.x[0], cutter.y[1]],
  ];
  let lmin = Infinity, lmax = -Infinity;
  for (const c of corners) {
    const p = (c[0] - from[0]) * wd[0] + (c[1] - from[1]) * wd[1];
    lmin = Math.min(lmin, p);
    lmax = Math.max(lmax, p);
  }
  if (lmax <= 0 || lmin >= len) return null;

  return { left: lmin, right: lmax, bot: cutter.z[0], top: cutter.z[1] };
}


// Build a wall mesh in local space (length, height, thickness) and orient
// it into world space via a basis matrix. Mirrors the legacy buildWallMesh.
function buildSpecWallMesh(info, cutouts, wallMat, edgeMat, drawEdges) {
  const { from, to, outward, topPoints, t } = info;
  const fromV = new THREE.Vector3(from[0], from[1], 0);
  const toV   = new THREE.Vector3(to[0],   to[1],   0);
  const wallLen = fromV.distanceTo(toV);
  if (wallLen < 1) return [];

  const uDir = toV.clone().sub(fromV).normalize();
  const inward = new THREE.Vector3(-outward[0], -outward[1], 0);
  const up = new THREE.Vector3(0, 0, 1);

  // Face polygon: bottom corners + top profile reversed.
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(wallLen, 0);
  for (let i = topPoints.length - 1; i >= 0; i--) {
    const [u, h] = topPoints[i];
    shape.lineTo(u * wallLen, h);
  }
  shape.closePath();

  // Top profile sampler — clamps holes so they never pierce a sloped top.
  const wallTopAt = (x) => {
    const u = x / wallLen;
    const tp = topPoints;
    for (let i = 0; i < tp.length - 1; i++) {
      const [u0, y0] = tp[i], [u1, y1] = tp[i + 1];
      if (u >= u0 && u <= u1) {
        const k = (u1 === u0) ? 0 : (u - u0) / (u1 - u0);
        return y0 + (y1 - y0) * k;
      }
    }
    return tp[tp.length - 1][1];
  };

  for (const c of cutouts) {
    const left = c.left, right = c.right;
    const topBound = Math.min(
      wallTopAt(Math.max(0, left)),
      wallTopAt(Math.min(wallLen, right)),
    );
    const top = Math.min(c.top, topBound - 50);
    if (top <= c.bot) continue;
    const cLeft  = Math.max(0, left);
    const cRight = Math.min(wallLen, right);

    const hole = new THREE.Path();
    hole.moveTo(cLeft, c.bot);
    hole.lineTo(cRight, c.bot);
    hole.lineTo(cRight, top);
    hole.lineTo(cLeft, top);
    hole.closePath();
    shape.holes.push(hole);
  }

  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });

  // Local (length, height, thickness=inward) → world.
  const m = new THREE.Matrix4().makeBasis(uDir, up, inward);
  m.setPosition(fromV);

  const out = [];
  const mesh = new THREE.Mesh(geo, wallMat);
  mesh.applyMatrix4(m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  out.push(mesh);

  if (drawEdges && edgeMat) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    edges.applyMatrix4(m);
    out.push(edges);
  }
  return out;
}


function computeBox(walls) {
  if (!walls.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const w of walls) {
    if (w.kind === "box") {
      minX = Math.min(minX, w.x[0]); maxX = Math.max(maxX, w.x[1]);
      minY = Math.min(minY, w.y[0]); maxY = Math.max(maxY, w.y[1]);
    } else if (w.kind === "extruded") {
      const pts = w.pts;
      const dir = w.dir;
      for (const p of pts) {
        for (const dx of [0, dir[0]]) {
          const x = p[0] + dx;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
        for (const dy of [0, dir[1]]) {
          const y = p[1] + dy;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  return { minX, maxX, minY, maxY };
}


function deriveWallThickness(walls) {
  for (const w of walls) {
    if (w.kind === "box") {
      const dx = w.x[1] - w.x[0], dy = w.y[1] - w.y[0];
      return Math.min(dx, dy);
    }
    if (w.kind === "extruded") {
      return Math.hypot(w.dir[0], w.dir[1], w.dir[2]);
    }
  }
  return 150;
}


function makeFloor(bbox, t, mat) {
  const fw = (bbox.maxX - bbox.minX) - 2 * t;
  const fd = (bbox.maxY - bbox.minY) - 2 * t;
  if (fw <= 0 || fd <= 0) return null;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), mat);
  // 100 mm above z=0 to avoid z-fighting with the world grid helper.
  floor.position.set(
    (bbox.minX + bbox.maxX) / 2,
    (bbox.minY + bbox.maxY) / 2,
    100,
  );
  floor.receiveShadow = true;
  return floor;
}
