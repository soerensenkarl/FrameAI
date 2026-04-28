// Build Three.js geometry from a spec bundle (the same shape
// compute_geometry_specs / computeGeometrySpecs produce).
//
// Step 6: rendered behind a debug toggle alongside the legacy preview to
// confirm the spec geometry matches what buildRoom draws.
// Step 7: replaces buildRoom entirely once parity is visually proven.

import * as THREE from "three";

const DEFAULT_MAT = new THREE.MeshStandardMaterial({
  color: 0xF9BC06,
  transparent: true,
  opacity: 0.35,
  side: THREE.DoubleSide,
});


export function specsToGroup(specBundle, material) {
  const mat = material || DEFAULT_MAT;
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


function specToGeometry(spec) {
  if (spec.kind === "box") return boxGeometry(spec);
  if (spec.kind === "extruded") {
    // Drop the closing-duplicate vertex if the polyline is closed.
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


// Build a closed solid by sweeping a convex polygon (`pts`, n unique vertices
// coplanar in a plane perpendicular to `dir`) along `dir`. Triangulates as:
//   bottom cap (fan from vert 0) + top cap (reverse-fan) + n side quads.
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
  for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1);          // bottom cap
  for (let i = 1; i < n - 1; i++) indices.push(n, n + i + 1, n + i);  // top cap (reversed)
  for (let i = 0; i < n; i++) {                                       // side quads
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
