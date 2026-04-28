import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { computeGeometrySpecs } from "./specs.js";
import { specsToGroup } from "./specMesher.js";

/* ────────────────── renderer ────────────────── */
const vp = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0a0a0a);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.localClippingEnabled = true;
vp.appendChild(renderer.domElement);

const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 2400);

/* ────────────────── scene / camera ────────────────── */
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(35, 1, 10, 200000);
cam.position.set(9000, -7000, 7000);
cam.up.set(0, 0, 1);

const orbit = new OrbitControls(cam, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.07;
orbit.target.set(0, 0, 0);
orbit.maxPolarAngle = Math.PI / 2.05;

/* ────────────────── lights ────────────────── */
// Only a studio IBL — no direct lights, no shadows. Scene lighting is fully image-based.
const pmrem = new THREE.PMREMGenerator(renderer);
const studioEnvMap = pmrem.fromScene(new RoomEnvironment()).texture;
pmrem.dispose();
scene.environment = studioEnvMap;
renderer.toneMappingExposure = 0.8;

/* ────────────────── ground ────────────────── */
const GRID = 30000;
const grid = new THREE.GridHelper(GRID, 60, 0x2a2a2a, 0x222222);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

/* ────────────────── snap cursor (orange sphere) ──────────────────
   Sphere so it reads right at any 3D position — the measure tool snaps
   vertically (wall tops, vertical edges), not just on the ground plane.
   Ground-plane callers send z=2 and the sphere sits just above the floor. */
const dot = new THREE.Mesh(
  new THREE.SphereGeometry(20, 20, 16),
  new THREE.MeshBasicMaterial({ color: 0xF9BC06, depthTest: false })
);
dot.renderOrder = 999;
dot.position.set(0, 0, 2);
dot.visible = false;
scene.add(dot);

// Geometry radius of the roving dot (matches the SphereGeometry above).
const DOT_GEOM_RADIUS = 20;
const DOT_WORLD_R = 60;  // natural world-space radius (mm) — shrinks on screen as you zoom in
const DOT_MIN_PX = 4;    // floor: never smaller than this when zoomed far out
const DOT_MAX_PX = 10;    // ceiling: never larger than this when zoomed very close

function dotZoomScale() {
  const wpp = worldPerPixelAt(dot.position);
  const worldR = Math.max(DOT_MIN_PX * wpp, Math.min(DOT_WORLD_R, DOT_MAX_PX * wpp));
  return worldR / DOT_GEOM_RADIUS;
}

let dotSnapMode = false;   // tracked so the per-frame update preserves the lock-on 2.2× boost
function moveDot(snapped) {
  // Respect a z on the snap point when present; fall back to the floor-hover
  // height for 2D callers (wall drawing, box placement, etc).
  const z = (snapped.z !== undefined && snapped.z !== 0) ? snapped.z : 2;
  dot.position.set(snapped.x, snapped.y, z);
  dotSnapMode = !!snapped.snapped;
  applyDotScale();
  dot.visible = true;
}

function applyDotScale() {
  const base = dotZoomScale();
  const lock = dotSnapMode ? 2.2 : 1;
  const s = base * lock;
  dot.scale.set(s, s, s);
}

function hideDot() {
  dot.visible = false;
}

/* ─── Face alignment indicator ───
 * Snaps store CENTERLINE coords, but the rendered wall retracts to meet the
 * receiver's FACE. The indicator previews those face lines so the user sees
 * exactly where the wall will land when they click. Only active while drawing
 * interior walls and only when the snap point lies on another interior wall's
 * centerline (T or L-corner into that wall).
 */
const faceIndicatorMat = new THREE.LineBasicMaterial({
  color: 0xF9BC06, transparent: true, opacity: 0.75, depthTest: false,
});
const faceIndicator = new THREE.Group();
faceIndicator.renderOrder = 999;
faceIndicator.visible = false;
scene.add(faceIndicator);

function updateFaceIndicator(snapped) {
  while (faceIndicator.children.length) faceIndicator.remove(faceIndicator.children[0]);
  const EPS = 1.0;
  const halfT = (+inTI.value) / 2;
  const SEG = 600;

  let targetIsHoriz = null;
  for (const w of interiorWalls) {
    const isHoriz = Math.abs(w.y1 - w.y0) < 1;
    if (isHoriz) {
      if (Math.abs(snapped.y - w.y0) > EPS) continue;
      const xmin = Math.min(w.x0, w.x1), xmax = Math.max(w.x0, w.x1);
      if (snapped.x >= xmin - EPS && snapped.x <= xmax + EPS) { targetIsHoriz = true; break; }
    } else {
      if (Math.abs(snapped.x - w.x0) > EPS) continue;
      const ymin = Math.min(w.y0, w.y1), ymax = Math.max(w.y0, w.y1);
      if (snapped.y >= ymin - EPS && snapped.y <= ymax + EPS) { targetIsHoriz = false; break; }
    }
  }
  if (targetIsHoriz === null) { faceIndicator.visible = false; return; }

  const z = 3;
  const segs = targetIsHoriz
    ? [
        [[snapped.x - SEG / 2, snapped.y - halfT, z], [snapped.x + SEG / 2, snapped.y - halfT, z]],
        [[snapped.x - SEG / 2, snapped.y + halfT, z], [snapped.x + SEG / 2, snapped.y + halfT, z]],
      ]
    : [
        [[snapped.x - halfT, snapped.y - SEG / 2, z], [snapped.x - halfT, snapped.y + SEG / 2, z]],
        [[snapped.x + halfT, snapped.y - SEG / 2, z], [snapped.x + halfT, snapped.y + SEG / 2, z]],
      ];
  for (const [a, b] of segs) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b], 3));
    faceIndicator.add(new THREE.Line(geo, faceIndicatorMat));
  }
  faceIndicator.visible = true;
}

function hideFaceIndicator() { faceIndicator.visible = false; }

/* ────────────────── snap guide tower ────────────────── */
const snapBarMat = new THREE.MeshBasicMaterial({ color: 0xF9BC06, transparent: true, opacity: 0.5, depthTest: false });
const snapTower = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), snapBarMat);
snapTower.renderOrder = 998;
snapTower.visible = false;
scene.add(snapTower);

function showSnapBars(snapped) {
  if (!snapped.snappedX && !snapped.snappedY) { hideSnapBars(); return; }
  const h = +inH.value;
  const t = +inT.value;
  snapTower.geometry.dispose();
  snapTower.geometry = new THREE.BoxGeometry(t, t, h);
  snapTower.position.set(snapped.x, snapped.y, h / 2);
  snapTower.visible = true;
}

function hideSnapBars() {
  snapTower.visible = false;
}

/* ────────────────── materials ────────────────── */
const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.82, metalness: 0 });
const ghostMat = new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.82, metalness: 0, transparent: true, opacity: 0.5 });
const edgeMat = new THREE.LineBasicMaterial({ color: 0xaaaaaa });
const ghostEdge = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.4 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0xe6e3dd, roughness: 0.95, metalness: 0 });
const ghostFloor = new THREE.MeshStandardMaterial({ color: 0xe6e3dd, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.35 });

const frameTex = new THREE.TextureLoader().load('/static/assets/pine.jpg');
frameTex.wrapS = frameTex.wrapT = THREE.RepeatWrapping;
frameTex.colorSpace = THREE.SRGBColorSpace;
frameTex.anisotropy = 4;

const frameMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });
frameMat.userData.uniforms = {
  tWood:      { value: frameTex },
  uTileScale: { value: 1.0 / 600.0 },
};
frameMat.onBeforeCompile = (shader) => {
  shader.uniforms.tWood      = frameMat.userData.uniforms.tWood;
  shader.uniforms.uTileScale = frameMat.userData.uniforms.uTileScale;

  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute vec3 aMemberTangent;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;`
    )
    .replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      vWorldNormal  = normalize(mat3(modelMatrix) * objectNormal);
      vWorldTangent = normalize(mat3(modelMatrix) * aMemberTangent);`
    )
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      uniform sampler2D tWood;
      uniform float uTileScale;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;`
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      // Tangent frame aligned to each member's long axis so grain flows down its length.
      vec3 N = normalize(vWorldNormal);
      vec3 T = normalize(vWorldTangent);
      vec3 B = cross(N, T);
      float bLen = length(B);
      if (bLen < 0.1) {
        T = abs(N.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
        B = cross(N, T);
        bLen = length(B);
      }
      B /= bLen;
      T = normalize(cross(B, N));
      vec2 woodUv = vec2(dot(vWorldPos, T), dot(vWorldPos, B)) * uTileScale;
      diffuseColor.rgb *= texture2D(tWood, woodUv).rgb;`
    )
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      // Fake bevel: screen-space derivative of the world normal spikes at creases between faces.
      float edgeAmt = length(fwidth(vWorldNormal));
      float bevel = smoothstep(0.25, 1.0, edgeAmt);
      totalEmissiveRadiance += vec3(1.0, 0.92, 0.78) * bevel * 0.4;`
    );
};

const windowMat = new THREE.MeshStandardMaterial({ color: 0x7ebadb, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.3, side: THREE.DoubleSide });
const windowFrameMat = new THREE.LineBasicMaterial({ color: 0x4499bb });
const doorMat = new THREE.MeshStandardMaterial({ color: 0x8B7355, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
const doorFrameMat = new THREE.LineBasicMaterial({ color: 0x6b5335 });
const ghostOpeningMat = new THREE.MeshStandardMaterial({ color: 0xF9BC06, transparent: true, opacity: 0.35, roughness: 0.5, side: THREE.DoubleSide, depthTest: false });
const ghostOpeningEdgeMat = new THREE.LineBasicMaterial({ color: 0xF9BC06, transparent: true, opacity: 0.5 });
const roofMat = new THREE.MeshStandardMaterial({ color: 0xc8bfb0, roughness: 0.7, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const roofEdgeMat = new THREE.LineBasicMaterial({ color: 0x999999 });

/* ────────────────── drag arrows ────────────────── */
// Arrow shape: flat triangle + stem, pointing +Y in local space
function makeArrowMesh() {
  const outlinePts = [
    [0, 280], [-150, 70], [-55, 70], [-55, -140],
    [55, -140], [55, 70], [150, 70], [0, 280],  // close back to tip
  ];
  const shape = new THREE.Shape();
  shape.moveTo(outlinePts[0][0], outlinePts[0][1]);
  for (let i = 1; i < outlinePts.length - 1; i++) {
    shape.lineTo(outlinePts[i][0], outlinePts[i][1]);
  }
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.DoubleSide, depthTest: false,
    transparent: true, opacity: 0.9,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 998;

  // Orange outline — a closed polyline in the shape's local plane, parented
  // to the mesh so any geometry rotation (makeUpArrow does rotateX, the four
  // horizontal arrows do rotateZ) carries the outline along for free.
  const outlineGeo = new THREE.BufferGeometry();
  const verts = new Float32Array(outlinePts.length * 3);
  for (let i = 0; i < outlinePts.length; i++) {
    verts[i * 3]     = outlinePts[i][0];
    verts[i * 3 + 1] = outlinePts[i][1];
    verts[i * 3 + 2] = 0;
  }
  outlineGeo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  const outlineMat = new THREE.LineBasicMaterial({
    color: 0xF9BC06, transparent: true, opacity: 0.95, depthTest: false,
  });
  const outline = new THREE.Line(outlineGeo, outlineMat);
  outline.renderOrder = 999;
  outline.userData.isArrowOutline = true;
  m.add(outline);
  return m;
}

const COL_DEFAULT = new THREE.Color(0xffffff);
const COL_HOVER   = new THREE.Color(0xF9BC06);
let hoveredArrow = null;

function setArrowHover(arrow) {
  if (hoveredArrow === arrow) return;
  if (hoveredArrow) {
    hoveredArrow.material.color.copy(COL_DEFAULT);
    const base = hoveredArrow.userData.baseScale || 1;
    hoveredArrow.scale.set(base, base, base);
  }
  hoveredArrow = arrow;
  if (hoveredArrow) {
    hoveredArrow.material.color.copy(COL_HOVER);
    const base = hoveredArrow.userData.baseScale || 1;
    hoveredArrow.scale.set(base * 1.3, base * 1.3, base * 1.3);
  }
}

// 4 arrows: south(-Y), north(+Y), west(-X), east(+X)
const arrows = [];
const ARROW_DIRS = [
  { axis: "y", sign: -1 },   // south
  { axis: "y", sign:  1 },   // north
  { axis: "x", sign: -1 },   // west
  { axis: "x", sign:  1 },   // east
];
// Shape is in XY plane pointing +Y. Ground is XY (Z=up). Just rotate Z.
// south=-Y, north=+Y, west=-X, east=+X
const ARROW_ROT_Z = [Math.PI, 0, Math.PI / 2, -Math.PI / 2];
// Helper: bake a rotation into the arrow's geometry AND its outline child so
// they stay aligned. (Geometry rotation is baked — not the object transform —
// so a child with its own geometry needs the same treatment.)
function rotateArrowGeo(arrow, axis, angle) {
  arrow.geometry = arrow.geometry.clone();
  arrow.geometry[axis === "x" ? "rotateX" : axis === "y" ? "rotateY" : "rotateZ"](angle);
  for (const child of arrow.children) {
    if (child.userData && child.userData.isArrowOutline) {
      child.geometry = child.geometry.clone();
      child.geometry[axis === "x" ? "rotateX" : axis === "y" ? "rotateY" : "rotateZ"](angle);
    }
  }
}
for (let i = 0; i < 4; i++) {
  const a = makeArrowMesh();
  a.visible = false;
  a.userData.idx = i;
  rotateArrowGeo(a, "z", ARROW_ROT_Z[i]);
  scene.add(a);
  arrows.push(a);
}

function positionArrows() {
  if (houseMode === 'free') return;
  if (!c1 || !c2) return;
  const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
  const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const off = 350;

  arrows[0].position.set(mx, y0 - off, 10);  // south
  arrows[1].position.set(mx, y1 + off, 10);  // north
  arrows[2].position.set(x0 - off, my, 10);  // west
  arrows[3].position.set(x1 + off, my, 10);  // east
  for (const a of arrows) a.visible = true;

  heightArrow.position.set(mx, my, (+inH.value) + off);
  heightArrow.visible = true;
}

function hideArrows() {
  for (const a of arrows) a.visible = false;
  ridgeArrow.visible = false;
  slopeArrows[0].visible = false;
  slopeArrows[1].visible = false;
  for (const a of roofArrows) a.visible = false;
  heightArrow.visible = false;
  setArrowHover(null);
}

// Shared upward-pointing arrow geometry (rotated to point +Z)
function makeUpArrow() {
  const a = makeArrowMesh();
  a.visible = false;
  rotateArrowGeo(a, "x", Math.PI / 2);
  scene.add(a);
  return a;
}

// Ridge height arrow (gable)
const ridgeArrow = makeUpArrow();
ridgeArrow.userData.isRidge = true;

// Flat roof slope arrows: one at each end perpendicular to ridge axis
const slopeArrows = [makeUpArrow(), makeUpArrow()];
slopeArrows[0].userData.slopeEdge = 0;
slopeArrows[1].userData.slopeEdge = 1;

// Roof overhang arrows: 4 horizontal arrows, one per side of the building,
// for dragging eave/gable overhangs. Direction (eave vs gable) depends on
// ridge orientation and is set in positionRoofArrows. Indices map to:
// 0=south, 1=north, 2=west, 3=east — same convention as footprint arrows.
const roofArrows = [];
for (let i = 0; i < 4; i++) {
  const a = makeArrowMesh();
  a.visible = false;
  a.userData.roofSide = i;
  // Overhang arrows are secondary handles — keep them more subdued than the
  // main ridge / slope / height arrows so they don't compete for attention.
  a.material.opacity = 0.4;
  for (const c of a.children) {
    if (c.userData && c.userData.isArrowOutline) c.material.opacity = 0.45;
  }
  a.scale.set(0.7, 0.7, 0.7);
  a.userData.baseScale = 0.7;
  rotateArrowGeo(a, "z", ARROW_ROT_Z[i]);
  scene.add(a);
  roofArrows.push(a);
}

// Footprint height arrow (drag to change wall height in step 0)
const heightArrow = makeUpArrow();
heightArrow.userData.isHeight = true;

// Vertical arrows billboard around world Z each frame so their face always
// points at the camera (same trick the scale worker uses). Without this they
// go edge-on when the camera orbits perpendicular to their baked face normal.
const VERTICAL_ARROWS = [ridgeArrow, slopeArrows[0], slopeArrows[1], heightArrow];

// Opening move-gimbal (shown when an opening is selected in step 2). Lives
// in the wall plane: center ring + 4 white arrows with yellow outlines —
// matching the room/ridge/height arrow style used elsewhere in the project.
// Local axes: +X = along the wall, +Y = world up (Z), +Z = wall outward.
//   • Center ring  → free move (along + vertical for a single window)
//   • Along arrows → constrained slide along the wall
//   • Vertical arrows → constrained sill change (windows only)
function makeSlideHandle() {
  const matHit = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0,
    depthWrite: false, depthTest: false, side: THREE.DoubleSide,
  });

  const group = new THREE.Group();
  group.visible = false;

  // Each arrow is a sub-group: makeArrowMesh() at full size, translated
  // outward in local space, then the sub-group is scaled+rotated. The scale
  // sits on the sub-group (not the arrow itself) so setArrowHover's
  // arrow.scale=1.3 doesn't overwrite our shrink — instead it compounds:
  // sub.scale × hover.scale. That's how the room/ridge arrows get a snappy
  // grow-on-hover that lands back at the right size.
  const SUB_SCALE = 0.5;          // 50% of normal arrow size
  const ARROW_BASE_OFFSET = 60;   // unscaled gap between gimbal origin and arrow base
  function makeGimbalArrow(rotZ, role, sign) {
    const sub = new THREE.Group();
    sub.scale.setScalar(SUB_SCALE);
    const arrow = makeArrowMesh();   // shape runs y∈[-140, +280] (420 tall)
    arrow.position.y = ARROW_BASE_OFFSET + 140;   // base sits at sub-local y = ARROW_BASE_OFFSET
    arrow.userData.role = role;
    arrow.userData.sign = sign;
    sub.add(arrow);
    // Padded invisible hit pad spanning the arrow's full extent in sub local.
    const hitH = 420 + 40;
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(180 + 40, hitH), matHit);
    hit.position.y = arrow.position.y + 70;        // arrow midpoint above its origin
    hit.userData.role = role;
    hit.userData.sign = sign;
    hit.renderOrder = 997;
    sub.add(hit);
    sub.rotation.z = rotZ;
    sub.userData.role = role;
    sub.userData.sign = sign;
    sub.userData.gimbalArrow = arrow;
    return sub;
  }
  group.add(makeGimbalArrow( 0,             "vertical",  1));   // up
  group.add(makeGimbalArrow( Math.PI,       "vertical", -1));   // down
  group.add(makeGimbalArrow(-Math.PI / 2,   "along",     1));   // right (along+)
  group.add(makeGimbalArrow( Math.PI / 2,   "along",    -1));   // left  (along-)

  scene.add(group);
  return group;
}
const slideHandle = makeSlideHandle();
let draggingSlide = -1;  // sentinel ≥0 means a gimbal drag is in progress
let gizmoDrag = null;    // { role, sign, info, plane, startHit, indices, startStates }

// Anchor the gimbal. With no arg or empty selection, falls back to the
// current opening selection (single OR multi). Multi-select anchors at the
// centroid of selected openings — dragging from there shifts the whole group.
function positionSlideHandle(idx) {
  let indices;
  if (typeof idx === "number" && idx >= 0) {
    indices = [idx];
  } else if (typeof selectedOpeningIndices === "function") {
    indices = selectedOpeningIndices();
  } else {
    indices = selectedOpening >= 0 ? [selectedOpening] : [];
  }
  if (!indices.length) { slideHandle.visible = false; return; }
  const firstWall = openings[indices[0]].wallIdx;
  if (!indices.every(i => openings[i].wallIdx === firstWall)) {
    slideHandle.visible = false; return;
  }
  const info = wallInfo(firstWall);
  if (!info) { slideHandle.visible = false; return; }

  // Centroid posAlong + average vertical center.
  let avgPos = 0, avgZ = 0;
  for (const i of indices) {
    const o = openings[i];
    avgPos += o.posAlong;
    const bot = o.type === "window" ? (o.sill || 0) : 0;
    avgZ += bot + o.height / 2;
  }
  avgPos /= indices.length;
  avgZ /= indices.length;

  // Sit flush on the wall's outer face — depthTest:false keeps it visible,
  // a tiny outward bump (2 mm) avoids z-fighting with the wall surface.
  const cx = info.origin.x + info.along.x * avgPos + info.outward.x * 2;
  const cy = info.origin.y + info.along.y * avgPos + info.outward.y * 2;
  slideHandle.position.set(cx, cy, avgZ);

  // Orient: local +X → info.along, local +Y → world Z, local +Z → info.outward.
  const m = new THREE.Matrix4().makeBasis(
    info.along, new THREE.Vector3(0, 0, 1), info.outward
  );
  slideHandle.quaternion.setFromRotationMatrix(m);

  // Vertical arrows only make sense for a single window (sill is window-only,
  // and shifting many sills at once via one handle is rarely what the user
  // wants). Hide for doors and for multi-select.
  const showVertical = indices.length === 1 && openings[indices[0]].type === "window";
  for (const child of slideHandle.children) {
    if (child.userData && child.userData.role === "vertical") {
      child.visible = showVertical;
    }
  }
  slideHandle.visible = true;
}
function setSlideHandleHover(hover) {
  // Per-arrow hover styling lives in setArrowHover (used by other arrows in
  // the project). Keep this helper as a no-op stub so existing call sites
  // don't crash; per-part hover can be wired in later if desired.
}

let customRidgeH = null;

// Design limits — allow fun extremes but stay buildable.
const LIM = {
  W_MIN: 2000,  W_MAX: 30000,
  D_MIN: 2000,  D_MAX: 20000,
  H_MIN: 2000,  H_MAX: 5000,
  FLAT_SLOPE_MAX: 3000,   // max vertical delta across a flat-sloped roof
  RIDGE_MIN: 200,
  SLOPE_MIN_DEG: 1, SLOPE_MAX_DEG: 45,
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
let flatSlopeH = [0, 0];  // [edge0, edge1] height offsets for flat roof slope
let eaveOH = 0;           // gable-roof eave overhang (mirrored, both sides)
let gableOH = 0;          // gable-roof gable overhang (mirrored, both sides)
const OH_MAX = 500;       // max overhang in mm (50 cm)

function defaultRidgeH() {
  if (!c1 || !c2) return 500;
  const w = Math.abs(c2.x - c1.x), d = Math.abs(c2.y - c1.y);
  return Math.min(w, d) * 0.35;
}

function getRidgeH() {
  return customRidgeH !== null ? customRidgeH : defaultRidgeH();
}

function positionRoofArrows() {
  // Arrows are roof-editing handles (ridge height for gable, edge slope for
  // flat, eave/gable overhang for gable). Hide whenever no roof is selected.
  if (!c1 || !c2 || currentStep !== 3 || roofType === "none") {
    ridgeArrow.visible = false;
    slopeArrows[0].visible = false;
    slopeArrows[1].visible = false;
    for (const a of roofArrows) a.visible = false;
    return;
  }
  const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
  const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
  const h = +inH.value;
  const w = x1 - x0, d = y1 - y0;
  const roofT = +inTR.value;
  const ridgeAlongX = w >= d;

  if (roofType === "gable") {
    const t = +inT.value;
    const rh = getRidgeH();
    const halfSpan = ridgeAlongX ? d / 2 : w / 2;
    const s = roofT - rh * t / halfSpan;
    ridgeArrow.position.set((x0 + x1) / 2, (y0 + y1) / 2, h + rh + s);
    ridgeArrow.visible = true;
    slopeArrows[0].visible = false;
    slopeArrows[1].visible = false;

    // Overhang arrows: 0=S, 1=N, 2=W, 3=E. Role (eave vs gable) flips with
    // ridge orientation. Eave arrows sit at the slab underside out past the
    // wall; gable arrows sit at ridge height out past the gable wall.
    const slope = rh / halfSpan;
    const eaveZ = h + s - eaveOH * slope;
    const off = 350;
    // Tilt eave arrows to lie parallel to the sloped roof surface. Gable
    // arrows stay flat (the roof is horizontal along the ridge axis).
    const slopeAngle = Math.atan(slope);
    for (const a of roofArrows) a.rotation.set(0, 0, 0);
    if (ridgeAlongX) {
      // S/N = eave, W/E = gable
      roofArrows[0].position.set((x0 + x1) / 2, y0 - eaveOH - off, eaveZ);
      roofArrows[1].position.set((x0 + x1) / 2, y1 + eaveOH + off, eaveZ);
      roofArrows[2].position.set(x0 - gableOH - off, (y0 + y1) / 2, h + rh + s);
      roofArrows[3].position.set(x1 + gableOH + off, (y0 + y1) / 2, h + rh + s);
      roofArrows[0].userData.role = roofArrows[1].userData.role = "eave";
      roofArrows[2].userData.role = roofArrows[3].userData.role = "gable";
      // Tilt south/north arrows around world X so the outward-pointing tip
      // aims along the slope (down-and-out instead of straight out).
      roofArrows[0].rotation.x =  slopeAngle;   // -Y outward → tilts to -Z
      roofArrows[1].rotation.x = -slopeAngle;   // +Y outward → tilts to -Z
    } else {
      // W/E = eave, S/N = gable
      roofArrows[2].position.set(x0 - eaveOH - off, (y0 + y1) / 2, eaveZ);
      roofArrows[3].position.set(x1 + eaveOH + off, (y0 + y1) / 2, eaveZ);
      roofArrows[0].position.set((x0 + x1) / 2, y0 - gableOH - off, h + rh + s);
      roofArrows[1].position.set((x0 + x1) / 2, y1 + gableOH + off, h + rh + s);
      roofArrows[2].userData.role = roofArrows[3].userData.role = "eave";
      roofArrows[0].userData.role = roofArrows[1].userData.role = "gable";
      // West/east arrows tilt around world Y for the same effect.
      roofArrows[2].rotation.y = -slopeAngle;   // -X outward → tilts to -Z
      roofArrows[3].rotation.y =  slopeAngle;   // +X outward → tilts to -Z
    }
    for (const a of roofArrows) a.visible = true;
  } else {
    // Flat roof: keep the existing edge-height slopeArrows AND add overhang
    // arrows. Overhang arrows tilt along the slope (when there is one) so they
    // visually trace the roof surface like the gable case.
    ridgeArrow.visible = false;
    const f = flatSlopeH[0], b = flatSlopeH[1];
    const span = ridgeAlongX ? d : w;
    const slope = (b - f) / span;
    const off = 350;
    const off_a = 100; //arrow goes a bit past the wall on the slope side
    // Place edge-height arrows at each end perpendicular to ridge axis.
    if (ridgeAlongX) {
      slopeArrows[0].position.set((x0 + x1) / 2, y0, h + roofT + f);
      slopeArrows[1].position.set((x0 + x1) / 2, y1, h + roofT + b);
    } else {
      slopeArrows[0].position.set(x0, (y0 + y1) / 2, h + roofT + f);
      slopeArrows[1].position.set(x1, (y0 + y1) / 2, h + roofT + b);
    }
    slopeArrows[0].visible = true;
    slopeArrows[1].visible = true;

    // Overhang arrows. eave = along slope axis, gable = perpendicular.
    const slopeAngle = Math.atan(slope);
    for (const a of roofArrows) a.rotation.set(0, 0, 0);
    if (ridgeAlongX) {
      // S/N = eave (slope axis is Y), W/E = gable
      // eave underside z extrapolates the slope past each end
      const zS = h + f - eaveOH * slope;
      const zN = h + b + eaveOH * slope;
      // gable side z: midpoint of the slab (so arrow sits at slab middle in Z)
      const zMidTop = h + roofT + (f + b) / 2;
      roofArrows[0].position.set((x0 + x1) / 2, y0 - eaveOH - off, zS);
      roofArrows[1].position.set((x0 + x1) / 2, y1 + eaveOH + off, zN);
      roofArrows[2].position.set(x0 - gableOH - off, (y0 + y1) / 2, zMidTop);
      roofArrows[3].position.set(x1 + gableOH + off, (y0 + y1) / 2, zMidTop);
      roofArrows[0].userData.role = roofArrows[1].userData.role = "eave";
      roofArrows[2].userData.role = roofArrows[3].userData.role = "gable";
      // Both eaves tilt the SAME way (slab tilts continuously across the span):
      // going -Y from y0 the slab drops/rises by `slope`, going +Y from y1 it
      // continues at that slope. (Differs from gable, where both eaves drop
      // away from a central ridge.)
      roofArrows[0].rotation.x = slopeAngle;
      roofArrows[1].rotation.x = slopeAngle;
    } else {
      // W/E = eave (slope axis is X), S/N = gable
      const zW = h + f - eaveOH * slope;
      const zE = h + b + eaveOH * slope;
      const zMidTop = h + roofT + (f + b) / 2;
      roofArrows[2].position.set(x0 - eaveOH - off, (y0 + y1) / 2, zW);
      roofArrows[3].position.set(x1 + eaveOH + off, (y0 + y1) / 2, zE);
      roofArrows[0].position.set((x0 + x1) / 2, y0 - gableOH - off, zMidTop);
      roofArrows[1].position.set((x0 + x1) / 2, y1 + gableOH + off, zMidTop);
      roofArrows[2].userData.role = roofArrows[3].userData.role = "eave";
      roofArrows[0].userData.role = roofArrows[1].userData.role = "gable";
      roofArrows[2].rotation.y = -slopeAngle;
      roofArrows[3].rotation.y = -slopeAngle;
    }
    for (const a of roofArrows) a.visible = true;
  }
}

let dragging = null;  // { idx, axis, sign }
let draggingRidge = false;
let draggingSlopeEdge = -1;  // 0 or 1 when dragging a flat roof slope arrow
let draggingHeight = false;
let draggingRoofOH = null;   // { side, role } when dragging an eave/gable overhang arrow

/* ────────────────── dimension lines ────────────────── */
let dimGroup = null;
const dimLabels = [];
const dimLineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: false });
const dimLineMatAccent = new THREE.LineBasicMaterial({ color: 0xF9BC06, transparent: true, opacity: 0.9, depthTest: false });

function makeTextSprite(text, fillStyle, fontSize, bgColor) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  fontSize = fontSize || 64;
  ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const m = ctx.measureText(text);
  const padX = bgColor ? 28 : 20;
  const padY = bgColor ? 14 : 0;
  c.width = m.width + padX * 2;
  c.height = fontSize * 1.4 + padY * 2;
  // re-set font after resize
  ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  if (bgColor) {
    const rx = c.height / 2;  // full-pill radius
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0, 0, c.width, c.height, rx);
    else {
      ctx.moveTo(rx, 0);
      ctx.lineTo(c.width - rx, 0);
      ctx.arc(c.width - rx, c.height / 2, rx, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(rx, c.height);
      ctx.arc(rx, c.height / 2, rx, Math.PI / 2, -Math.PI / 2);
    }
    ctx.fill();
  }
  ctx.fillStyle = fillStyle || "rgba(255,255,255,0.7)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 999;
  // scale: 1 canvas pixel ≈ 3 world units looks good
  sprite.scale.set(c.width * 3, c.height * 3, 1);
  return sprite;
}

function updateDims(a, b) {
  if (dimGroup) { scene.remove(dimGroup); dimGroup = null; }
  dimLabels.length = 0;
  if (houseMode === 'free') return;
  const pa = a || c1, pb = b || c2;
  if (!pa || !pb) return;

  dimGroup = new THREE.Group();
  const x0 = Math.min(pa.x, pb.x), x1 = Math.max(pa.x, pb.x);
  const y0 = Math.min(pa.y, pb.y), y1 = Math.max(pa.y, pb.y);
  const w = x1 - x0, d = y1 - y0;
  const z = 3;           // slightly above ground
  const gap = 1000;      // offset from walls (1 m)
  const tick = 150;      // outer tick length
  const tickIn = gap - 150;  // inner tick extends toward house, stopping 150 mm short

  // ── Width dim (along bottom, south side) ──
  const wy = y0 - gap;
  const wPts = [
    // left tick
    new THREE.Vector3(x0, wy - tick, z), new THREE.Vector3(x0, wy + tickIn, z),
    // main line
    new THREE.Vector3(x0, wy, z), new THREE.Vector3(x1, wy, z),
    // right tick
    new THREE.Vector3(x1, wy - tick, z), new THREE.Vector3(x1, wy + tickIn, z),
  ];
  const wGeo = new THREE.BufferGeometry().setFromPoints(wPts);
  const wLine = new THREE.LineSegments(wGeo, dimLineMat);
  wLine.renderOrder = 999;
  dimGroup.add(wLine);

  const wLabel = makeTextSprite((w / 1000).toFixed(2) + " m");
  wLabel.position.set((x0 + x1) / 2, wy - 300, z);
  wLabel.userData.dimAxis = "w";
  dimGroup.add(wLabel);
  dimLabels.push(wLabel);

  // ── Depth dim (along right side, east side) ──
  const dx = x1 + gap;
  const dPts = [
    // bottom tick
    new THREE.Vector3(dx - tickIn, y0, z), new THREE.Vector3(dx + tick, y0, z),
    // main line
    new THREE.Vector3(dx, y0, z), new THREE.Vector3(dx, y1, z),
    // top tick
    new THREE.Vector3(dx - tickIn, y1, z), new THREE.Vector3(dx + tick, y1, z),
  ];
  const dGeo = new THREE.BufferGeometry().setFromPoints(dPts);
  const dLine = new THREE.LineSegments(dGeo, dimLineMat);
  dLine.renderOrder = 999;
  dimGroup.add(dLine);

  const dLabel = makeTextSprite((d / 1000).toFixed(2) + " m");
  dLabel.position.set(dx + 300, (y0 + y1) / 2, z);
  dLabel.userData.dimAxis = "d";
  dimGroup.add(dLabel);
  dimLabels.push(dLabel);

  // ── Height dim (vertical, at south-west corner) ──
  const h = +inH.value;
  const hx = x0 - gap;
  const hy = y0;
  const hPts = [
    // bottom tick
    new THREE.Vector3(hx - tick, hy, 0), new THREE.Vector3(hx + tickIn, hy, 0),
    // main line
    new THREE.Vector3(hx, hy, 0), new THREE.Vector3(hx, hy, h),
    // top tick
    new THREE.Vector3(hx - tick, hy, h), new THREE.Vector3(hx + tickIn, hy, h),
  ];
  const hGeo = new THREE.BufferGeometry().setFromPoints(hPts);
  const hLine = new THREE.LineSegments(hGeo, dimLineMat);
  hLine.renderOrder = 999;
  dimGroup.add(hLine);

  const hLabel = makeTextSprite((h / 1000).toFixed(2) + " m");
  hLabel.position.set(hx - 300, hy, h / 2);
  hLabel.userData.dimAxis = "h";
  dimGroup.add(hLabel);
  dimLabels.push(hLabel);

  scene.add(dimGroup);
}

function hideDims() {
  if (dimGroup) { scene.remove(dimGroup); dimGroup = null; }
  dimLabels.length = 0;
}

function showRoofDims() {
  if (dimGroup) { scene.remove(dimGroup); dimGroup = null; }
  dimLabels.length = 0;
  if (houseMode === 'free') return;
  if (!c1 || !c2) return;
  if (roofType !== 'gable' && roofType !== 'flat') return;

  dimGroup = new THREE.Group();
  const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
  const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
  const w = x1 - x0, d = y1 - y0;
  const h = +inH.value;
  const t = +inT.value;
  const roofT = +inTR.value;
  const ridgeAlongX = w >= d;

  // For gable: apex at mid-line (kipZ), eaves at the gable-end corners.
  // For flat: high/low corners are at the two slab edges set by flatSlopeH.
  let kipZ, eaveZ, slopeDeg, slopeRad, halfSpan, anchorY, anchorX;
  if (roofType === 'gable') {
    const ridgeH = getRidgeH();
    halfSpan = ridgeAlongX ? d / 2 : w / 2;
    const s = roofT - ridgeH * t / halfSpan;
    eaveZ = h + s;
    kipZ = h + ridgeH + s;
    slopeRad = Math.atan2(ridgeH, halfSpan);
    slopeDeg = slopeRad * 180 / Math.PI;
    anchorX = x0; anchorY = y0;
  } else {
    // flat — anchor angle wedge at the LOW corner so it opens up toward high.
    const f = flatSlopeH[0], b = flatSlopeH[1];
    const span = ridgeAlongX ? d : w;
    halfSpan = span;
    const lowEdge = Math.min(f, b), highEdge = Math.max(f, b);
    eaveZ = h + roofT + lowEdge;
    kipZ  = h + roofT + highEdge;
    slopeRad = Math.atan2(highEdge - lowEdge, span);
    slopeDeg = slopeRad * 180 / Math.PI;
    if (ridgeAlongX) { anchorX = x0; anchorY = (f <= b) ? y0 : y1; }
    else             { anchorX = (f <= b) ? x0 : x1; anchorY = y0; }
  }

  const tick = 150;
  const accent = "#F9BC06";
  const labelBg = "rgba(40,40,40,0.82)";
  const labelSize = 44;
  // Vertical dim anchored at (vx, vy) going from z=0 to z=zTop.
  // tickAxis "x" → tick marks run along ±x (for gable end facing ±x).
  // tickAxis "y" → tick marks run along ±y.
  const makeVert = (vx, vy, zTop, axis, label, tickAxis) => {
    const pts = (tickAxis === "y") ? [
      new THREE.Vector3(vx, vy - tick, 0),    new THREE.Vector3(vx, vy + tick, 0),
      new THREE.Vector3(vx, vy, 0),           new THREE.Vector3(vx, vy, zTop),
      new THREE.Vector3(vx, vy - tick, zTop), new THREE.Vector3(vx, vy + tick, zTop),
    ] : [
      new THREE.Vector3(vx - tick, vy, 0),    new THREE.Vector3(vx + tick, vy, 0),
      new THREE.Vector3(vx,        vy, 0),    new THREE.Vector3(vx, vy, zTop),
      new THREE.Vector3(vx - tick, vy, zTop), new THREE.Vector3(vx + tick, vy, zTop),
    ];
    const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), dimLineMatAccent);
    line.renderOrder = 999;
    dimGroup.add(line);
    const spr = makeTextSprite(label, accent, labelSize, labelBg);
    if (tickAxis === "y") spr.position.set(vx, vy - 500, zTop / 2);
    else                  spr.position.set(vx - 500, vy, zTop / 2);
    spr.userData.dimAxis = axis;
    dimGroup.add(spr);
    dimLabels.push(spr);
  };

  if (roofType === 'gable') {
    if (ridgeAlongX) {
      makeVert(x0, (y0 + y1) / 2, kipZ, "kip", (kipZ / 1000).toFixed(2) + " m", "x");
      makeVert(x0, y0, eaveZ, "tagfod", (eaveZ / 1000).toFixed(2) + " m", "x");
    } else {
      makeVert((x0 + x1) / 2, y0, kipZ, "kip", (kipZ / 1000).toFixed(2) + " m", "y");
      makeVert(x0, y0, eaveZ, "tagfod", (eaveZ / 1000).toFixed(2) + " m", "y");
    }
  } else {
    // Flat: high/low edge heights at the building corners.
    if (ridgeAlongX) {
      makeVert(x0, anchorY === y0 ? y1 : y0, kipZ, "kip", (kipZ / 1000).toFixed(2) + " m", "x");
      makeVert(x0, anchorY,                  eaveZ, "tagfod", (eaveZ / 1000).toFixed(2) + " m", "x");
    } else {
      makeVert(anchorX === x0 ? x1 : x0, y0, kipZ, "kip", (kipZ / 1000).toFixed(2) + " m", "y");
      makeVert(anchorX,                  y0, eaveZ, "tagfod", (eaveZ / 1000).toFixed(2) + " m", "y");
    }
  }

  // Slope angle indicator at the low-edge corner — only if there's a slope.
  if (slopeRad > 1e-4) {
    const legLen = 1500;
    const anchor = new THREE.Vector3(anchorX, anchorY, eaveZ);
    // For ridge-along-X (gable) or flat with slope along Y: legs live in YZ
    // plane at x=anchorX. For ridge-along-Y or flat slope along X: legs live
    // in XZ plane at y=anchorY. The horizontal leg points toward the high
    // edge (for flat, that flips with the slope sign).
    let horizSign = 1;
    if (roofType === 'flat') {
      if (ridgeAlongX) horizSign = (anchorY === y0) ? 1 : -1;
      else             horizSign = (anchorX === x0) ? 1 : -1;
    }
    const horizAxis = ridgeAlongX ? new THREE.Vector3(0, horizSign, 0)
                                  : new THREE.Vector3(horizSign, 0, 0);
    const upAxis = new THREE.Vector3(0, 0, 1);
    const ptAt = (dh, dv) => anchor.clone().addScaledVector(horizAxis, dh).addScaledVector(upAxis, dv);

    const horizEnd = ptAt(legLen, 0);
    const slopeEnd = ptAt(legLen * Math.cos(slopeRad), legLen * Math.sin(slopeRad));

    const legPts = [anchor, horizEnd, anchor, slopeEnd];
    const legGeo = new THREE.BufferGeometry().setFromPoints(legPts);
    const legLine = new THREE.LineSegments(legGeo, dimLineMatAccent);
    legLine.renderOrder = 999;
    dimGroup.add(legLine);

    const arcR = legLen * 0.4;
    const arcSteps = 24;
    const arcPts = [];
    for (let i = 0; i <= arcSteps; i++) {
      const a = slopeRad * (i / arcSteps);
      arcPts.push(ptAt(arcR * Math.cos(a), arcR * Math.sin(a)));
    }
    const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
    const arcLine = new THREE.Line(arcGeo, dimLineMatAccent);
    arcLine.renderOrder = 999;
    dimGroup.add(arcLine);

    const labelR = legLen * 0.7;
    const labelA = slopeRad * 0.45;
    const labelPos = ptAt(labelR * Math.cos(labelA), labelR * Math.sin(labelA));
    const slopeSpr = makeTextSprite(slopeDeg.toFixed(1) + "°", accent, labelSize, labelBg);
    slopeSpr.position.copy(labelPos);
    slopeSpr.userData.dimAxis = "slope";
    dimGroup.add(slopeSpr);
    dimLabels.push(slopeSpr);
  }

  scene.add(dimGroup);
}

/* ────────────────── state ────────────────── */
const M = { P1: 1, P2: 2, SET: 3 };
let mode = M.P1;
let c1 = null, c2 = null;   // THREE.Vector3
let signX = 1, signY = 1;   // draw direction for input rebuild

let ghostGroup = null;
let roomGroup  = null;
let frameGroup = null;
// Cached frame mesh vertices (Vector3[]) — populated when /generate-frame returns
// so the measure tool can snap to every corner of every stud/plate/beam.
let frameVertices = [];

// Footprint mode: 'box' (two-corner rectangle) or 'free' (per-wall drawing)
let houseMode = 'box';

// Free-form footprint state
const footprintWalls = [];          // [{ x0, y0, x1, y1 }]
let footprintWallsDrawn = [];       // [{ x0, y0, x1, y1 }] — corner-adjusted, populated by buildFreeFormRoom. Used by wallInfo so openings line up with rendered walls.
let ffDrawStart = null;             // Vector3 of first click when drawing a wall
let ffGhostMesh = null;             // preview mesh
let ffPointerDown = null;           // {x,y} screen coords — click-vs-orbit
let selectedFF = -1;                // selected wall index
let ffShiftHeld = false;            // Shift = release ortho constraint
let ffHoverEnd = null;              // last computed end-point (for snap dot)

/* ────────────────── DOM ────────────────── */
const $ = id => document.getElementById(id);
const hint   = $("hint");
const panel  = $("panel");
const tip    = $("tip");
const btnUndo = $("btnUndo");
const btnRedo = $("btnRedo");
const btnNext  = $("btnNext");
// The old #leftPanel / #roofToolPanel have been folded into #leftBar. We still
// expose a `leftPanel` alias so legacy code paths that call
// leftPanel.classList.add/remove("open") keep working (the extra ".open" class
// on #leftBar is a harmless no-op).
const leftPanel = $("leftBar");
const roofPanel = $("roofPanel");

// Sync the unified left sidebar to the current step so the right buttons show.
function updateLeftBar() {
  const bar = $("leftBar");
  if (!bar) return;
  bar.dataset.currentStep = String(currentStep);
  const stepSection = $("leftBarStep");
  const hasStepContent = (currentStep === 2 || currentStep === 3);
  stepSection.classList.toggle("hidden", !hasStepContent);
}
const inW = $("inW"), inD = $("inD"), inH = $("inH"), inT = $("inT"), inTI = $("inTI"), inTR = $("inTR");
// Settings / Dev mode
const btnDev = $("btnDev"), devPanel = $("devPanel");
btnDev.addEventListener("click", () => {
  const open = devPanel.classList.toggle("open");
  btnDev.classList.toggle("active", open);
});
$("devModeCb").addEventListener("change", e => {
  $("devOptions").classList.toggle("open", e.target.checked);
  $("devBadge").classList.toggle("hidden", e.target.checked);
  $("tileFree").classList.toggle("locked", !e.target.checked);
  if (!e.target.checked) {
    // Leaving dev mode wipes any overlay state so the normal view returns.
    $("devOverlayCb").checked = false;
    window._devOverlay = false;
    syncOverlay();
    $("devAxisCb").checked = false;
    axisGizmoEnabled = false;
    $("axisGizmo").style.display = "none";
  }
});

// ── Admin mode ──
// Password-gated section of the settings panel. First unlock in this session
// shows a prompt; subsequent toggles skip the prompt and just hide/show the
// admin options. Admin state is NOT persisted across reloads — it's a
// session-scoped key, not a permission.
let adminUnlocked = false;
let materialFactor = 3.10;
let fabFactor = 1.00;
$("adminModeCb").addEventListener("change", e => {
  if (e.target.checked && !adminUnlocked) {
    const pw = prompt("Admin password");
    if (pw === "woodstock2026") {
      adminUnlocked = true;
    } else {
      e.target.checked = false;
      if (pw !== null) alert("Wrong password.");
      return;
    }
  }
  $("adminOptions").classList.toggle("open", e.target.checked);
});
$("materialFactor").addEventListener("input", e => {
  materialFactor = parseFloat(e.target.value);
  $("materialFactorVal").textContent = materialFactor.toFixed(2) + "×";
  if (window._lastFrameStats) applyPriceFactor(window._lastFrameStats);
});
$("fabFactor").addEventListener("input", e => {
  fabFactor = parseFloat(e.target.value);
  $("fabFactorVal").textContent = fabFactor.toFixed(2) + "×";
  if (window._lastFrameStats) applyPriceFactor(window._lastFrameStats);
});

// Indkøbspriser per meter (DKK). Server has the same table; client-side copy
// lets the admin slider update the price lines live without a regenerate.
const TIMBER_PRICE_PER_M = {
  "295x45": 48.00,
  "245x45": 36.00,
  "220x45": 32.00,
  "195x45": 27.00,
  "170x45": 24.50,
  "145x45": 21.00,
  "120x45": 18.95,
  "95x45": 14.00,
  "70x45": 11.00,
  "50x45": 7.00,
  "45x45": 7.00,
};
// Render the read-only indkøbspriser list into the admin panel at startup.
// Sections sort by the larger (first) dimension, descending — matches how
// the purchase-price sheet is usually read.
(function renderPriceTable() {
  const host = $("adminPriceTable");
  if (!host) return;
  const rows = Object.entries(TIMBER_PRICE_PER_M)
    .map(([section, rate]) => {
      const [a, b] = section.split("x").map(n => parseInt(n, 10));
      return { section, rate, size: Math.max(a, b) };
    })
    .sort((p, q) => q.size - p.size || q.rate - p.rate);
  const fmt = n => n.toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  host.innerHTML = rows.map(r =>
    `<div class="cut-row"><span class="cut-sec">${r.section}</span><span class="cut-len">${fmt(r.rate)}</span></div>`
  ).join("");
})();

/* ───────────────────────── Pricing ─────────────────────────
 * Single source of truth is the server's part_list. The three displayed
 * amounts are derived from it:
 *
 *   rawCost   = Σ  indkøbspris(section) × meters     (purchase cost)
 *   material  = rawCost × materialFactor             (admin slider, default 3.10)
 *   fabric.   = rawCost × fabFactor                  (admin slider, default 1.00)
 *   total     = material + fabrication
 *
 * Each factor scales rawCost independently — moving materialFactor does not
 * drag fabrication with it, and vice versa. The server mirrors this formula
 * so the persisted response is consistent; the client recomputes on every
 * slider change so the UI responds instantly without a regenerate.
 *
 * The price table TIMBER_PRICE_PER_M is duplicated on the server (app.py,
 * timber_price_per_m). Keep them in sync whenever you edit one.
 * ───────────────────────────────────────────────────────── */

// Look up a section's DKK/m rate, tolerating both "295x45" (canonical) and
// "45x295" (legacy prod). Unknown sections → volumetric fallback
// (~C24 at ~3350 DKK/m³), with a one-shot console warning per section.
function rateForSection(section) {
  if (!section) return 0;
  const parts = String(section).toLowerCase().split("x").map(n => parseInt(n, 10));
  if (parts.length !== 2 || parts.some(isNaN)) return 0;
  const bigger = Math.max(parts[0], parts[1]);
  const smaller = Math.min(parts[0], parts[1]);
  const key = `${bigger}x${smaller}`;
  const rate = TIMBER_PRICE_PER_M[key];
  if (rate != null) return rate;
  if (!rateForSection._warned) rateForSection._warned = new Set();
  if (!rateForSection._warned.has(key)) {
    rateForSection._warned.add(key);
    console.warn(`[pricing] no indkøbspris for ${key} — using volumetric fallback`);
  }
  return (bigger * smaller / 1e6) * 3350;
}

function rawTimberCost(partList) {
  if (!Array.isArray(partList)) return 0;
  let total = 0;
  for (const it of partList) {
    const meters = +it.meters;
    if (!Number.isFinite(meters) || meters <= 0) continue;
    total += rateForSection(it.section) * meters;
  }
  return Number.isFinite(total) ? total : 0;
}
// Back-compat alias for any older callers.
const timberCostFromPartList = rawTimberCost;

function formatDKK(n) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " kr";
}

function applyPriceFactor(stats) {
  const partList = stats && stats.part_list;
  const raw  = rawTimberCost(partList);
  const matF = Number.isFinite(materialFactor) ? materialFactor : 3.1;
  const fabF = Number.isFinite(fabFactor)      ? fabFactor      : 1.0;
  const material = raw * matF;
  const fab      = raw * fabF;
  const total    = material + fab;
  $("infoCostTimber").textContent = formatDKK(material);
  $("infoCostFab").textContent    = formatDKK(fab);
  $("infoPriceTotal").textContent = formatDKK(total);
}
// Single source of truth for design/frame group visibility. The base rule is
// "design groups live in steps 0–3, frame lives in 4–5"; dev overlay ORs the
// design groups back on in frame steps so the user can see both at once.
function syncOverlay() {
  const n = currentStep;
  const overlay = !!window._devOverlay;
  const inFrame = (n >= 4);
  if (roomGroup)     roomGroup.visible     = (n <= 3)              || (overlay && inFrame);
  if (frameGroup)    frameGroup.visible    = inFrame;
  openingsGroup.visible                     = (n >= 2 && n <= 3)    || (overlay && inFrame);
  // Interior walls stay visible from step 0 onward so the user can see how
  // their design is developing while editing the exterior shell.
  iwGroup.visible                           = (n <= 3)               || (overlay && inFrame);
  if (roofGroup)     roofGroup.visible     = (n === 3)              || (overlay && inFrame);
}
$("devOverlayCb").addEventListener("change", e => {
  window._devOverlay = e.target.checked;
  syncOverlay();
});

// World-axis gizmo: projects each world axis direction into view space every
// frame so the user can always tell which way +X/+Y/+Z is pointing.
let axisGizmoEnabled = false;
const _axisVec = new THREE.Vector3();
function updateAxisGizmo() {
  if (!axisGizmoEnabled) return;
  const LEN = 35;  // svg units
  const axes = [
    { vec: [1, 0, 0], line: "axisLineX", label: "axisLabelX" },
    { vec: [0, 1, 0], line: "axisLineY", label: "axisLabelY" },
    { vec: [0, 0, 1], line: "axisLineZ", label: "axisLabelZ" },
  ];
  for (const a of axes) {
    _axisVec.set(a.vec[0], a.vec[1], a.vec[2]);
    _axisVec.transformDirection(cam.matrixWorldInverse);
    const x =  _axisVec.x * LEN;
    const y = -_axisVec.y * LEN;   // SVG y is flipped
    const ln = $(a.line);
    ln.setAttribute("x2", x.toFixed(1));
    ln.setAttribute("y2", y.toFixed(1));
    const lbl = $(a.label);
    lbl.setAttribute("x", (x + 2 * Math.sign(x || 1)).toFixed(1));
    lbl.setAttribute("y", (y + 4 * Math.sign(y || 1)).toFixed(1));
  }
}
$("devAxisCb").addEventListener("change", e => {
  axisGizmoEnabled = e.target.checked;
  $("axisGizmo").style.display = axisGizmoEnabled ? "block" : "none";
  if (axisGizmoEnabled) updateAxisGizmo();
});
$("devOpacity").addEventListener("input", e => {
  const v = +e.target.value;
  $("devOpacityVal").textContent = v + "%";
  const op = v / 100;
  const mats = [wallMat, iwMat, floorMat, roofMat];
  for (const m of mats) {
    m.transparent = op < 1;
    m.opacity = op;
    m.depthWrite = op >= 1;
    m.needsUpdate = true;
  }
});

$("devClipCb").addEventListener("change", e => {
  const on = e.target.checked;
  const slider = $("devClipSlider");
  slider.disabled = !on;
  slider.style.opacity = on ? "1" : "0.35";
  const h = +slider.value;
  $("devClipVal").textContent = on ? (h / 1000).toFixed(2) + " m" : "off";
  scene.traverse(o => { if (o.isMesh) o.material.clippingPlanes = on ? [clipPlane] : []; });
});

$("devClipSlider").addEventListener("input", e => {
  const h = +e.target.value;
  clipPlane.constant = h;
  $("devClipVal").textContent = (h / 1000).toFixed(2) + " m";
});

// ── Frame edge overlay ──
// Preview-only faint black outline on frame member corners. Parented to the
// frame mesh (created in rebuildFrameEdges after /generate-frame returns).
// Server emits crease edges straight from the Brep topology, so we no longer
// depend on EdgesGeometry (which sprayed triangulation artifacts across
// boolean-cut window-adjacent members). The EdgesGeometry branch is kept as
// a fallback for any response that predates the crease_edges field.
const FRAME_EDGE_THRESHOLD = 20;
const frameEdgeMat = new THREE.LineBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0.20,
});
let frameEdgesMesh = null;

function rebuildFrameEdges(creaseSegments) {
  if (!frameGroup) return;
  const mesh = frameGroup.children.find(c => c.geometry && c.isMesh);
  if (!mesh) return;
  if (frameEdgesMesh) {
    mesh.remove(frameEdgesMesh);
    frameEdgesMesh.geometry.dispose();
    frameEdgesMesh = null;
  }

  let geo;
  if (Array.isArray(creaseSegments) && creaseSegments.length) {
    const verts = new Float32Array(creaseSegments.length * 6);
    for (let i = 0; i < creaseSegments.length; i++) {
      const [a, b] = creaseSegments[i];
      verts[i * 6]     = a[0]; verts[i * 6 + 1] = a[1]; verts[i * 6 + 2] = a[2];
      verts[i * 6 + 3] = b[0]; verts[i * 6 + 4] = b[1]; verts[i * 6 + 5] = b[2];
    }
    geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  } else {
    geo = new THREE.EdgesGeometry(mesh.geometry, FRAME_EDGE_THRESHOLD);
  }
  frameEdgesMesh = new THREE.LineSegments(geo, frameEdgeMat);
  mesh.add(frameEdgesMesh);
}

/* ────────── Test Mode: comment + annotate ────────── */
const btnAddComment  = $("btnAddComment");
const annotateCanvas = $("annotateCanvas");
const commentPanel   = $("commentPanel");
const commentText    = $("commentText");
const commentToast   = $("commentToast");
let annotateCtx = null;
let annotating = false;
let annotateDrawing = false;
let annotateHasStrokes = false;
let annotatePrev = { x: 0, y: 0 };

$("testModeCb").addEventListener("change", e => {
  window._testMode = e.target.checked;
  btnAddComment.classList.toggle("visible", e.target.checked && !annotating);
});
// Honor the default-checked state on load (change event doesn't fire for
// initial HTML `checked`).
window._testMode = $("testModeCb").checked;
if (window._testMode) btnAddComment.classList.add("visible");

function sizeAnnotateCanvas() {
  const dpr = Math.min(devicePixelRatio, 2);
  annotateCanvas.width  = Math.round(window.innerWidth  * dpr);
  annotateCanvas.height = Math.round(window.innerHeight * dpr);
  annotateCanvas.style.width  = window.innerWidth  + "px";
  annotateCanvas.style.height = window.innerHeight + "px";
  annotateCtx = annotateCanvas.getContext("2d");
  annotateCtx.scale(dpr, dpr);
  annotateCtx.strokeStyle = "#E53935";
  annotateCtx.lineWidth = 3.5;
  annotateCtx.lineCap = "round";
  annotateCtx.lineJoin = "round";
}

function enterAnnotation() {
  annotating = true;
  annotateHasStrokes = false;
  sizeAnnotateCanvas();
  annotateCanvas.classList.add("active");
  commentPanel.classList.add("open");
  btnAddComment.classList.remove("visible");
  orbit.enabled = false;
  // Freeze any in-flight drag state that might otherwise re-engage
  if (typeof dragging !== "undefined") dragging = null;
}

function exitAnnotation() {
  annotating = false;
  if (annotateCtx) {
    // Clear is a no-op on unscaled dims; use the raw canvas size
    annotateCtx.setTransform(1, 0, 0, 1, 0, 0);
    annotateCtx.clearRect(0, 0, annotateCanvas.width, annotateCanvas.height);
  }
  annotateCanvas.classList.remove("active");
  commentPanel.classList.remove("open");
  commentText.value = "";
  annotateHasStrokes = false;
  orbit.enabled = true;
  if (window._testMode) btnAddComment.classList.add("visible");
}

function showToast(msg) {
  commentToast.textContent = msg;
  commentToast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => commentToast.classList.remove("show"), 2400);
}

btnAddComment.addEventListener("click", enterAnnotation);
$("btnCancelComment").addEventListener("click", exitAnnotation);
$("btnClearDraw").addEventListener("click", () => {
  if (!annotateCtx) return;
  annotateCtx.setTransform(1, 0, 0, 1, 0, 0);
  annotateCtx.clearRect(0, 0, annotateCanvas.width, annotateCanvas.height);
  const dpr = Math.min(devicePixelRatio, 2);
  annotateCtx.scale(dpr, dpr);
  annotateCtx.strokeStyle = "#E53935";
  annotateCtx.lineWidth = 3.5;
  annotateCtx.lineCap = "round";
  annotateCtx.lineJoin = "round";
  annotateHasStrokes = false;
});

annotateCanvas.addEventListener("pointerdown", e => {
  if (!annotating) return;
  annotateDrawing = true;
  annotatePrev.x = e.clientX;
  annotatePrev.y = e.clientY;
  annotateCanvas.setPointerCapture(e.pointerId);
  // Dot for single-tap
  annotateCtx.beginPath();
  annotateCtx.arc(e.clientX, e.clientY, 2, 0, Math.PI * 2);
  annotateCtx.fillStyle = "#E53935";
  annotateCtx.fill();
  annotateHasStrokes = true;
});
annotateCanvas.addEventListener("pointermove", e => {
  if (!annotating || !annotateDrawing) return;
  annotateCtx.beginPath();
  annotateCtx.moveTo(annotatePrev.x, annotatePrev.y);
  annotateCtx.lineTo(e.clientX, e.clientY);
  annotateCtx.stroke();
  annotatePrev.x = e.clientX;
  annotatePrev.y = e.clientY;
  annotateHasStrokes = true;
});
annotateCanvas.addEventListener("pointerup", e => {
  annotateDrawing = false;
  try { annotateCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
});
annotateCanvas.addEventListener("pointercancel", () => { annotateDrawing = false; });

window.addEventListener("resize", () => {
  if (!annotating) return;
  // Preserve existing strokes on resize
  const prev = document.createElement("canvas");
  prev.width = annotateCanvas.width;
  prev.height = annotateCanvas.height;
  prev.getContext("2d").drawImage(annotateCanvas, 0, 0);
  sizeAnnotateCanvas();
  annotateCtx.setTransform(1, 0, 0, 1, 0, 0);
  annotateCtx.drawImage(prev, 0, 0, annotateCanvas.width, annotateCanvas.height);
  const dpr = Math.min(devicePixelRatio, 2);
  annotateCtx.scale(dpr, dpr);
});

$("btnSendComment").addEventListener("click", async () => {
  const text = (commentText.value || "").trim();
  if (!text && !annotateHasStrokes) {
    showToast("Write something or draw on the scene first.");
    return;
  }
  const sendBtn = $("btnSendComment");
  sendBtn.disabled = true;
  sendBtn.textContent = "Sending…";
  try {
    // Force a fresh render so toDataURL captures current pixels.
    renderer.render(scene, cam);
    const webgl = renderer.domElement;
    const composite = document.createElement("canvas");
    composite.width = webgl.width;
    composite.height = webgl.height;
    const cctx = composite.getContext("2d");
    cctx.drawImage(webgl, 0, 0);
    cctx.drawImage(annotateCanvas, 0, 0, composite.width, composite.height);
    const imageDataUrl = composite.toDataURL("image/png");

    const state = {
      step: currentStep,
      houseMode: (typeof houseMode !== "undefined") ? houseMode : null,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };

    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, image: imageDataUrl, state }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      showToast("Send failed: " + (json.error || res.status));
      return;
    }
    exitAnnotation();
    showToast("Thanks! Feedback sent.");
  } catch (err) {
    showToast("Send failed: " + err.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
});

const stepEls = [$("step0"), $("step1"), $("step2"), $("step3"), $("step4"), $("step5")];
const infoPanel = $("infoPanel");
const NEXT_LABELS = ["Walls \u2192", "Openings \u2192", "Roof \u2192", "Generate \u2192", "Buy \u2192"];

let currentStep = 0;
let activeTool = null;       // "window" | "door" | null
let isTopView = false;
let savedCamState = null;    // { pos, target } to restore on toggle off
const stepVisited = [false, false, false, false, false, false];  // track first visit per tab

// Intro hints shown centered on first visit to each tab
const stepIntroHints = [
  "Click to place your house",
  "Click inside to draw interior walls • Click a wall to edit",
  "Drag windows and doors onto walls \u2022 click to edit",
  "Pick a roof style for your house",
  "Generate the timber frame",
  "Review and purchase your frame"
];
let roofType = "none";       // "none" | "flat" | "gable" — default is walls-only

// Frame cache state: design mutations flip frameStale=true and relabel the
// step-4 tab "Generate". After a successful generate the cached frameGroup is
// reused (tab reads "Frame") until something changes.
let frameStale = true;
function markFrameStale() {
  if (frameStale) return;
  frameStale = true;
  const lab = $("step4");
  if (lab) lab.innerHTML = '<span class="step-num">5</span> Generate';
}
function markFrameFresh() {
  frameStale = false;
  const lab = $("step4");
  if (lab) lab.innerHTML = '<span class="step-num">5</span> Frame';
}

const openings = [];         // { type, wallIdx, posAlong, mesh }
let openingsGroup = new THREE.Group();
scene.add(openingsGroup);
let roofGroup = null;

// Scale-reference figure standing to the east of the house (1.8 m tall,
// billboarded around world Z so he always stays upright and yaws to face the camera).
let scaleWorker = null;        // parent Group — positioned and z-rotated each frame
let scaleWorkerMesh = null;    // child Plane mesh — raycast target
let scaleWorkerDismissed = false;
let scaleWorkerWalking = null; // { t0, duration, fromX, fromY, dx, dy } while walking off-screen
let scaleWorkerDesired = null; // {x,y} target corner position, updated when dimensions change
let scaleWorkerRestage = null; // { phase: 'fadeOut'|'fadeIn', t0, toX?, toY? } — cross-fade between positions
const WORKER_BASE_OPACITY = 0.85;
const WORKER_RESTAGE_MS = 280;
(function makeScaleWorker() {
  const tex = new THREE.TextureLoader().load('/static/assets/scale_worker.png');
  if ('SRGBColorSpace' in THREE) tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, alphaTest: 0.5, opacity: 0.85, side: THREE.DoubleSide,
  });
  const H = 1800;                        // 1.8 m in mm
  const W = H * (1792 / 2358);           // preserve PNG aspect
  const geo = new THREE.PlaneGeometry(W, H);
  geo.translate(0, H / 2, 0);            // origin at bottom-center → feet on group's ground plane
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;         // stand plane upright: local +Y → world +Z
  mesh.userData.isScaleWorker = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.visible = false;
  scene.add(group);
  scaleWorker = group;
  scaleWorkerMesh = mesh;
})();

function scaleWorkerShouldShow() {
  if (isTopView) return false;
  if (scaleWorkerWalking) return true;   // keep him visible during the walk-off
  if (scaleWorkerDismissed) return false;
  if (houseMode === 'box') return !!(c1 && c2);
  if (houseMode === 'free') return footprintWalls.length > 0;
  return false;
}

function isWorkerDragActive() {
  return !!(dragging || draggingRidge || draggingSlopeEdge >= 0 || draggingHeight || draggingSlide >= 0 || draggingRoofOH);
}

function positionScaleWorker() {
  if (!scaleWorker) return;
  if (scaleWorkerWalking) return;        // don't clobber the walk-off tween
  // Stand just off the (xMax, yMax) corner, diagonally outward so he clears
  // the wall thickness / any roof overhang. Nudged +500 mm in X.
  const gapX = 1000;
  const gapY = 500;
  let desired = null;
  if (houseMode === 'box' && c1 && c2) {
    const xMax = Math.max(c1.x, c2.x);
    const yMax = Math.max(c1.y, c2.y);
    desired = { x: xMax + gapX, y: yMax + gapY };
  } else if (houseMode === 'free' && footprintWalls.length) {
    let xMax = -Infinity, yMax = -Infinity;
    for (const w of footprintWalls) {
      xMax = Math.max(xMax, w.x0, w.x1);
      yMax = Math.max(yMax, w.y0, w.y1);
    }
    desired = { x: xMax + gapX, y: yMax + gapY };
  }
  if (!desired) return;
  scaleWorkerDesired = desired;
  // First-ever placement: teleport instantly (no fade).
  if (scaleWorker.position.x === 0 && scaleWorker.position.y === 0) {
    scaleWorker.position.set(desired.x, desired.y, 0);
  }
}

function tickScaleWorkerRestage() {
  if (!scaleWorker || !scaleWorkerMesh) return;
  if (scaleWorkerWalking) return;
  const mat = scaleWorkerMesh.material;

  // No tween active — check whether we need to start one (only when no drag in progress).
  if (!scaleWorkerRestage) {
    if (mat.opacity !== WORKER_BASE_OPACITY) mat.opacity = WORKER_BASE_OPACITY;
    if (isWorkerDragActive() || !scaleWorkerDesired) return;
    const dx = scaleWorkerDesired.x - scaleWorker.position.x;
    const dy = scaleWorkerDesired.y - scaleWorker.position.y;
    if (dx * dx + dy * dy > 1) {
      scaleWorkerRestage = {
        phase: 'fadeOut',
        t0: performance.now(),
        toX: scaleWorkerDesired.x,
        toY: scaleWorkerDesired.y,
      };
    } else {
      return;
    }
  }

  const now = performance.now();
  const t = Math.min(1, (now - scaleWorkerRestage.t0) / WORKER_RESTAGE_MS);
  if (scaleWorkerRestage.phase === 'fadeOut') {
    mat.opacity = WORKER_BASE_OPACITY * (1 - t);
    if (t >= 1) {
      scaleWorker.position.x = scaleWorkerRestage.toX;
      scaleWorker.position.y = scaleWorkerRestage.toY;
      scaleWorkerRestage = { phase: 'fadeIn', t0: performance.now() };
      mat.opacity = 0;
    }
  } else {
    mat.opacity = WORKER_BASE_OPACITY * t;
    if (t >= 1) {
      mat.opacity = WORKER_BASE_OPACITY;
      scaleWorkerRestage = null;
    }
  }
}

function updateScaleWorkerPill() {
  const pill = document.getElementById('scaleWorkerPill');
  if (!pill) return;
  if (!pill.classList.contains('open') || !scaleWorker || !scaleWorker.visible) {
    pill.classList.remove('open');
    return;
  }
  // Anchor ~0.2 m above head (H = 1800, mesh origin at bottom).
  const wp = new THREE.Vector3(scaleWorker.position.x, scaleWorker.position.y, 2000);
  wp.project(cam);
  const r = renderer.domElement.getBoundingClientRect();
  const sx = (wp.x * 0.5 + 0.5) * r.width + r.left;
  const sy = (-wp.y * 0.5 + 0.5) * r.height + r.top;
  const pw = pill.offsetWidth || 120;
  const ph = pill.offsetHeight || 36;
  let px = sx - pw / 2;
  let py = sy - ph - 8;
  px = Math.max(10, Math.min(px, window.innerWidth - pw - 10));
  py = Math.max(10, Math.min(py, window.innerHeight - ph - 10));
  pill.style.left = px + 'px';
  pill.style.top = py + 'px';
}

function dismissScaleWorker() {
  if (!scaleWorker || scaleWorkerWalking) return;
  const pill = document.getElementById('scaleWorkerPill');
  if (pill) pill.classList.remove('open');
  // Walk off toward the camera's right on the ground plane until he's out of view.
  const look = new THREE.Vector3();
  cam.getWorldDirection(look);
  const right = new THREE.Vector3(look.y, -look.x, 0);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const dist = 30000;                    // 30 m — safely off-screen at any zoom
  scaleWorkerWalking = {
    t0: performance.now(),
    duration: 1800,
    fromX: scaleWorker.position.x,
    fromY: scaleWorker.position.y,
    dx: right.x * dist,
    dy: right.y * dist,
  };
}

function tickScaleWorkerWalk() {
  if (!scaleWorkerWalking || !scaleWorker) return;
  const w = scaleWorkerWalking;
  const t = Math.min(1, (performance.now() - w.t0) / w.duration);
  scaleWorker.position.x = w.fromX + w.dx * t;
  scaleWorker.position.y = w.fromY + w.dy * t;
  if (t >= 1) {
    scaleWorkerWalking = null;
    // Walk-IN leaves him staged at the corner; walk-OUT sends him away.
    scaleWorkerDismissed = !w.swoopIn;
  }
}

// ── Worker speech bubble + 180-spin + swoop-back ──
// A one-shot reaction sequence: if he walked off he swoops back, pivots 180°
// around his vertical (Z) axis, and a speech bubble pops over his head for a
// few seconds before he pivots back. Used by not-yet-implemented buttons
// like Buy Frame.
let workerSpinOffset = 0;       // radians, added onto the billboard yaw
let workerSpinTween = null;     // { t0, duration, from, to, hold }
let workerSpeechTimer = null;

function swoopInScaleWorker() {
  if (!scaleWorker) return;
  // Make sure positionScaleWorker has computed a desired corner (it normally
  // gets called from rebuildScene, but might be stale if the house changed).
  positionScaleWorker();
  if (!scaleWorkerDesired) return;
  // Compute a start point far out past the camera-right so he slides in.
  const look = new THREE.Vector3();
  cam.getWorldDirection(look);
  const right = new THREE.Vector3(look.y, -look.x, 0);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const dist = 30000;
  const fromX = scaleWorkerDesired.x + right.x * dist;
  const fromY = scaleWorkerDesired.y + right.y * dist;
  scaleWorkerDismissed = false;
  scaleWorkerWalking = {
    t0: performance.now(),
    duration: 900,
    fromX, fromY,
    dx: scaleWorkerDesired.x - fromX,
    dy: scaleWorkerDesired.y - fromY,
    swoopIn: true,
  };
  // Stage him at the start so he's visible while walking in.
  scaleWorker.position.set(fromX, fromY, 0);
  scaleWorker.visible = true;
  if (scaleWorkerMesh) scaleWorkerMesh.material.opacity = WORKER_BASE_OPACITY;
}

function spinScaleWorker180() {
  // Snap to π (half turn) quickly, hold there while the speech is up, then
  // snap back. All three phases happen inside the same tween so we don't have
  // to chain timers.
  workerSpinTween = {
    t0: performance.now(),
    outDuration: 350,
    hold: 2200,
    backDuration: 350,
  };
}

function tickWorkerSpin() {
  if (!workerSpinTween) { workerSpinOffset = 0; return; }
  const w = workerSpinTween;
  const el = performance.now() - w.t0;
  const ease = x => x < 0.5 ? 2*x*x : 1 - Math.pow(-2*x + 2, 2) / 2;
  if (el < w.outDuration) {
    workerSpinOffset = Math.PI * ease(el / w.outDuration);
  } else if (el < w.outDuration + w.hold) {
    workerSpinOffset = Math.PI;
  } else if (el < w.outDuration + w.hold + w.backDuration) {
    const p = (el - w.outDuration - w.hold) / w.backDuration;
    workerSpinOffset = Math.PI * (1 - ease(p));
  } else {
    workerSpinOffset = 0;
    workerSpinTween = null;
  }
}

function showWorkerSpeech(msg, durationMs) {
  const el = $("scaleWorkerSpeech");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("open");
  // Restart the entry animation on every show.
  el.style.animation = "none";
  void el.offsetWidth;       // force reflow
  el.style.animation = "";
  clearTimeout(workerSpeechTimer);
  workerSpeechTimer = setTimeout(() => { el.classList.remove("open"); }, durationMs || 2900);
}

function updateScaleWorkerSpeechPosition() {
  const el = $("scaleWorkerSpeech");
  if (!el || !el.classList.contains("open")) return;
  if (!scaleWorker) return;
  const wp = new THREE.Vector3(scaleWorker.position.x, scaleWorker.position.y, 2200);
  wp.project(cam);
  const r = renderer.domElement.getBoundingClientRect();
  const sx = (wp.x * 0.5 + 0.5) * r.width + r.left;
  const sy = (-wp.y * 0.5 + 0.5) * r.height + r.top;
  const pw = el.offsetWidth || 180;
  const ph = el.offsetHeight || 48;
  let px = sx - pw / 2;
  let py = sy - ph - 14;
  px = Math.max(10, Math.min(px, window.innerWidth - pw - 10));
  py = Math.max(10, Math.min(py, window.innerHeight - ph - 10));
  el.style.left = px + "px";
  el.style.top = py + "px";
}

function workerSay(msg) {
  // If he's offstage, swoop him back first and delay the reaction until he
  // arrives — the speech bubble + spin landing on an empty corner felt weird.
  const needsSwoop = scaleWorkerDismissed || (scaleWorkerWalking && !scaleWorkerWalking.swoopIn);
  if (needsSwoop) {
    swoopInScaleWorker();
    setTimeout(() => {
      spinScaleWorker180();
      showWorkerSpeech(msg, 2900);
    }, 1000);
    return;
  }
  positionScaleWorker();     // ensure he's at his corner
  scaleWorker.visible = true;
  spinScaleWorker180();
  showWorkerSpeech(msg, 2900);
}

// Interior walls
const interiorWalls = [];    // { x0, y0, x1, y1 } — centerline endpoints, orthogonal
let iwToRidge = false;       // true = interior walls extend to underside of gable roof
const iwGroup = new THREE.Group();
scene.add(iwGroup);
let iwDrawStart = null;      // Vector3 — first click point
let iwGhostMesh = null;      // ghost preview during draw
let selectedIW = -1;         // selected interior wall index
let iwPointerDown = null;    // {x,y} screen coords — distinguish click from orbit drag

function setStep(n) {
  stepEls.forEach((s, i) => {
    s.classList.remove("active", "done");
    if (i < n) s.classList.add("done");
    else if (i === n) s.classList.add("active");
  });
}

/* ────────────────── ground raycast ────────────────── */
const rc = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const gp = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function groundHit(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);
  const pt = new THREE.Vector3();
  return rc.ray.intersectPlane(gp, pt) ? pt : null;
}

const SNAP = 500;  // matches grid lines (30000 / 60)
function snap(v) { return Math.round(v / SNAP) * SNAP; }

/* ────────────────── build walls + floor ────────────────── */
/*
 * Parametric chain (user's design model):
 *   1. Outer rectangle (footprint) defines everything
 *   2. Roof = flat surface(s) at outer boundary
 *   3. Walls = outer rect extruded up to meet roof edge
 *   4. Thicken roof downward  → slab
 *   5. Thicken gable walls inward  → narrows long-wall span
 *   6. Thicken long walls inward   → final interior
 *
 * Wall indices: 0=south, 1=north, 2=west, 3=east
 * Ridge runs along the longer axis (ridgeAlongX when w >= d).
 * Gable walls are perpendicular to the ridge.
 */

/* ── Wall geometry (unified: flat / sloped / gabled, with opening holes) ──
 *
 * Each wall has:
 *   from, to       outer-face endpoints in world XY (ground level)
 *   outward        unit outward normal (world XY)
 *   topPoints      [[u, y], ...] where u ∈ [0,1] along the wall, y = world height
 *   idx            0=S, 1=N, 2=W, 3=E
 *
 * We build a 2D polygon in face space (x=u·wallLen, y=height), punch opening
 * holes, then extrude by thickness t and orient into the world via a basis
 * matrix (uDir, up, inward). No rotation hacks, no per-shape positioning logic.
 */

// Canonical world position of an opening, from wallInfo's (origin + along·posAlong).
// Used so the opening follows the wall regardless of how the wall is shortened
// for corner handling — we project that world point onto each wall's face.
function openingWorldPos(wallIdx, posAlong) {
  const info = wallInfo(wallIdx);
  if (!info) return null;
  return new THREE.Vector3(
    info.origin.x + info.along.x * posAlong,
    info.origin.y + info.along.y * posAlong,
    0
  );
}

function buildWallMesh(spec, t, wMat, eMat, wallCutouts) {
  const fromV = new THREE.Vector3(spec.from[0], spec.from[1], 0);
  const toV = new THREE.Vector3(spec.to[0], spec.to[1], 0);
  const wallLen = fromV.distanceTo(toV);
  if (wallLen < 1) return [];

  const uDir = toV.clone().sub(fromV).normalize();
  const inward = new THREE.Vector3(-spec.outward[0], -spec.outward[1], 0);
  const up = new THREE.Vector3(0, 0, 1);

  // Build face polygon: bottom corners, then top profile reversed
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(wallLen, 0);
  for (let i = spec.topPoints.length - 1; i >= 0; i--) {
    const [u, y] = spec.topPoints[i];
    shape.lineTo(u * wallLen, y);
  }
  shape.closePath();

  // Wall top height (for clamping holes so they never pierce the top profile)
  const wallTopAt = (x) => {
    const u = x / wallLen;
    const tp = spec.topPoints;
    for (let i = 0; i < tp.length - 1; i++) {
      const [u0, y0] = tp[i], [u1, y1] = tp[i + 1];
      if (u >= u0 && u <= u1) {
        const t2 = (u1 === u0) ? 0 : (u - u0) / (u1 - u0);
        return y0 + (y1 - y0) * t2;
      }
    }
    return tp[tp.length - 1][1];
  };

  // Holes — openings on this wall, projected into face space
  const ops = (wallCutouts || []).filter(o => o.wallIdx === spec.idx);
  for (const op of ops) {
    const wp = openingWorldPos(op.wallIdx, op.posAlong);
    if (!wp) continue;
    const localX = wp.sub(fromV).dot(uDir);
    const halfW = op.width / 2;
    const left = localX - halfW;
    const right = localX + halfW;
    if (right <= 0 || left >= wallLen) continue;  // entirely outside wall

    const bot = op.type === "window" ? op.sill : 0;
    const desiredTop = bot + op.height;
    // Clamp to wall top profile (use the lower of the two end heights as a safe bound)
    const topBound = Math.min(wallTopAt(Math.max(0, left)), wallTopAt(Math.min(wallLen, right)));
    const top = Math.min(desiredTop, topBound - 50);
    if (top <= bot) continue;

    const cLeft = Math.max(0, left);
    const cRight = Math.min(wallLen, right);

    const hole = new THREE.Path();
    hole.moveTo(cLeft, bot);
    hole.lineTo(cRight, bot);
    hole.lineTo(cRight, top);
    hole.lineTo(cLeft, top);
    hole.closePath();
    shape.holes.push(hole);
  }

  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });

  // Orient: local (X=along, Y=up, Z=inward) → world
  const m = new THREE.Matrix4().makeBasis(uDir, up, inward);
  m.setPosition(fromV);

  const mesh = new THREE.Mesh(geo, wMat);
  mesh.applyMatrix4(m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.isWall = true;
  mesh.userData.wallIdx = spec.idx;

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), eMat);
  edges.applyMatrix4(m);

  return [mesh, edges];
}

function buildRoom(a, b, h, t, wMat, eMat, fMat, wallCutouts) {
  const g = new THREE.Group();

  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const w = x1 - x0, d = y1 - y0;

  const isGable = roofType === "gable";
  const ridgeH = isGable ? getRidgeH() : 0;
  const ridgeAlongX = w >= d;
  const isFlatSloped = roofType === "flat" && (flatSlopeH[0] !== 0 || flatSlopeH[1] !== 0);
  const e0h = h + flatSlopeH[0], e1h = h + flatSlopeH[1];

  // Pentagon eave lift: lift the gable so the roof's BOTTOM plane passes through
  // the inner-top corner of the long walls. s = roofT - ridgeH*t/halfSpan.
  const gableEaveLift = isGable ? ((+inTR.value) - ridgeH * t / (ridgeAlongX ? d / 2 : w / 2)) : 0;

  // Wall specs: "perp" walls own the corners (full length, sloped/gabled top);
  // "long" walls are inset by t on each end (flat top).
  //   ridgeAlongX  → perp = W,E (slope runs along Y or gable spans Y)
  //   ridgeAlongY  → perp = S,N
  const specs = [];
  const flat = (hVal) => [[0, hVal], [1, hVal]];
  const gableProfile = [[0, h + gableEaveLift], [0.5, h + ridgeH + gableEaveLift], [1, h + gableEaveLift]];

  if (ridgeAlongX) {
    // Long S/N: inset by t, flat top at eave height (or edge height for sloped flat)
    const sh = isFlatSloped ? e0h : h;
    const nh = isFlatSloped ? e1h : h;
    specs.push(
      { idx: 0, from: [x0 + t, y0],       to: [x1 - t, y0],       outward: [0, -1], topPoints: flat(sh) },
      { idx: 1, from: [x1 - t, y1],       to: [x0 + t, y1],       outward: [0,  1], topPoints: flat(nh) },
    );
    // Perp W/E: full depth, sloped/gabled top
    let wTop, eTop;
    if (isGable)          { wTop = gableProfile;            eTop = gableProfile; }
    else if (isFlatSloped){ wTop = [[0, e1h], [1, e0h]];    eTop = [[0, e0h], [1, e1h]]; }
    else                  { wTop = flat(h);                 eTop = flat(h); }
    specs.push(
      { idx: 2, from: [x0, y1], to: [x0, y0], outward: [-1, 0], topPoints: wTop },
      { idx: 3, from: [x1, y0], to: [x1, y1], outward: [ 1, 0], topPoints: eTop },
    );
  } else {
    // Perp S/N: full width, sloped/gabled top
    let sTop, nTop;
    if (isGable)           { sTop = gableProfile;            nTop = gableProfile; }
    else if (isFlatSloped) { sTop = [[0, e0h], [1, e1h]];    nTop = [[0, e1h], [1, e0h]]; }
    else                   { sTop = flat(h);                 nTop = flat(h); }
    specs.push(
      { idx: 0, from: [x0, y0], to: [x1, y0], outward: [0, -1], topPoints: sTop },
      { idx: 1, from: [x1, y1], to: [x0, y1], outward: [0,  1], topPoints: nTop },
    );
    // Long W/E: inset, flat top at edge height
    const wh = isFlatSloped ? e0h : h;
    const eh = isFlatSloped ? e1h : h;
    specs.push(
      { idx: 2, from: [x0, y1 - t], to: [x0, y0 + t], outward: [-1, 0], topPoints: flat(wh) },
      { idx: 3, from: [x1, y0 + t], to: [x1, y1 - t], outward: [ 1, 0], topPoints: flat(eh) },
    );
  }

  for (const spec of specs) {
    const items = buildWallMesh(spec, t, wMat, eMat, wallCutouts);
    for (const it of items) g.add(it);
  }

  // Floor
  const fw = w - 2 * t, fd = d - 2 * t;
  if (fw > 0 && fd > 0) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), fMat);
    // Preview only — lifted 10 cm off z=0 to avoid z-fighting with the world
    // grid helper on the ground plane. Backend geometry is untouched.
    floor.position.set(x0 + w / 2, y0 + d / 2, 100);
    floor.receiveShadow = true;
    g.add(floor);
  }

  return g;
}

/* ────────────────── place / preview ────────────────── */
function showGhost(a, b) {
  if (ghostGroup) scene.remove(ghostGroup);
  ghostGroup = buildRoom(a, b, +inH.value, +inT.value, ghostMat, ghostEdge, ghostFloor);
  scene.add(ghostGroup);
}

function placeRoom() {
  if (ghostGroup) { scene.remove(ghostGroup); ghostGroup = null; }
  if (roomGroup)  { scene.remove(roomGroup);  roomGroup = null; }

  roomGroup = buildRoom(c1, c2, +inH.value, +inT.value, wallMat, edgeMat, floorMat);
  scene.add(roomGroup);
  positionArrows();
  updateDims();
  positionScaleWorker();

  // Sync dimension inputs
  inW.value = Math.round(Math.abs(c2.x - c1.x));
  inD.value = Math.round(Math.abs(c2.y - c1.y));
}

/* ── Central rebuild: single source of truth for all geometry updates ── */
function rebuildScene() {
  if (roomGroup) { scene.remove(roomGroup); roomGroup = null; }

  if (houseMode === 'free') {
    roomGroup = buildFreeFormRoom(footprintWalls, +inH.value, +inT.value, wallMat, edgeMat);
    scene.add(roomGroup);
    rebuildFFEndpointMarkers();
    rebuildOpenings();
    rebuildInteriorWalls();
    positionScaleWorker();
    return;
  }

  if (!c1 || !c2) return;
  roomGroup = buildRoom(c1, c2, +inH.value, +inT.value, wallMat, edgeMat, floorMat, openings);
  scene.add(roomGroup);
  if (currentStep >= 3) buildRoof();
  else if (roofGroup) { scene.remove(roofGroup); roofGroup = null; }
  if (currentStep === 0) positionArrows();
  positionRoofArrows();
  if (currentStep === 0) updateDims();
  else if (currentStep === 3 && (roofType === 'gable' || roofType === 'flat')) showRoofDims();
  else hideDims();
  rebuildOpenings();
  rebuildInteriorWalls();
  positionScaleWorker();
  updateSpecMesh();
}

let fitTweenRAF = 0;
function tweenCamera(toPos, toTarget, durationMs) {
  if (fitTweenRAF) cancelAnimationFrame(fitTweenRAF);
  const fromPos = cam.position.clone();
  const fromTarget = orbit.target.clone();
  const t0 = performance.now();
  const ease = (x) => x < 0.5 ? 2*x*x : 1 - Math.pow(-2*x + 2, 2) / 2;  // easeInOutQuad
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / durationMs);
    const k = ease(t);
    cam.position.lerpVectors(fromPos, toPos, k);
    orbit.target.lerpVectors(fromTarget, toTarget, k);
    orbit.update();
    if (t < 1) fitTweenRAF = requestAnimationFrame(step);
    else fitTweenRAF = 0;
  };
  fitTweenRAF = requestAnimationFrame(step);
}

// If the house AABB isn't comfortably framed in step 0, zoom-to-fit smoothly.
function maybeFitExtents() {
  const bb = new THREE.Box3();
  const h = +inH.value;
  if (houseMode === 'box' && c1 && c2) {
    bb.expandByPoint(new THREE.Vector3(Math.min(c1.x, c2.x), Math.min(c1.y, c2.y), 0));
    bb.expandByPoint(new THREE.Vector3(Math.max(c1.x, c2.x), Math.max(c1.y, c2.y), h));
  } else if (houseMode === 'free' && footprintWalls.length) {
    for (const w of footprintWalls) {
      bb.expandByPoint(new THREE.Vector3(w.x0, w.y0, 0));
      bb.expandByPoint(new THREE.Vector3(w.x1, w.y1, h));
    }
  } else {
    return;
  }
  if (bb.isEmpty()) return;

  // Include arrow + dim label world positions so they don't get clipped either.
  const pad = 500;
  bb.min.x -= pad; bb.min.y -= pad;
  bb.max.x += pad; bb.max.y += pad; bb.max.z += pad;

  const corners = [
    new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
    new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
    new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
    new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
    new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
    new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
    new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z),
    new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
  ];
  // Effective canvas area inside visible UI panels (step bar + open side panels).
  const cRect = renderer.domElement.getBoundingClientRect();
  let eLeft = cRect.left, eRight = cRect.right;
  let eTop = cRect.top, eBottom = cRect.bottom;
  const midX = (cRect.left + cRect.right) / 2;
  for (const el of document.querySelectorAll('.panel.open, .left-panel.open')) {
    const pr = el.getBoundingClientRect();
    if (pr.width < 10 || pr.height < 10) continue;
    if ((pr.left + pr.right) / 2 < midX) eLeft = Math.max(eLeft, pr.right);
    else eRight = Math.min(eRight, pr.left);
  }
  const toprow = document.getElementById('toprow');
  if (toprow) {
    const hr = toprow.getBoundingClientRect();
    if (hr.bottom > cRect.top) eTop = Math.max(eTop, hr.bottom);
  }
  const W = cRect.width, H = cRect.height;
  if (W < 10 || H < 10) return;
  // Map effective-rect center to NDC, and effective half-extents as a fraction of canvas.
  const ndcCx = ((eLeft + eRight) / 2 - cRect.left) / W * 2 - 1;
  const ndcCy = -(((eTop + eBottom) / 2 - cRect.top) / H * 2 - 1);
  const hx = Math.max(0.1, (eRight - eLeft) / W);
  const hy = Math.max(0.1, (eBottom - eTop) / H);

  // Ensure matrixWorldInverse reflects any cam.position.copy() that happened
  // synchronously before this call (e.g. disableTopView) — otherwise project()
  // uses a stale matrix and produces a bogus zoom.
  cam.updateMatrixWorld(true);

  let maxAbs = 0;
  for (const c of corners) {
    const p = c.clone().project(cam);
    const dx = (p.x - ndcCx) / hx;
    const dy = (p.y - ndcCy) / hy;
    maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy));
  }
  if (maxAbs > 0.70 && maxAbs < 0.95) return;  // already well-framed within effective area

  const targetRatio = 0.88;
  const scale = maxAbs / targetRatio;
  const center = bb.getCenter(new THREE.Vector3());
  const offset = cam.position.clone().sub(orbit.target).multiplyScalar(scale);
  const toTarget = center.clone();
  const toPos = center.clone().add(offset);
  tweenCamera(toPos, toTarget, 500);
}

/* ────────────────── free-form footprint rendering ────────────────── */
// Each wall is a simple oriented box. Overlap at corners is acceptable — it reads
// as a solid corner. No miter, no insets — simplicity > pixel-perfect joinery.
function buildFreeFormRoom(walls, h, t, wMat, eMat) {
  const g = new THREE.Group();
  // Resolve corner overlaps: at each shared endpoint between two non-parallel walls,
  // one wall runs through (extended by t/2) and the other butts against it (shortened by t/2).
  // Rule: longer wall runs through; ties broken by lower index.
  const drawn = walls.map(w => ({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
  const EPS = 1;                                    // mm
  const key = (x, y) => Math.round(x / EPS) + "," + Math.round(y / EPS);
  const corners = new Map();                        // key → [{wallIdx, end:0|1}]
  walls.forEach((w, i) => {
    const k0 = key(w.x0, w.y0), k1 = key(w.x1, w.y1);
    if (!corners.has(k0)) corners.set(k0, []);
    if (!corners.has(k1)) corners.set(k1, []);
    corners.get(k0).push({ wallIdx: i, end: 0 });
    corners.get(k1).push({ wallIdx: i, end: 1 });
  });
  const lenOf = i => Math.hypot(walls[i].x1 - walls[i].x0, walls[i].y1 - walls[i].y0);
  const adjustEnd = (i, end, sign) => {
    // sign = +1 extends outward, -1 shortens inward (relative to wall midpoint)
    const w = walls[i];
    const dx = w.x1 - w.x0, dy = w.y1 - w.y0;
    const L = Math.hypot(dx, dy);
    if (L < 1) return;
    const ux = dx / L, uy = dy / L;                 // unit P0→P1
    const s = (end === 0 ? -1 : 1) * sign * (t / 2);
    if (end === 0) { drawn[i].x0 += ux * s; drawn[i].y0 += uy * s; }
    else           { drawn[i].x1 += ux * s; drawn[i].y1 += uy * s; }
  };
  for (const entries of corners.values()) {
    if (entries.length < 2) continue;
    // Compute each wall's outgoing direction from this corner
    const dirs = entries.map(e => {
      const w = walls[e.wallIdx];
      const L = lenOf(e.wallIdx);
      const ux = (w.x1 - w.x0) / L, uy = (w.y1 - w.y0) / L;
      // outgoing from corner: +u if corner is P0, -u if corner is P1
      return { e, L, ox: e.end === 0 ? ux : -ux, oy: e.end === 0 ? uy : -uy };
    });
    // Group collinear walls (opposite outgoing directions) into pairs
    const pairs = [];                                 // [[dirIdxA, dirIdxB]]
    const paired = new Array(dirs.length).fill(false);
    for (let i = 0; i < dirs.length; i++) {
      if (paired[i]) continue;
      for (let j = i + 1; j < dirs.length; j++) {
        if (paired[j]) continue;
        const cos = dirs[i].ox * dirs[j].ox + dirs[i].oy * dirs[j].oy;
        if (cos < -0.99) { paired[i] = paired[j] = true; pairs.push([i, j]); break; }
      }
    }
    const unpaired = dirs.filter((_, i) => !paired[i]);

    if (entries.length === 2 && unpaired.length === 2) {
      // L-corner: longer extends (through), shorter butts
      const [u0, u1] = unpaired;
      const throughFirst = (u0.L > u1.L) || (u0.L === u1.L && u0.e.wallIdx < u1.e.wallIdx);
      const through = throughFirst ? u0 : u1;
      const butt    = throughFirst ? u1 : u0;
      adjustEnd(through.e.wallIdx, through.e.end, +1);
      adjustEnd(butt.e.wallIdx,    butt.e.end,    -1);
    } else if (pairs.length === 2 && unpaired.length === 0) {
      // 4-wall cross: keep the longer parallel pair through; trim the other pair
      const total = p => dirs[p[0]].L + dirs[p[1]].L;
      const minIdx = p => Math.min(dirs[p[0]].e.wallIdx, dirs[p[1]].e.wallIdx);
      const [p0, p1] = pairs;
      const keepFirst = total(p0) > total(p1) || (total(p0) === total(p1) && minIdx(p0) < minIdx(p1));
      const trimPair = keepFirst ? p1 : p0;
      for (const dIdx of trimPair) {
        const d = dirs[dIdx];
        adjustEnd(d.e.wallIdx, d.e.end, -1);
      }
    } else {
      // T or mixed: paired walls unchanged; unpaired walls butt
      for (const u of unpaired) adjustEnd(u.e.wallIdx, u.e.end, -1);
    }
  }

  // Publish the corner-adjusted endpoints so wallInfo/openingWorldPos match rendered walls.
  footprintWallsDrawn = drawn.map(d => ({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 }));

  walls.forEach((w, i) => {
    const d = drawn[i];
    const dx = d.x1 - d.x0, dy = d.y1 - d.y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    const ox = -uy, oy = ux;                   // left-hand perpendicular (outward)
    const isSelected = (i === selectedFF);
    const mat = isSelected ? new THREE.MeshStandardMaterial({ color: 0xF9BC06, roughness: 0.6 }) : wMat;
    // Use buildWallMesh so openings punch real holes (Shape + holes + extrude).
    const spec = {
      idx: FF_WALL_OFFSET + i,
      from: [d.x0 + ox * t / 2, d.y0 + oy * t / 2],   // outward-face endpoints
      to:   [d.x1 + ox * t / 2, d.y1 + oy * t / 2],
      outward: [ox, oy],
      topPoints: [[0, h], [1, h]],                    // flat top
    };
    const items = buildWallMesh(spec, t, mat, eMat, openings);
    for (const it of items) {
      if (it.isMesh) {
        it.userData.isFFWall = true;
        it.userData.ffIdx = i;
        // isWall / wallIdx are already set by buildWallMesh — the opening raycast
        // in getWallMeshes() will now pick up free-form walls too.
      }
      g.add(it);
    }
  });
  return g;
}

function rebuildRoom() {
  markFrameStale();
  if (houseMode === 'free') { clipInteriorWallsToFootprint(); rebuildScene(); return; }
  if (mode !== M.SET || !c1) return;
  const wVal = clamp(+inW.value || LIM.W_MIN, LIM.W_MIN, LIM.W_MAX);
  const dVal = clamp(+inD.value || LIM.D_MIN, LIM.D_MIN, LIM.D_MAX);
  c2 = new THREE.Vector3(c1.x + wVal * signX, c1.y + dVal * signY, 0);
  clipInteriorWallsToFootprint();
  rebuildScene();
}

/* ────────────────── openings ────────────────── */
const WINDOW_W = 900, WINDOW_H = 1300, WINDOW_SILL = 800;
const DOOR_W = 900, DOOR_H = 2100;
const FF_WALL_OFFSET = 1000;  // free-form wall indices: FF_WALL_OFFSET + i (segregates from box 0-3 and interior 4+)

function defaultDims(type) {
  return type === "window"
    ? { width: WINDOW_W, height: WINDOW_H, sill: WINDOW_SILL }
    : { width: DOOR_W, height: DOOR_H, sill: 0 };
}

let selectedOpening = -1;

function getWallMeshes() {
  const out = [];
  if (roomGroup) for (const c of roomGroup.children) if (c.userData && c.userData.isWall) out.push(c);
  for (const c of iwGroup.children) if (c.userData && c.userData.isWall) out.push(c);
  return out;
}

function wallInfo(wallIdx) {
  // Returns { origin, along, outward, length, isInterior } for each wall.
  // Exterior walls occupy wallIdx 0..3; interior walls occupy 4..(4+N-1)
  // where N = interiorWalls.length. Free-form walls occupy FF_WALL_OFFSET+i.
  if (wallIdx >= FF_WALL_OFFSET) {
    // Prefer the corner-adjusted drawn cache (matches the rendered geometry). Fall back to
    // the raw wall if buildFreeFormRoom hasn't run yet (first opening placement, etc.).
    const idx = wallIdx - FF_WALL_OFFSET;
    const w = footprintWallsDrawn[idx] || footprintWalls[idx];
    if (!w) return null;
    const dx = w.x1 - w.x0, dy = w.y1 - w.y0;
    const L = Math.hypot(dx, dy);
    if (L < 1) return null;
    const ux = dx / L, uy = dy / L;
    const ox = -uy, oy = ux;                   // left-hand perpendicular
    const tVal = +inT.value;
    // Origin = outward-face start of the wall. makeOpeningGroup offsets inward by t/2
    // so the opening ends up on the wall centerline — matching box-mode semantics.
    return {
      origin: new THREE.Vector3(w.x0 + ox * tVal / 2, w.y0 + oy * tVal / 2, 0),
      along: new THREE.Vector3(ux, uy, 0),
      outward: new THREE.Vector3(ox, oy, 0),
      length: L,
      isInterior: false,
    };
  }
  if (!c1 || !c2) return null;
  const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
  const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
  const t = +inT.value;
  switch (wallIdx) {
    case 0: return { origin: new THREE.Vector3(x0, y0, 0), along: new THREE.Vector3(1,0,0), outward: new THREE.Vector3(0,-1,0), length: x1-x0, isInterior: false }; // south
    case 1: return { origin: new THREE.Vector3(x0, y1, 0), along: new THREE.Vector3(1,0,0), outward: new THREE.Vector3(0,1,0), length: x1-x0, isInterior: false };  // north
    case 2: return { origin: new THREE.Vector3(x0, y0+t, 0), along: new THREE.Vector3(0,1,0), outward: new THREE.Vector3(-1,0,0), length: y1-y0-2*t, isInterior: false }; // west
    case 3: return { origin: new THREE.Vector3(x1, y0+t, 0), along: new THREE.Vector3(0,1,0), outward: new THREE.Vector3(1,0,0), length: y1-y0-2*t, isInterior: false };  // east
  }
  // Interior wall — centerline from (min, min) → (max, max) along the wall's one axis.
  const iw = interiorWalls[wallIdx - 4];
  if (!iw) return null;
  const isHoriz = Math.abs(iw.y1 - iw.y0) < 1;
  if (isHoriz) {
    const xMin = Math.min(iw.x0, iw.x1), xMax = Math.max(iw.x0, iw.x1);
    return { origin: new THREE.Vector3(xMin, iw.y0, 0), along: new THREE.Vector3(1,0,0), outward: new THREE.Vector3(0,1,0), length: xMax - xMin, isInterior: true };
  } else {
    const yMin = Math.min(iw.y0, iw.y1), yMax = Math.max(iw.y0, iw.y1);
    return { origin: new THREE.Vector3(iw.x0, yMin, 0), along: new THREE.Vector3(0,1,0), outward: new THREE.Vector3(1,0,0), length: yMax - yMin, isInterior: true };
  }
}

function makeOpeningGroup(wallIdx, posAlong, type, dims) {
  const info = wallInfo(wallIdx);
  if (!info) return null;
  const t = +inT.value;
  const ow = dims.width;
  const oh = dims.height;
  const oz = (type === "window" ? dims.sill : 0) + oh / 2;

  const half = ow / 2;
  const edgePad = info.isInterior ? half : (half + t);
  posAlong = Math.max(edgePad, Math.min(info.length - edgePad, posAlong));

  const outwardOffset = info.isInterior ? 0 : (t / 2);
  const cx = info.origin.x + info.along.x * posAlong - info.outward.x * outwardOffset;
  const cy = info.origin.y + info.along.y * posAlong - info.outward.y * outwardOffset;

  const oMat = type === "window" ? windowMat : doorMat;
  const oEdgeMat = type === "window" ? windowFrameMat : doorFrameMat;
  // Thin pane sits inside the wall opening
  const paneDepth = type === "window" ? 20 : 40;
  const isAlongX = Math.abs(info.along.x) > Math.abs(info.along.y);
  const geo = new THREE.BoxGeometry(
    isAlongX ? ow : paneDepth,
    isAlongX ? paneDepth : ow,
    oh
  );
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(geo, oMat);
  mesh.position.set(cx, cy, oz);
  mesh.userData.isOpening = true;
  g.add(mesh);

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), oEdgeMat);
  edges.position.copy(mesh.position);
  g.add(edges);

  return g;
}

function placeOpening(wallIdx, posAlong, type, dims) {
  markFrameStale();
  if (!dims) dims = defaultDims(type);
  const g = makeOpeningGroup(wallIdx, posAlong, type, dims);
  if (!g) return;
  openingsGroup.add(g);
  openings.push({ type, wallIdx, posAlong, mesh: g, width: dims.width, height: dims.height, sill: dims.sill });
}

function removeOpening(groupMesh) {
  const idx = openings.findIndex(o => o.mesh && (o.mesh === groupMesh || o.mesh.children.includes(groupMesh)));
  if (idx < 0) {
    for (let i = 0; i < openings.length; i++) {
      if (openings[i].mesh && openings[i].mesh.children.some(c => c === groupMesh)) { return removeOpeningByIdx(i); }
    }
    return;
  }
  removeOpeningByIdx(idx);
}

function removeOpeningByIdx(idx) {
  markFrameStale();
  const o = openings[idx];
  openingsGroup.remove(o.mesh);
  openings.splice(idx, 1);
}

function clearOpenings() {
  while (openings.length) removeOpeningByIdx(0);
}

function rebuildOpenings() {
  const prevSelected = selectedOpening;
  if (selectedOpening >= 0) removeSelectionHighlight(selectedOpening);
  selectedOpening = -1;
  const saved = openings.map(o => ({ type: o.type, wallIdx: o.wallIdx, posAlong: o.posAlong, width: o.width, height: o.height, sill: o.sill }));
  clearOpenings();
  for (const s of saved) placeOpening(s.wallIdx, s.posAlong, s.type, { width: s.width, height: s.height, sill: s.sill });
  if (prevSelected >= 0 && prevSelected < openings.length) selectOpening(prevSelected);
}

/* ────────────────── opening selection & inspector ────────────────── */
function applySelectionHighlight(idx) {
  const o = openings[idx];
  if (!o) return;
  o.mesh.traverse(child => {
    if (child.isMesh) {
      child.userData._origMat = child.material;
      const sel = child.material.clone();
      sel.emissive = new THREE.Color(0xF9BC06);
      sel.emissiveIntensity = 0.22;
      child.material = sel;
    } else if (child.isLine) {
      child.userData._origMat = child.material;
      child.material = new THREE.LineBasicMaterial({ color: 0xF9BC06 });
    }
  });
}

function removeSelectionHighlight(idx) {
  const o = openings[idx];
  if (!o) return;
  o.mesh.traverse(child => {
    if ((child.isMesh || child.isLine) && child.userData._origMat) {
      child.material = child.userData._origMat;
      delete child.userData._origMat;
    }
  });
}

function selectOpening(idx) {
  if (selectedOpening >= 0 && selectedOpening !== idx) removeSelectionHighlight(selectedOpening);
  selectedOpening = idx;
  applySelectionHighlight(idx);
  showOpeningInspector(idx);
  const o = openings[idx];
  const info = o && wallInfo(o.wallIdx);
  if (info) showOpeningDims(info, o.posAlong, o.type, { width: o.width, height: o.height, sill: o.sill }, idx);
  positionSlideHandle(idx);
  showDistributePanel();
}

function deselectOpening() {
  if (selectedOpening < 0) return;
  removeSelectionHighlight(selectedOpening);
  selectedOpening = -1;
  $("openingInspector").classList.remove("open");
  hideOpeningDims();
  if (!multiSelected.length) {
    slideHandle.visible = false;
    setSlideHandleHover(false);
    hideDistributePanel();
  } else {
    // A multi-selection is still active — re-anchor handle at the new centroid.
    positionSlideHandle();
  }
}

/* ───── multi-select (shift-click) ───── */
let multiSelected = [];  // opening indices; when .length >= 2, drives the distribute panel

function clearMultiSelection() {
  for (const i of multiSelected) removeSelectionHighlight(i);
  multiSelected = [];
  if (selectedOpening < 0) {
    hideDistributePanel();
    slideHandle.visible = false;
    setSlideHandleHover(false);
  } else {
    positionSlideHandle();
  }
}

function toggleMultiSelection(idx) {
  // First shift-click: if a single opening is selected, promote both into multi.
  if (multiSelected.length === 0) {
    if (selectedOpening >= 0 && selectedOpening !== idx) {
      const prev = selectedOpening;
      // Tear down single-selection UI, but keep prev's highlight (it stays selected).
      $("openingInspector").classList.remove("open");
      hideOpeningDims();
      selectedOpening = -1;
      multiSelected = [prev, idx];
      applySelectionHighlight(idx);
      showDistributePanel();
      positionSlideHandle();
    } else if (selectedOpening === idx) {
      // Shift-clicking the already-selected one — treat like deselect.
      deselectOpening();
    } else {
      // Nothing selected — act like a plain single-select.
      selectOpening(idx);
    }
    return;
  }
  const pos = multiSelected.indexOf(idx);
  if (pos >= 0) {
    removeSelectionHighlight(idx);
    multiSelected.splice(pos, 1);
    if (multiSelected.length <= 1) {
      const remaining = multiSelected[0];
      multiSelected = [];
      hideDistributePanel();
      if (remaining !== undefined) {
        removeSelectionHighlight(remaining);  // cleared so selectOpening's re-apply is clean
        selectOpening(remaining);
      } else {
        slideHandle.visible = false;
      }
    } else {
      updateDistributePanelState();
      positionSlideHandle();
    }
  } else {
    multiSelected.push(idx);
    applySelectionHighlight(idx);
    updateDistributePanelState();
    positionSlideHandle();
  }
}

// Returns the indices of all currently-selected openings (1 if single-select,
// N if shift-click multi-select, 0 if none). Single-select still wants the
// actions panel so a one-window design can be centered too.
function selectedOpeningIndices() {
  if (multiSelected.length) return multiSelected.slice();
  if (selectedOpening >= 0) return [selectedOpening];
  return [];
}

function showDistributePanel() {
  $("distributePanel").classList.add("open");
  updateDistributePanelState();
  updateDistributePanelPosition();
}
function hideDistributePanel() {
  $("distributePanel").classList.remove("open");
}
function updateDistributePanelState() {
  const indices = selectedOpeningIndices();
  const btnC = $("btnCenterOpenings");
  const btnD = $("btnDistributeOpenings");
  const btnCopy = $("btnCopyOpening");
  if (!indices.length) {
    btnC.disabled = true; btnD.disabled = true; if (btnCopy) btnCopy.disabled = true;
    return;
  }
  const firstWall = openings[indices[0]].wallIdx;
  const sameWall = indices.every(i => openings[i].wallIdx === firstWall);

  btnC.disabled = !sameWall;
  btnC.title = !sameWall
    ? "Selected openings must be on the same wall"
    : (indices.length === 1 ? "Center this opening on the wall"
                            : "Center the group on the wall");

  if (indices.length < 3) {
    btnD.disabled = true;
    btnD.title = "Select 3 or more openings to distribute";
  } else {
    btnD.disabled = !sameWall;
    btnD.title = sameWall ? "Space openings evenly along the wall"
                          : "All openings must be on the same wall";
  }

  if (btnCopy) {
    // Multi-copy isn't wired up yet — only copy a single selected opening.
    btnCopy.disabled = indices.length !== 1;
    btnCopy.title = indices.length === 1
      ? "Drag onto a wall to place a copy"
      : "Select one opening to copy";
  }
}
function updateDistributePanelPosition() {
  const indices = selectedOpeningIndices();
  if (!indices.length) return;
  const panel = $("distributePanel");
  if (!panel.classList.contains("open")) return;
  const centroid = new THREE.Vector3();
  let count = 0;
  for (const i of indices) {
    const o = openings[i];
    if (!o || !o.mesh || !o.mesh.children[0]) continue;
    const wp = new THREE.Vector3();
    o.mesh.children[0].getWorldPosition(wp);
    centroid.add(wp);
    count++;
  }
  if (!count) return;
  centroid.divideScalar(count);
  centroid.z += 800;  // lift above the openings so the buttons float above them
  centroid.project(cam);
  const r = renderer.domElement.getBoundingClientRect();
  const sx = (centroid.x * 0.5 + 0.5) * r.width + r.left;
  const sy = (-centroid.y * 0.5 + 0.5) * r.height + r.top;
  const pw = panel.offsetWidth || 160;
  const ph = panel.offsetHeight || 40;
  const px = Math.max(10, Math.min(sx - pw / 2, window.innerWidth - pw - 10));
  const py = Math.max(10, Math.min(sy - ph - 10, window.innerHeight - ph - 10));
  panel.style.left = px + "px";
  panel.style.top = py + "px";
}

function distributeSelectedOpenings() {
  const indices = selectedOpeningIndices();
  if (indices.length < 3) return;
  const firstWall = openings[indices[0]].wallIdx;
  if (!indices.every(i => openings[i].wallIdx === firstWall)) return;
  const sorted = indices.slice().sort((a, b) => openings[a].posAlong - openings[b].posAlong);
  const first = openings[sorted[0]].posAlong;
  const last  = openings[sorted[sorted.length - 1]].posAlong;
  const n = sorted.length;
  for (let k = 1; k < n - 1; k++) {
    openings[sorted[k]].posAlong = first + (last - first) * (k / (n - 1));
    rebuildSingleOpening(sorted[k]);
  }
  // rebuildSingleOpening only re-applies highlight to the single-selected idx; reapply for all multi.
  for (const i of indices) applySelectionHighlight(i);
  updateDistributePanelPosition();
  pushHistory();
}

// Center the selected configuration on its wall. For a single opening, it
// lands at the wall midpoint. For multiple openings (must be on the same
// wall) the relative spacing is preserved and the group's center is shifted
// to the wall midpoint. Out-of-range positions are clamped to the wall's
// usable span — for groups too wide to fully fit centered, the result is
// the closest centered position that keeps everyone in-bounds.
function centerSelectedOpenings() {
  const indices = selectedOpeningIndices();
  if (!indices.length) return;
  const firstWall = openings[indices[0]].wallIdx;
  if (!indices.every(i => openings[i].wallIdx === firstWall)) return;
  const info = wallInfo(firstWall);
  if (!info) return;
  const tVal = +inT.value;

  // Group span in posAlong space (left-edge of leftmost → right-edge of rightmost).
  let leftEdge = Infinity, rightEdge = -Infinity;
  for (const i of indices) {
    const o = openings[i];
    leftEdge  = Math.min(leftEdge,  o.posAlong - o.width / 2);
    rightEdge = Math.max(rightEdge, o.posAlong + o.width / 2);
  }
  const groupCenter = (leftEdge + rightEdge) / 2;
  let shift = info.length / 2 - groupCenter;

  // Clamp the shift so no opening's clamped-down posAlong differs from the
  // shifted value. This keeps relative spacing intact when feasible.
  for (const i of indices) {
    const o = openings[i];
    const half = o.width / 2;
    const edgePad = info.isInterior ? half : (half + tVal);
    const lo = edgePad - o.posAlong;
    const hi = (info.length - edgePad) - o.posAlong;
    if (shift < lo) shift = lo;
    if (shift > hi) shift = hi;
  }

  if (Math.abs(shift) < 0.5) return;  // already (effectively) centered

  for (const i of indices) {
    openings[i].posAlong += shift;
    rebuildSingleOpening(i);
  }
  for (const i of indices) applySelectionHighlight(i);
  // Single-selection UI affordances need their anchor positions recomputed.
  if (selectedOpening >= 0 && indices.includes(selectedOpening)) {
    const o = openings[selectedOpening];
    const info2 = wallInfo(o.wallIdx);
    if (info2) showOpeningDims(info2, o.posAlong, o.type,
                               { width: o.width, height: o.height, sill: o.sill },
                               selectedOpening);
    positionSlideHandle(selectedOpening);
  }
  updateDistributePanelPosition();
  pushHistory();
}

function showOpeningInspector(idx) {
  const o = openings[idx];
  $("inspectorTitle").textContent = o.type === "window" ? "Window" : "Door";
  $("oInspW").value = o.width;
  $("oInspH").value = o.height;
  $("oInspSill").value = o.sill;
  $("oInspSillRow").style.display = o.type === "window" ? "" : "none";
  $("openingInspector").classList.add("open");
  updateInspectorPosition();
}

function updateInspectorPosition() {
  if (selectedOpening < 0) return;
  const o = openings[selectedOpening];
  if (!o || !o.mesh.children[0]) return;
  const worldPos = new THREE.Vector3();
  o.mesh.children[0].getWorldPosition(worldPos);
  worldPos.z += 500;  // lift anchor 0.5 m so the delete button floats above the opening
  worldPos.project(cam);
  const r = renderer.domElement.getBoundingClientRect();
  const sx = (worldPos.x * 0.5 + 0.5) * r.width + r.left;
  const sy = (-worldPos.y * 0.5 + 0.5) * r.height + r.top;
  const panel = $("openingInspector");
  const pw = panel.offsetWidth || 120;
  const ph = panel.offsetHeight || 40;
  let px = sx + 90;
  let py = sy - ph / 2;
  if (px + pw > window.innerWidth - 10) px = sx - pw - 90;
  px = Math.max(10, px);
  py = Math.max(10, Math.min(py, window.innerHeight - ph - 10));
  panel.style.left = px + "px";
  panel.style.top = py + "px";
}

function rebuildSingleOpening(idx) {
  markFrameStale();
  const o = openings[idx];
  openingsGroup.remove(o.mesh);
  const g = makeOpeningGroup(o.wallIdx, o.posAlong, o.type, { width: o.width, height: o.height, sill: o.sill });
  if (!g) return;
  openingsGroup.add(g);
  o.mesh = g;
  if (selectedOpening === idx) { applySelectionHighlight(idx); positionSlideHandle(idx); }
  rebuildWalls();
  rebuildInteriorWalls();
}

function rebuildWalls() {
  // Rebuild only the room geometry with current openings (preserves opening meshes)
  if (houseMode === 'free') {
    if (roomGroup) { scene.remove(roomGroup); roomGroup = null; }
    roomGroup = buildFreeFormRoom(footprintWalls, +inH.value, +inT.value, wallMat, edgeMat);
    scene.add(roomGroup);
    return;
  }
  if (!c1 || !c2) return;
  if (roomGroup) { scene.remove(roomGroup); roomGroup = null; }
  roomGroup = buildRoom(c1, c2, +inH.value, +inT.value, wallMat, edgeMat, floorMat, openings);
  scene.add(roomGroup);
}

/* ────────────────── opening drag & drop ────────────────── */
let draggingOpening = null;  // { type: "window"|"door" }
let ghostOpening = null;     // THREE.Group shown during drag
let openingDimGroup = null;  // live dim lines showing distance to wall edges

// Snap opening position to wall mid when within threshold.
// Threshold scales down on short walls so snap never exceeds wallLen/4.
function snapPosAlongToMid(posAlong, wallLen) {
  const mid = wallLen / 2;
  // Tighter snap radius — the previous 400 mm felt too "magnetic" for users
  // trying to place close to (but not at) the wall midpoint.
  const thresh = Math.min(120, wallLen / 12);
  return Math.abs(posAlong - mid) < thresh ? mid : posAlong;
}

// Push an opening out of collision with other openings on the same wall.
// Builds free intervals on [lo, hi] excluding the ranges blocked by existing
// openings, then returns the nearest free center to `proposedPos`.
// `excludeIdx` lets the caller ignore the opening currently being moved.
function resolveOpeningCollision(wallIdx, proposedPos, width, excludeIdx) {
  const info = wallInfo(wallIdx);
  if (!info) return proposedPos;
  const tVal = +inT.value;
  const half = width / 2;
  const edgePad = info.isInterior ? half : (half + tVal);
  const lo = edgePad;
  const hi = info.length - edgePad;
  if (hi <= lo) return proposedPos;

  const blocks = [];
  for (let i = 0; i < openings.length; i++) {
    if (i === excludeIdx) continue;
    const o = openings[i];
    if (o.wallIdx !== wallIdx) continue;
    blocks.push([o.posAlong - half - o.width / 2, o.posAlong + half + o.width / 2]);
  }
  blocks.sort((a, b) => a[0] - b[0]);

  const free = [];
  let cursor = lo;
  for (const [ba, bb] of blocks) {
    if (bb <= cursor) continue;
    if (ba > cursor) free.push([cursor, Math.min(hi, ba)]);
    cursor = Math.max(cursor, bb);
    if (cursor >= hi) break;
  }
  if (cursor < hi) free.push([cursor, hi]);

  if (!free.length) return proposedPos;

  const p = Math.max(lo, Math.min(hi, proposedPos));
  for (const [a, b] of free) if (p >= a && p <= b) return p;

  let best = free[0], bestDist = Infinity;
  for (const fi of free) {
    const d = p < fi[0] ? (fi[0] - p) : (p - fi[1]);
    if (d < bestDist) { bestDist = d; best = fi; }
  }
  return p < best[0] ? best[0] : best[1];
}

// Largest width that still fits at `center` without overlapping other openings
// on the same wall or pushing past the wall-edge padding.
function maxAllowedWidth(wallIdx, center, excludeIdx) {
  const info = wallInfo(wallIdx);
  if (!info) return Infinity;
  const tVal = +inT.value;
  // Wall-edge half-width budget (edgePad = half + t for exterior walls)
  const edgeHalf = info.isInterior
    ? Math.min(center, info.length - center)
    : Math.min(center - tVal, info.length - center - tVal);

  let leftEdge = 0;
  let rightEdge = info.length;
  for (let i = 0; i < openings.length; i++) {
    if (i === excludeIdx) continue;
    const o = openings[i];
    if (o.wallIdx !== wallIdx) continue;
    const oLeft = o.posAlong - o.width / 2;
    const oRight = o.posAlong + o.width / 2;
    if (oRight <= center) { if (oRight > leftEdge) leftEdge = oRight; }
    else if (oLeft >= center) { if (oLeft < rightEdge) rightEdge = oLeft; }
    else return 0;  // center sits inside another opening — refuse to widen
  }
  const neighbourHalf = Math.min(center - leftEdge, rightEdge - center);
  return 2 * Math.max(0, Math.min(edgeHalf, neighbourHalf));
}

function hideOpeningDims() {
  if (openingDimGroup) { scene.remove(openingDimGroup); openingDimGroup = null; }
}

function showOpeningDims(info, posAlong, type, overrides, openingIdx) {
  hideOpeningDims();
  const t = +inT.value;
  const ow = (overrides && overrides.width  != null) ? overrides.width  : (type === "window" ? WINDOW_W : DOOR_W);
  const oh = (overrides && overrides.height != null) ? overrides.height : (type === "window" ? WINDOW_H : DOOR_H);
  const sill = (overrides && overrides.sill != null) ? overrides.sill : WINDOW_SILL;
  const bot = type === "window" ? sill : 0;
  const top = bot + oh;
  const oz = (bot + top) / 2;
  const half = ow / 2;
  const edgePad = info.isInterior ? half : (half + t);
  posAlong = Math.max(edgePad, Math.min(info.length - edgePad, posAlong));
  const leftP = posAlong - half;
  const rightP = posAlong + half;

  const outPush = (info.isInterior ? 0 : t / 2) + 8;
  const tickH = 100;       // slightly shorter ticks
  const tickSmall = 60;    // for the inside-opening height dim
  // point on the wall face at (along-p, z)
  const pt = (p, z) => new THREE.Vector3(
    info.origin.x + info.along.x * p + info.outward.x * outPush,
    info.origin.y + info.along.y * p + info.outward.y * outPush,
    z
  );

  const pts = [];
  const labels = [];  // { p, z, len, axis, size }
  const isSelected = (openingIdx != null);

  // ── Left/right gap to wall edges (always visible) ──
  if (leftP > 1) {
    pts.push(pt(0, oz - tickH),    pt(0, oz + tickH));
    pts.push(pt(0, oz),            pt(leftP, oz));
    pts.push(pt(leftP, oz - tickH), pt(leftP, oz + tickH));
    labels.push({ p: leftP / 2, z: oz + tickH + 160, len: leftP, axis: "ogL", size: 30 });
  }
  const rSpan = info.length - rightP;
  if (rSpan > 1) {
    pts.push(pt(rightP, oz - tickH),       pt(rightP, oz + tickH));
    pts.push(pt(rightP, oz),               pt(info.length, oz));
    pts.push(pt(info.length, oz - tickH),  pt(info.length, oz + tickH));
    labels.push({ p: rightP + rSpan / 2, z: oz + tickH + 160, len: rSpan, axis: "ogR", size: 30 });
  }

  if (isSelected) {
    // Width: below opening (closer)
    const wz = bot - 120;
    pts.push(pt(leftP, wz - tickSmall),  pt(leftP, wz + tickSmall));
    pts.push(pt(leftP, wz),              pt(rightP, wz));
    pts.push(pt(rightP, wz - tickSmall), pt(rightP, wz + tickSmall));
    labels.push({ p: posAlong, z: wz - 120, len: ow, axis: "ow", size: 30 });

    // Height: just outside the right edge of the opening so the label and
    // dim line don't sit on top of the pane.
    const hxRight = rightP + 250;
    pts.push(pt(hxRight - tickSmall, bot), pt(hxRight + tickSmall, bot));
    pts.push(pt(hxRight, bot),             pt(hxRight, top));
    pts.push(pt(hxRight - tickSmall, top), pt(hxRight + tickSmall, top));
    labels.push({ p: hxRight + 200, z: (bot + top) / 2, len: oh, axis: "oh", size: 30 });

    // Sill: outside left edge (closer, windows only)
    if (type === "window" && sill > 1) {
      const sp = leftP - 150;
      pts.push(pt(sp - tickSmall, 0),    pt(sp + tickSmall, 0));
      pts.push(pt(sp, 0),                pt(sp, sill));
      pts.push(pt(sp - tickSmall, sill), pt(sp + tickSmall, sill));
      labels.push({ p: sp - 200, z: sill / 2, len: sill, axis: "os", size: 30 });
    }
  }

  openingDimGroup = new THREE.Group();
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.LineSegments(geo, dimLineMatAccent);
  line.renderOrder = 999;
  openingDimGroup.add(line);

  for (const lab of labels) {
    const sprite = makeTextSprite((lab.len / 1000).toFixed(2) + " m", "#F9BC06", lab.size, "rgba(40,40,40,0.82)");
    const wp = pt(lab.p, lab.z);
    sprite.position.set(wp.x, wp.y, wp.z);
    if (lab.axis && openingIdx != null) {
      sprite.userData.dimAxis = lab.axis;
      sprite.userData.openingIdx = openingIdx;
    }
    openingDimGroup.add(sprite);
  }
  scene.add(openingDimGroup);
}

function buildGhostOpening(wallIdx, posAlong, type, dimsOverride) {
  const info = wallInfo(wallIdx);
  if (!info) return null;
  const t = +inT.value;
  const ow = (dimsOverride && dimsOverride.width  != null) ? dimsOverride.width  : (type === "window" ? WINDOW_W : DOOR_W);
  const oh = (dimsOverride && dimsOverride.height != null) ? dimsOverride.height : (type === "window" ? WINDOW_H : DOOR_H);
  const sillVal = (dimsOverride && dimsOverride.sill != null) ? dimsOverride.sill : (type === "window" ? WINDOW_SILL : 0);
  const oz = (type === "window" ? sillVal : 0) + oh / 2;
  const half = ow / 2;
  const edgePad = info.isInterior ? half : (half + t);
  posAlong = Math.max(edgePad, Math.min(info.length - edgePad, posAlong));
  const outwardOffset = info.isInterior ? 0 : (t / 2);
  const cx = info.origin.x + info.along.x * posAlong - info.outward.x * outwardOffset;
  const cy = info.origin.y + info.along.y * posAlong - info.outward.y * outwardOffset;
  const paneDepth = type === "window" ? 20 : 40;
  const isAlongX = Math.abs(info.along.x) > Math.abs(info.along.y);
  const geo = new THREE.BoxGeometry(
    isAlongX ? ow : paneDepth,
    isAlongX ? paneDepth : ow,
    oh
  );
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(geo, ghostOpeningMat);
  mesh.position.set(cx, cy, oz);
  mesh.renderOrder = 998;
  g.add(mesh);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), ghostOpeningEdgeMat);
  edges.position.copy(mesh.position);
  edges.renderOrder = 998;
  g.add(edges);
  return g;
}

function updateGhostOpening(e) {
  if (!draggingOpening) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);
  const walls = getWallMeshes();
  const wHits = rc.intersectObjects(walls);

  if (ghostOpening) { scene.remove(ghostOpening); ghostOpening = null; }
  hideOpeningDims();

  if (wHits.length) {
    const wallMesh = wHits[0].object;
    const wi = wallMesh.userData.wallIdx;
    const hp = wHits[0].point;
    const info = wallInfo(wi);
    if (info) {
      const rel = new THREE.Vector3().subVectors(hp, info.origin);
      let posAlong = snapPosAlongToMid(rel.dot(info.along), info.length);
      const dims = draggingOpening.copyDims || defaultDims(draggingOpening.type);
      posAlong = resolveOpeningCollision(wi, posAlong, dims.width, -1);
      ghostOpening = buildGhostOpening(wi, posAlong, draggingOpening.type, dims);
      if (ghostOpening) scene.add(ghostOpening);
      showOpeningDims(info, posAlong, draggingOpening.type, dims);
    }
  }
}

function finishOpeningDrag(e) {
  if (!draggingOpening) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);
  const walls = getWallMeshes();
  const wHits = rc.intersectObjects(walls);

  if (wHits.length) {
    const wallMesh = wHits[0].object;
    const wi = wallMesh.userData.wallIdx;
    const hp = wHits[0].point;
    const info = wallInfo(wi);
    if (info) {
      const rel = new THREE.Vector3().subVectors(hp, info.origin);
      let posAlong = snapPosAlongToMid(rel.dot(info.along), info.length);
      const dims = draggingOpening.copyDims || defaultDims(draggingOpening.type);
      posAlong = resolveOpeningCollision(wi, posAlong, dims.width, -1);
      openings.push({ type: draggingOpening.type, wallIdx: wi, posAlong, mesh: null,
                       width: dims.width, height: dims.height, sill: dims.sill });
      rebuildScene();
      pushHistory();
    }
  }

  if (ghostOpening) { scene.remove(ghostOpening); ghostOpening = null; }
  hideOpeningDims();
  draggingOpening = null;
  renderer.domElement.style.cursor = "";
}

/* ────────────────── roof ────────────────── */
/*
 * Roof as surfaces, thickened downward:
 *   Flat  → single slab (box) at wall-top height, offset down by roofT
 *   Gable → two sloped quads from eave to ridge, each thickened into a wedge
 * Overhang extends past the outer footprint on all sides.
 */
function buildRoof() {
  if (roofGroup) { scene.remove(roofGroup); roofGroup = null; }
  if (!c1 || !c2) return;
  if (roofType === "none") return;   // walls-only mode — no roof geometry

  const x0 = Math.min(c1.x, c2.x) - 10, x1 = Math.max(c1.x, c2.x) + 10;  // +10mm preview expand
  const y0 = Math.min(c1.y, c2.y) - 10, y1 = Math.max(c1.y, c2.y) + 10;
  const h = +inH.value;
  const t = +inT.value;
  const w = x1 - x0, d = y1 - y0;
  const roofT = +inTR.value;

  roofGroup = new THREE.Group();

  if (roofType === "flat") {
    const f = flatSlopeH[0], b = flatSlopeH[1];
    const ridgeAlongX = w >= d;
    // eaveOH extends along the slope axis; gableOH along the perpendicular.
    const ohX = ridgeAlongX ? gableOH : eaveOH;
    const ohY = ridgeAlongX ? eaveOH : gableOH;

    if (f === 0 && b === 0) {
      // Perfectly flat — simple box slab
      const geo = new THREE.BoxGeometry(w + ohX * 2, d + ohY * 2, roofT);
      const mesh = new THREE.Mesh(geo, roofMat);
      mesh.position.set(x0 + w / 2, y0 + d / 2, h + roofT / 2);
      mesh.castShadow = true;
      roofGroup.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), roofEdgeMat);
      edges.position.copy(mesh.position);
      roofGroup.add(edges);
    } else {
      // Sloped flat roof — tilted slab. eaveOH extends past the slope ends
      // and extrapolates the same slope so the slab plane stays continuous.
      let top, bot;
      if (ridgeAlongX) {
        const mY = (b - f) / d;
        const fOH = f - mY * eaveOH, bOH = b + mY * eaveOH;
        top = [
          x0 - ohX, y0 - ohY, h + roofT + fOH,
          x1 + ohX, y0 - ohY, h + roofT + fOH,
          x1 + ohX, y1 + ohY, h + roofT + bOH,
          x0 - ohX, y1 + ohY, h + roofT + bOH,
        ];
        bot = [
          x0 - ohX, y0 - ohY, h + fOH,
          x1 + ohX, y0 - ohY, h + fOH,
          x1 + ohX, y1 + ohY, h + bOH,
          x0 - ohX, y1 + ohY, h + bOH,
        ];
      } else {
        const mX = (b - f) / w;
        const fOH = f - mX * eaveOH, bOH = b + mX * eaveOH;
        top = [
          x0 - ohX, y0 - ohY, h + roofT + fOH,
          x0 - ohX, y1 + ohY, h + roofT + fOH,
          x1 + ohX, y1 + ohY, h + roofT + bOH,
          x1 + ohX, y0 - ohY, h + roofT + bOH,
        ];
        bot = [
          x0 - ohX, y0 - ohY, h + fOH,
          x0 - ohX, y1 + ohY, h + fOH,
          x1 + ohX, y1 + ohY, h + bOH,
          x1 + ohX, y0 - ohY, h + bOH,
        ];
      }
      const verts = new Float32Array([...top, ...bot]);
      const idx = [
        0,1,2, 0,2,3,       // top
        4,6,5, 4,7,6,       // bottom
        0,5,1, 0,4,5,       // front edge
        2,7,3, 2,6,7,       // back edge
        0,3,7, 0,7,4,       // left side
        1,6,2, 1,5,6,       // right side
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, roofMat);
      mesh.castShadow = true;
      roofGroup.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), roofEdgeMat);
      roofGroup.add(edges);
    }
  } else {
    // Gable. Slab spans flush with outer wall faces by default; eaveOH and
    // gableOH extend it outward (perpendicular to and along the ridge). Eave
    // Z drops along the slope as the slab extends past the wall.
    const ridgeH = getRidgeH();
    const ridgeAlongX = w >= d;
    const halfSpan = ridgeAlongX ? d / 2 : w / 2;
    const s = roofT - ridgeH * t / halfSpan;
    const ridgeZ = h + ridgeH + s;
    const slope = ridgeH / halfSpan;
    const eaveZ = h + s - eaveOH * slope;
    let faces;
    if (ridgeAlongX) {
      const midY = y0 + d / 2;
      const xL = x0 - gableOH, xR = x1 + gableOH;
      const yS = y0 - eaveOH, yN = y1 + eaveOH;
      faces = [
        { // south face — eave at south, ridge at center
          top: [
            [xL, yS, eaveZ],  [xR, yS, eaveZ],
            [xR, midY, ridgeZ],  [xL, midY, ridgeZ],
          ],
          bot: [
            [xL, yS, eaveZ - roofT],  [xR, yS, eaveZ - roofT],
            [xR, midY, ridgeZ - roofT],  [xL, midY, ridgeZ - roofT],
          ],
        },
        { // north face
          top: [
            [xL, midY, ridgeZ],  [xR, midY, ridgeZ],
            [xR, yN, eaveZ],  [xL, yN, eaveZ],
          ],
          bot: [
            [xL, midY, ridgeZ - roofT],  [xR, midY, ridgeZ - roofT],
            [xR, yN, eaveZ - roofT],  [xL, yN, eaveZ - roofT],
          ],
        },
      ];
    } else {
      const midX = x0 + w / 2;
      const yL = y0 - gableOH, yR = y1 + gableOH;
      const xW = x0 - eaveOH, xE = x1 + eaveOH;
      faces = [
        { // west face
          top: [
            [xW, yL, eaveZ],  [xW, yR, eaveZ],
            [midX, yR, ridgeZ],  [midX, yL, ridgeZ],
          ],
          bot: [
            [xW, yL, eaveZ - roofT],  [xW, yR, eaveZ - roofT],
            [midX, yR, ridgeZ - roofT],  [midX, yL, ridgeZ - roofT],
          ],
        },
        { // east face
          top: [
            [midX, yL, ridgeZ],  [midX, yR, ridgeZ],
            [xE, yR, eaveZ],  [xE, yL, eaveZ],
          ],
          bot: [
            [midX, yL, ridgeZ - roofT],  [midX, yR, ridgeZ - roofT],
            [xE, yR, eaveZ - roofT],  [xE, yL, eaveZ - roofT],
          ],
        },
      ];
    }

    for (const face of faces) {
      // 8 verts: 0-3 top, 4-7 bottom
      const verts = new Float32Array([...face.top.flat(), ...face.bot.flat()]);
      const idx = [
        // top face
        0,1,2, 0,2,3,
        // bottom face (reversed winding)
        4,6,5, 4,7,6,
        // eave edge (0-1 top, 4-5 bottom)
        0,5,1, 0,4,5,
        // ridge edge (2-3 top, 6-7 bottom)
        2,7,3, 2,6,7,
        // left side (0-3 top, 4-7 bottom)
        0,3,7, 0,7,4,
        // right side (1-2 top, 5-6 bottom)
        1,6,2, 1,5,6,
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, roofMat);
      mesh.castShadow = true;
      roofGroup.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), roofEdgeMat);
      roofGroup.add(edges);
    }
  }

  roofGroup.position.z = 10;  // preview-only: lifts roof 10 mm to prevent z-fighting with wall tops
  scene.add(roofGroup);
}

/* ────────────────── interior walls ────────────────── */
const iwMat         = new THREE.MeshStandardMaterial({ color: 0xf2f0ec, roughness: 0.82, metalness: 0 });
const iwSelectedMat = new THREE.MeshStandardMaterial({ color: 0xF9BC06, roughness: 0.6,  metalness: 0 });

// Joint analysis: how far each interior wall's end should retract to meet its
// neighbour cleanly. Per-end retraction is computed from the current centerline
// layout and current iw_t — so changing thickness automatically re-resolves
// T-junctions and corners.
function computeIwJoints(walls, iwT) {
  const EPS = 1.0;  // 1 mm
  const b = (typeof getInnerBounds === 'function') ? getInnerBounds() : null;
  const onExteriorFace = (x, y) => {
    if (!b) return false;
    const onVert = (Math.abs(x - b.ix0) < EPS || Math.abs(x - b.ix1) < EPS) &&
                    y >= b.iy0 - EPS && y <= b.iy1 + EPS;
    const onHoriz = (Math.abs(y - b.iy0) < EPS || Math.abs(y - b.iy1) < EPS) &&
                     x >= b.ix0 - EPS && x <= b.ix1 + EPS;
    return onVert || onHoriz;
  };
  const pointVsWall = (px, py, w) => {
    const isHoriz = Math.abs(w.y1 - w.y0) < 1;
    if (isHoriz) {
      if (Math.abs(py - w.y0) > EPS) return null;
      const xmin = Math.min(w.x0, w.x1), xmax = Math.max(w.x0, w.x1);
      if (Math.abs(px - xmin) < EPS || Math.abs(px - xmax) < EPS) return 'endpoint';
      if (px > xmin + EPS && px < xmax - EPS) return 'mid';
      return null;
    }
    if (Math.abs(px - w.x0) > EPS) return null;
    const ymin = Math.min(w.y0, w.y1), ymax = Math.max(w.y0, w.y1);
    if (Math.abs(py - ymin) < EPS || Math.abs(py - ymax) < EPS) return 'endpoint';
    if (py > ymin + EPS && py < ymax - EPS) return 'mid';
    return null;
  };
  const wallLen = (w) => Math.hypot(w.x1 - w.x0, w.y1 - w.y0);

  const retract = walls.map(() => [0, 0]);
  walls.forEach((w, i) => {
    const myLen = wallLen(w);
    const myIsHoriz = Math.abs(w.y1 - w.y0) < 1;
    const ends = [ { x: w.x0, y: w.y0, side: 0 }, { x: w.x1, y: w.y1, side: 1 } ];
    for (const { x, y, side } of ends) {
      if (onExteriorFace(x, y)) continue;   // flush with exterior inner face — no retract
      let mid = 0;
      const endpointHits = [];
      walls.forEach((w2, j) => {
        if (j === i) return;
        const rel = pointVsWall(x, y, w2);
        if (rel === 'mid') mid++;
        else if (rel === 'endpoint') {
          // Only perpendicular L-corners — collinear end-to-end walls don't conflict.
          const w2IsHoriz = Math.abs(w2.y1 - w2.y0) < 1;
          if (myIsHoriz !== w2IsHoriz) endpointHits.push({ idx: j, len: wallLen(w2) });
        }
      });
      if (mid > 0) { retract[i][side] = iwT / 2; continue; }
      if (endpointHits.length > 0) {
        // Longest wins; tiebreak by lower index.
        // Loser retracts by t/2 (stops at winner's face).
        // Winner extends by t/2 into the corner to close the gap.
        let winnerIdx = i, winnerLen = myLen;
        for (const h of endpointHits) {
          if (h.len > winnerLen + EPS ||
              (Math.abs(h.len - winnerLen) < EPS && h.idx < winnerIdx)) {
            winnerIdx = h.idx; winnerLen = h.len;
          }
        }
        retract[i][side] = (winnerIdx !== i) ? iwT / 2 : -iwT / 2;
      }
    }
  });
  return retract;
}

function rebuildInteriorWalls() {
  while (iwGroup.children.length) iwGroup.remove(iwGroup.children[0]);
  const h = +inH.value, t = +inTI.value;
  const iwJoints = computeIwJoints(interiorWalls, t);

  // Gable-roof parameters (only used when iwToRidge && roofType === 'gable').
  // Interior walls stop at the UNDERSIDE of the roof slab, not its top. The top
  // of the slab (hEave/hApex) is offset upward by roofT so the slab's BOTTOM
  // plane passes through the inner-top corner of the long walls (see the
  // gableEaveLift derivation in buildRoom). So the underside = top − roofT.
  const useGable = iwToRidge && roofType === "gable" && c1 && c2 && houseMode !== "free";
  let gable = null;
  if (useGable) {
    const x0g = Math.min(c1.x, c2.x), x1g = Math.max(c1.x, c2.x);
    const y0g = Math.min(c1.y, c2.y), y1g = Math.max(c1.y, c2.y);
    const w = x1g - x0g, d = y1g - y0g;
    const ridgeAlongX = w >= d;
    const halfSpan = ridgeAlongX ? d / 2 : w / 2;
    const ridgeH = getRidgeH();
    const roofT = +inTR.value;
    const eaveLift = roofT - ridgeH * (+inT.value) / halfSpan;
    gable = {
      ridgeAlongX, halfSpan, ridgeH,
      centerCoord: ridgeAlongX ? (y0g + y1g) / 2 : (x0g + x1g) / 2,
      hEaveUnder: h + eaveLift - roofT,
      hApexUnder: h + ridgeH + eaveLift - roofT,
    };
  }
  const undersideAt = (xw, yw) => {
    if (!gable) return h;
    const coord = gable.ridgeAlongX ? yw : xw;
    const dist = Math.min(gable.halfSpan, Math.abs(coord - gable.centerCoord));
    return gable.hEaveUnder + gable.ridgeH * (1 - dist / gable.halfSpan);
  };

  interiorWalls.forEach((iw, i) => {
    const isHoriz = Math.abs(iw.y1 - iw.y0) < 1;
    const wallIdx = 4 + i;
    // Centerline extents (posAlong for openings is measured from centerline xMin/yMin).
    const cxMin = Math.min(iw.x0, iw.x1), cxMax = Math.max(iw.x0, iw.x1);
    const cyMin = Math.min(iw.y0, iw.y1), cyMax = Math.max(iw.y0, iw.y1);
    const centerLen = isHoriz ? (cxMax - cxMin) : (cyMax - cyMin);
    if (centerLen < 1) return;

    // Joint retractions: side 0 = (x0,y0), side 1 = (x1,y1). Translate to
    // retractions at the xMin/xMax ends (the side whose coord is smaller/larger).
    const [r0, r1] = iwJoints[i];
    const lowSideRetract  = isHoriz ? (iw.x0 <= iw.x1 ? r0 : r1) : (iw.y0 <= iw.y1 ? r0 : r1);
    const highSideRetract = isHoriz ? (iw.x0 >  iw.x1 ? r0 : r1) : (iw.y0 >  iw.y1 ? r0 : r1);

    const xMin = isHoriz ? (cxMin + lowSideRetract) : (iw.x0);
    const xMax = isHoriz ? (cxMax - highSideRetract) : (iw.x0);
    const yMin = isHoriz ? (iw.y0) : (cyMin + lowSideRetract);
    const yMax = isHoriz ? (iw.y0) : (cyMax - highSideRetract);
    const len = isHoriz ? (xMax - xMin) : (yMax - yMin);
    if (len < 1) return;

    // Shift between centerline-origin (posAlong=0 at cxMin/cyMin) and rendered-origin.
    const alongShift = lowSideRetract;

    // Top edge: flat at h, or follows the gable-roof underside when iwToRidge.
    // Local along coord → world (x, y). Start of along corresponds to xMin/yMin.
    const worldAt = (along) => isHoriz
      ? { x: xMin + along, y: iw.y0 }
      : { x: iw.x0,         y: yMin + along };
    const zStart = useGable ? undersideAt(worldAt(0).x, worldAt(0).y) : h;
    const zEnd   = useGable ? undersideAt(worldAt(len).x, worldAt(len).y) : h;
    // Peak occurs where the wall crosses the ridge line; only for walls whose
    // along-axis is perpendicular to the ridge.
    let peakAlong = -1, zPeak = 0;
    if (useGable) {
      const perpToRidge = gable.ridgeAlongX ? !isHoriz : isHoriz;
      if (perpToRidge) {
        const startCoord = gable.ridgeAlongX ? yMin : xMin;
        const p = gable.centerCoord - startCoord;
        if (p > 1 && p < len - 1) { peakAlong = p; zPeak = gable.hApexUnder; }
      }
    }

    // Face shape in local (along, up) plane, extruded by thickness t.
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(len, 0);
    shape.lineTo(len, zEnd);
    if (peakAlong > 0) shape.lineTo(peakAlong, zPeak);
    shape.lineTo(0, zStart);
    shape.closePath();

    for (const op of openings) {
      if (op.wallIdx !== wallIdx) continue;
      // posAlong is in centerline coords; shift into rendered-local coords.
      const localPos = op.posAlong - alongShift;
      const halfW = op.width / 2;
      const left = localPos - halfW;
      const right = localPos + halfW;
      if (right <= 0 || left >= len) continue;
      const bot = op.type === "window" ? op.sill : 0;
      const top = Math.min(bot + op.height, h - 50);
      if (top <= bot) continue;
      const cLeft = Math.max(0, left);
      const cRight = Math.min(len, right);
      const hole = new THREE.Path();
      hole.moveTo(cLeft, bot);
      hole.lineTo(cRight, bot);
      hole.lineTo(cRight, top);
      hole.lineTo(cLeft, top);
      hole.closePath();
      shape.holes.push(hole);
    }

    const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });
    // Orient local (along, up, perpendicular) → world. Translate so extrusion
    // centers on the interior-wall centerline.
    const along = isHoriz ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const up = new THREE.Vector3(0, 0, 1);
    const perp = isHoriz ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const origin = isHoriz
      ? new THREE.Vector3(xMin, iw.y0 - t / 2, 0)
      : new THREE.Vector3(iw.x0 - t / 2, yMin, 0);
    const m = new THREE.Matrix4().makeBasis(along, up, perp);
    m.setPosition(origin);

    const mat = (i === selectedIW) ? iwSelectedMat : iwMat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.applyMatrix4(m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.isInteriorWall = true;
    mesh.userData.iwIdx = i;
    // Tagged as a generic wall too so the openings raycast treats it like any
    // other wall. Interior walls live at wallIdx 4..N (exterior walls own 0..3).
    mesh.userData.isWall = true;
    mesh.userData.wallIdx = wallIdx;
    iwGroup.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    edges.applyMatrix4(m);
    iwGroup.add(edges);
  });
  rebuildIWEndpointMarkers();
}

// Endpoint-first snapping is still active inside snapIWPoint — we just don't
// render markers for them. The visible dots felt noisy and were redundant
// with the snap tower + cursor-grow feedback.
function rebuildIWEndpointMarkers() {}

function selectIW(idx) {
  deselectIW();
  cancelIWDraw();
  selectedIW = idx;
  rebuildInteriorWalls();
  const iw = interiorWalls[idx];
  if (iw) {
    const len = Math.hypot(iw.x1 - iw.x0, iw.y1 - iw.y0);
    showFFDim(
      new THREE.Vector3(iw.x0, iw.y0, 0),
      new THREE.Vector3(iw.x1, iw.y1, 0),
      len,
      { gap: 750, lineMat: dimLineMatAccent, labelColor: "#F9BC06" }
    );
    $("btnDeleteIW").style.display = "block";
    positionIWInspector();
    // Selecting a wall drops out of draw mode — clear any lingering snap UI
    // so the selection feels clean even before the next pointermove.
    hideDot();
    hideSnapBars();
    hideFaceIndicator();
    hideIWHoverHint();
    renderer.domElement.style.cursor = "";
  }
}

function positionIWInspector() {
  if (selectedIW < 0) return;
  const iw = interiorWalls[selectedIW];
  if (!iw) return;
  const mid = new THREE.Vector3((iw.x0 + iw.x1) / 2, (iw.y0 + iw.y1) / 2, (+inH.value) / 2);
  mid.project(cam);
  const r = renderer.domElement.getBoundingClientRect();
  const sx = (mid.x * 0.5 + 0.5) * r.width + r.left;
  const sy = (-mid.y * 0.5 + 0.5) * r.height + r.top;
  const panel = $("btnDeleteIW");
  const pw = panel.offsetWidth || 80;
  const ph = panel.offsetHeight || 32;
  // North-east of the wall midpoint.
  let px = sx + 28;
  let py = sy - ph - 28;
  if (px + pw > window.innerWidth - 10) px = sx - pw - 28;
  px = Math.max(10, px);
  py = Math.max(10, Math.min(py, window.innerHeight - ph - 10));
  panel.style.left = px + "px";
  panel.style.top = py + "px";
}

function deselectIW() {
  if (selectedIW >= 0) {
    selectedIW = -1;
    rebuildInteriorWalls();
  }
  selectedIW = -1;
  $("btnDeleteIW").style.display = "none";
  hideFFDim();
  // Re-arm the draw tool while we're still on the IW step.
  if (currentStep === 1) renderer.domElement.style.cursor = "crosshair";
}

function deleteSelectedIW() {
  if (selectedIW < 0) return;
  markFrameStale();
  interiorWalls.splice(selectedIW, 1);
  selectedIW = -1;
  $("btnDeleteIW").style.display = "none";
  rebuildInteriorWalls();
  hideFFDim();
  if (currentStep === 1) renderer.domElement.style.cursor = "crosshair";
  pushHistory();
}

/* ────────────────── interior wall snap logic ────────────────── */
// Bounding box of the current footprint — works for box mode (c1/c2) and free mode
// (min/max of all footprint wall endpoints). Returns null when no footprint exists.
function getFootprintBounds() {
  if (houseMode === 'free') {
    if (!footprintWalls.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const w of footprintWalls) {
      x0 = Math.min(x0, w.x0, w.x1);
      x1 = Math.max(x1, w.x0, w.x1);
      y0 = Math.min(y0, w.y0, w.y1);
      y1 = Math.max(y1, w.y0, w.y1);
    }
    return { x0, y0, x1, y1 };
  }
  if (!c1 || !c2) return null;
  return {
    x0: Math.min(c1.x, c2.x), x1: Math.max(c1.x, c2.x),
    y0: Math.min(c1.y, c2.y), y1: Math.max(c1.y, c2.y),
  };
}

function getInnerBounds() {
  const b = getFootprintBounds();
  const t = +inT.value;
  if (!b) return { ix0: 0, iy0: 0, ix1: 0, iy1: 0, t };
  return { ix0: b.x0 + t, iy0: b.y0 + t, ix1: b.x1 - t, iy1: b.y1 - t, t };
}

// Clip all interior walls to the current footprint. Walls whose primary axis
// falls entirely outside are removed; walls that extend beyond are trimmed.
function clipInteriorWallsToFootprint() {
  const b = getInnerBounds();
  for (let i = interiorWalls.length - 1; i >= 0; i--) {
    const iw = interiorWalls[i];
    const isH = Math.abs(iw.y1 - iw.y0) < 1;
    if (isH) {
      const y = (iw.y0 + iw.y1) / 2;
      if (y < b.iy0 - 1 || y > b.iy1 + 1) { interiorWalls.splice(i, 1); continue; }
      const x0 = Math.max(b.ix0, Math.min(b.ix1, iw.x0));
      const x1 = Math.max(b.ix0, Math.min(b.ix1, iw.x1));
      if (Math.abs(x1 - x0) < 1) { interiorWalls.splice(i, 1); continue; }
      iw.y0 = iw.y1 = Math.max(b.iy0, Math.min(b.iy1, y));
      iw.x0 = x0; iw.x1 = x1;
    } else {
      const x = (iw.x0 + iw.x1) / 2;
      if (x < b.ix0 - 1 || x > b.ix1 + 1) { interiorWalls.splice(i, 1); continue; }
      const y0 = Math.max(b.iy0, Math.min(b.iy1, iw.y0));
      const y1 = Math.max(b.iy0, Math.min(b.iy1, iw.y1));
      if (Math.abs(y1 - y0) < 1) { interiorWalls.splice(i, 1); continue; }
      iw.x0 = iw.x1 = Math.max(b.ix0, Math.min(b.ix1, x));
      iw.y0 = y0; iw.y1 = y1;
    }
  }
}

// Interior walls snap to a finer 10 cm grid than the visible 50 cm floor grid —
// lets the user land real-world dimensions (2.30 m, 1.80 m, etc.) without
// dimension edits. Global `snap()` still drives everything else, so the
// visible grid lines don't change.
const IW_SNAP = 100;
function snapIW(v) { return Math.round(v / IW_SNAP) * IW_SNAP; }

// Snap a point to the nearest interior wall face or exterior wall inner face, then grid
function snapIWPoint(pt) {
  const b = getInnerBounds();

  // Endpoint-priority snap: existing IW endpoints + inner-footprint corners, inside a
  // wider radius than the grid so landing on a target is easy. Mirrors ffSnapPoint.
  const endpoints = [];
  for (const iw of interiorWalls) { endpoints.push([iw.x0, iw.y0], [iw.x1, iw.y1]); }
  if (b && isFinite(b.ix0) && b.ix1 > b.ix0 && b.iy1 > b.iy0) {
    endpoints.push([b.ix0, b.iy0], [b.ix1, b.iy0], [b.ix1, b.iy1], [b.ix0, b.iy1]);
  }
  let bestEp = null, bestEpD = FF_ENDPOINT_SNAP;
  for (const [ex, ey] of endpoints) {
    const d = Math.hypot(pt.x - ex, pt.y - ey);
    if (d < bestEpD) { bestEpD = d; bestEp = [ex, ey]; }
  }
  if (bestEp) {
    const v = new THREE.Vector3(bestEp[0], bestEp[1], 0);
    v.snappedX = true;
    v.snappedY = true;
    v.bounds = b;
    return v;
  }

  const threshold = 250; // snap distance to wall faces
  let x = pt.x, y = pt.y;
  let snappedX = false, snappedY = false;

  // Collect snap lines: exterior inner faces
  const xSnaps = [b.ix0, b.ix1];
  const ySnaps = [b.iy0, b.iy1];

  // Interior wall centerlines (for T-junction butting) and their endpoints.
  // We intentionally snap to the *centerline*, not the face, so joint analysis
  // at render time can cleanly retract the butting wall against current iw_t.
  for (const iw of interiorWalls) {
    const isHoriz = Math.abs(iw.y1 - iw.y0) < 1;
    if (isHoriz) {
      ySnaps.push(iw.y0);            // centerline (for T into this wall)
      xSnaps.push(iw.x0, iw.x1);     // endpoints (for L-corner)
    } else {
      xSnaps.push(iw.x0);
      ySnaps.push(iw.y0, iw.y1);
    }
  }

  // Snap to nearest x snap line if close enough
  let bestDx = threshold;
  for (const sx of xSnaps) {
    const d = Math.abs(x - sx);
    if (d < bestDx) { bestDx = d; x = sx; }
  }
  if (bestDx >= threshold) x = snapIW(x); else snappedX = true;

  // Snap to nearest y snap line if close enough
  let bestDy = threshold;
  for (const sy of ySnaps) {
    const d = Math.abs(y - sy);
    if (d < bestDy) { bestDy = d; y = sy; }
  }
  if (bestDy >= threshold) y = snapIW(y); else snappedY = true;

  // Clamp to inner bounds
  x = Math.max(b.ix0, Math.min(b.ix1, x));
  y = Math.max(b.iy0, Math.min(b.iy1, y));

  const v = new THREE.Vector3(x, y, 0);
  v.snappedX = snappedX;
  v.snappedY = snappedY;
  v.bounds = b;
  return v;
}

// Constrain endpoint to orthogonal from start, snap, clamp inside bounds
function constrainIWEnd(start, pt) {
  const dx = Math.abs(pt.x - start.x);
  const dy = Math.abs(pt.y - start.y);
  const b = getInnerBounds();

  let end;
  if (dx >= dy) {
    // Horizontal wall — lock y
    end = snapIWPoint(new THREE.Vector3(pt.x, start.y, 0));
    end.y = start.y; // enforce exact horizontal
  } else {
    // Vertical wall — lock x
    end = snapIWPoint(new THREE.Vector3(start.x, pt.y, 0));
    end.x = start.x; // enforce exact vertical
  }

  // Clamp to inner bounds
  end.x = Math.max(b.ix0, Math.min(b.ix1, end.x));
  end.y = Math.max(b.iy0, Math.min(b.iy1, end.y));

  return end;
}

// Show ghost preview of wall being drawn
function showIWGhost(start, end) {
  if (iwGhostMesh) { scene.remove(iwGhostMesh); iwGhostMesh = null; }
  const isHoriz = Math.abs(end.y - start.y) < 1;
  const len = isHoriz ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y);
  if (len < 10) { hideFFDim(); return; }
  const h = +inH.value, t = +inT.value;
  const geo = isHoriz
    ? new THREE.BoxGeometry(len, t, h)
    : new THREE.BoxGeometry(t, len, h);
  iwGhostMesh = new THREE.Mesh(geo, ghostOpeningMat);
  iwGhostMesh.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, h / 2);
  iwGhostMesh.renderOrder = 998;
  scene.add(iwGhostMesh);
  showFFDim(start, end, len, { gap: 750, lineMat: dimLineMatAccent, labelColor: "#F9BC06" });
}

function cancelIWDraw() {
  iwDrawStart = null;
  iwPointerDown = null;
  if (iwGhostMesh) { scene.remove(iwGhostMesh); iwGhostMesh = null; }
  hideFFDim();
  hideFaceIndicator();
}

// Hover-to-tip state for interior walls (mirrors the free-form wall behavior)
let iwHoverIdx = -1;
let iwHoverTimer = null;
let iwHoverPointer = { x: 0, y: 0 };
const iwHoverHintEl = () => document.getElementById("iwHoverHint");
function hideIWHoverHint() {
  if (iwHoverTimer) { clearTimeout(iwHoverTimer); iwHoverTimer = null; }
  iwHoverIdx = -1;
  const el = iwHoverHintEl();
  if (el) el.style.display = "none";
}
function showIWHoverHint() {
  const el = iwHoverHintEl();
  if (!el) return;
  el.style.left = (iwHoverPointer.x + 14) + "px";
  el.style.top = (iwHoverPointer.y + 14) + "px";
  el.style.display = "block";
}
function iwWallAtEvent(e) {
  if (!iwGroup) return -1;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);
  const meshes = [];
  iwGroup.traverse(c => { if (c.isMesh && c.userData.isInteriorWall) meshes.push(c); });
  const hits = rc.intersectObjects(meshes);
  return hits.length ? hits[0].object.userData.iwIdx : -1;
}

/* ────────────────── free-form draw helpers ────────────────── */
// Minimum endpoint snap radius in world-mm. Must exceed grid SNAP so endpoint
// snap beats grid rounding when both apply. The effective radius scales up
// with zoom-out — see ffSnapRadius.
const FF_ENDPOINT_SNAP = 900;

// World-mm per screen pixel at the orbit target. Lets us keep the endpoint
// snap zone a consistent ~40 px regardless of zoom. The old fixed 900 mm
// radius shrank to a few pixels when zoomed out, which made hitting a node
// feel unreliable.
function worldPerPixel() {
  // Generic "how zoomed out are we" reading, measured at the orbit target.
  return worldPerPixelAt(orbit.target);
}
// Position-aware — world mm per screen pixel at a specific world point. Use
// this for scaling on-screen elements (snap sphere, markers) that live away
// from orbit.target: zooming into a frame corner puts the sphere much closer
// to the camera than the target, and the scale has to reflect *that* distance.
function worldPerPixelAt(pos) {
  const dist = Math.max(100, cam.position.distanceTo(pos));
  const vFov = cam.fov * Math.PI / 180;
  const h = renderer.domElement.clientHeight || 1;
  return (2 * dist * Math.tan(vFov / 2)) / h;
}
function ffSnapRadius() {
  return Math.max(FF_ENDPOINT_SNAP, 40 * worldPerPixel());
}

function ffSnapPoint(pt) {
  // Priority: endpoint of an existing wall > grid snap
  let best = null, bestD = ffSnapRadius();
  for (const w of footprintWalls) {
    for (const p of [[w.x0, w.y0], [w.x1, w.y1]]) {
      const d = Math.hypot(pt.x - p[0], pt.y - p[1]);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  if (best) {
    const v = new THREE.Vector3(best[0], best[1], 0);
    v.snapped = true;
    return v;
  }
  const v = new THREE.Vector3(snap(pt.x), snap(pt.y), 0);
  v.snapped = false;
  return v;
}

// Visible markers for all existing wall endpoints so the user can see targets.
// Rebuilt on every rebuildScene (cheap — a handful of circles).
const ffEndpointMat = new THREE.MeshBasicMaterial({ color: 0xF9BC06, depthTest: false, transparent: true, opacity: 0.8 });
const ffEndpointGroup = new THREE.Group();
ffEndpointGroup.renderOrder = 997;
scene.add(ffEndpointGroup);

function rebuildFFEndpointMarkers() {
  while (ffEndpointGroup.children.length) ffEndpointGroup.remove(ffEndpointGroup.children[0]);
  if (houseMode !== 'free' || currentStep !== 0) { ffEndpointGroup.visible = false; return; }
  ffEndpointGroup.visible = true;
  const seen = new Set();
  const add = (x, y) => {
    const key = x + ',' + y;
    if (seen.has(key)) return;
    seen.add(key);
    const m = new THREE.Mesh(new THREE.CircleGeometry(80, 20), ffEndpointMat);
    m.position.set(x, y, 3);
    ffEndpointGroup.add(m);
  };
  for (const w of footprintWalls) { add(w.x0, w.y0); add(w.x1, w.y1); }
}

// From a starting vertex, constrain end to ortho (horizontal/vertical) unless Shift is held.
// Endpoint snap still wins over ortho when within range.
function ffConstrainEnd(start, pt) {
  const endpointSnap = ffSnapPoint(pt);
  if (endpointSnap.snapped) return endpointSnap;
  if (ffShiftHeld) {
    const v = new THREE.Vector3(snap(pt.x), snap(pt.y), 0);
    v.snapped = false;
    return v;
  }
  const dx = Math.abs(pt.x - start.x);
  const dy = Math.abs(pt.y - start.y);
  const v = (dx >= dy)
    ? new THREE.Vector3(snap(pt.x), start.y, 0)
    : new THREE.Vector3(start.x, snap(pt.y), 0);
  v.snapped = false;
  return v;
}

function showFFGhost(start, end) {
  if (ffGhostMesh) { scene.remove(ffGhostMesh); ffGhostMesh = null; }
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 10) { hideFFDim(); return; }
  const h = +inH.value, t = +inT.value;
  const geo = new THREE.BoxGeometry(len, t, h);
  ffGhostMesh = new THREE.Mesh(geo, ghostOpeningMat);
  ffGhostMesh.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, h / 2);
  ffGhostMesh.rotation.z = Math.atan2(dy, dx);
  ffGhostMesh.renderOrder = 998;
  scene.add(ffGhostMesh);
  showFFDim(start, end, len);
}

// Live dimension: line offset to the right of the wall + label, like box-drag
let ffDimGroup = null;
function showFFDim(start, end, len, opts) {
  hideFFDim();
  const dx = end.x - start.x, dy = end.y - start.y;
  const L = len || Math.hypot(dx, dy);
  if (L < 10) return;
  const ux = dx / L, uy = dy / L;
  // right-hand perpendicular (relative to wall direction)
  const nx = uy, ny = -ux;
  const gap = (opts && opts.gap) || 900;
  const tick = 150;
  const lineMat = (opts && opts.lineMat) || dimLineMat;
  const labelColor = (opts && opts.labelColor) || null;
  const z = 3;
  const ox = nx * gap, oy = ny * gap;
  const tx = nx * tick, ty = ny * tick;

  const sOff = new THREE.Vector3(start.x + ox, start.y + oy, z);
  const eOff = new THREE.Vector3(end.x + ox, end.y + oy, z);
  const pts = [
    new THREE.Vector3(sOff.x - tx, sOff.y - ty, z), new THREE.Vector3(sOff.x + tx, sOff.y + ty, z),
    sOff, eOff,
    new THREE.Vector3(eOff.x - tx, eOff.y - ty, z), new THREE.Vector3(eOff.x + tx, eOff.y + ty, z),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.LineSegments(geo, lineMat);
  line.renderOrder = 999;
  ffDimGroup = new THREE.Group();
  ffDimGroup.add(line);

  const label = labelColor
    ? makeTextSprite((L / 1000).toFixed(2) + " m", labelColor, 44, "rgba(40,40,40,0.82)")
    : makeTextSprite((L / 1000).toFixed(2) + " m");
  const midX = (start.x + end.x) / 2 + nx * (gap + 250);
  const midY = (start.y + end.y) / 2 + ny * (gap + 250);
  label.position.set(midX, midY, z);
  ffDimGroup.add(label);
  scene.add(ffDimGroup);
}
function hideFFDim() {
  if (ffDimGroup) { scene.remove(ffDimGroup); ffDimGroup = null; }
}

function cancelFFDraw() {
  ffDrawStart = null;
  ffPointerDown = null;
  ffHoverEnd = null;
  if (ffGhostMesh) { scene.remove(ffGhostMesh); ffGhostMesh = null; }
  hideFFDim();
  hideDot();
  hideSnapBars();
}

function selectFFWall(idx) {
  if (idx < 0 || idx >= footprintWalls.length) return;
  selectedFF = idx;
  rebuildScene();
  const w = footprintWalls[idx];
  const lenMm = Math.round(Math.hypot(w.x1 - w.x0, w.y1 - w.y0));
  $("ffLengthVal").textContent = (lenMm / 1000).toFixed(2) + " m";
  const inspector = $("ffInspector");
  inspector.style.display = "flex";
  positionFFInspector();
}

function positionFFInspector() {
  if (selectedFF < 0) return;
  const w = footprintWalls[selectedFF];
  if (!w) return;
  const mid = new THREE.Vector3((w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, (+inH.value) / 2);
  mid.project(cam);
  const r = renderer.domElement.getBoundingClientRect();
  const sx = (mid.x * 0.5 + 0.5) * r.width + r.left;
  const sy = (-mid.y * 0.5 + 0.5) * r.height + r.top;
  const panel = $("ffInspector");
  const pw = panel.offsetWidth || 220;
  const ph = panel.offsetHeight || 150;
  let px = sx + 28;
  let py = sy - ph / 2;
  if (px + pw > window.innerWidth - 10) px = sx - pw - 28;
  px = Math.max(10, px);
  py = Math.max(10, Math.min(py, window.innerHeight - ph - 10));
  panel.style.left = px + "px";
  panel.style.top = py + "px";
}

// Hover-to-tip state for free-form walls
let ffHoverIdx = -1;
let ffHoverTimer = null;
let ffHoverPointer = { x: 0, y: 0 };
const ffHoverHintEl = () => document.getElementById("ffHoverHint");
function hideFFHoverHint() {
  if (ffHoverTimer) { clearTimeout(ffHoverTimer); ffHoverTimer = null; }
  ffHoverIdx = -1;
  const el = ffHoverHintEl();
  if (el) el.style.display = "none";
}
function showFFHoverHint() {
  const el = ffHoverHintEl();
  if (!el) return;
  el.style.left = (ffHoverPointer.x + 14) + "px";
  el.style.top = (ffHoverPointer.y + 14) + "px";
  el.style.display = "block";
}
function ffWallAtEvent(e) {
  if (!roomGroup) return -1;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);
  const meshes = [];
  roomGroup.traverse(c => { if (c.isMesh && c.userData.isFFWall) meshes.push(c); });
  const hits = rc.intersectObjects(meshes);
  return hits.length ? hits[0].object.userData.ffIdx : -1;
}

function deselectFFWall() {
  if (selectedFF < 0) return;
  selectedFF = -1;
  $("ffInspector").style.display = "none";
  rebuildScene();
}

function deleteSelectedFF() {
  if (selectedFF < 0) return;
  const removedIdx = FF_WALL_OFFSET + selectedFF;
  // Drop openings on the deleted wall; re-index openings on later walls (indices shift on splice).
  for (let i = openings.length - 1; i >= 0; i--) {
    const op = openings[i];
    if (op.wallIdx === removedIdx) openings.splice(i, 1);
    else if (op.wallIdx > removedIdx && op.wallIdx >= FF_WALL_OFFSET) op.wallIdx -= 1;
  }
  markFrameStale();
  footprintWalls.splice(selectedFF, 1);
  selectedFF = -1;
  $("ffInspector").style.display = "none";
  rebuildScene();
  if (footprintWalls.length === 0) btnNext.style.display = "none";
  pushHistory();
}

/* ────────────────── step navigation ────────────────── */
function goToStep(n) {
  if (n < 0 || n > 5) return;
  // The Buy step isn't implemented — trying to navigate there (top-bar Buy
  // tab or the "Buy →" next button) triggers the construction-guy deflection
  // sequence instead of actually advancing.
  if (n === 5) {
    workerSay("Can't do that yet — still under construction");
    return;
  }
  // Changing tabs also exits the measure tool — the measurement belongs to
  // the scene state the user was just looking at.
  if (measureActive) setMeasureActive(false);
  currentStep = n;
  setStep(n);
  updateExtWallOpacity();

  // Hide everything step-specific
  panel.classList.remove("open");
  roofPanel.classList.remove("open");
  infoPanel.classList.remove("open");
  $("iwPanel").classList.remove("open");
  updateLeftBar();   // swap step-specific buttons in the unified left sidebar
  deselectOpening();
  clearMultiSelection();
  deselectIW();
  if (n !== 0) { cancelFFDraw(); $("ffInspector").style.display = "none"; ffEndpointGroup.visible = false; hideFFHoverHint(); }
  if (n !== 1) { cancelIWDraw(); hideIWHoverHint(); }
  if (n !== 2) hideCompassTip();
  hideArrows();
  hideDot();
  hideSnapBars();
  hideFaceIndicator();
  hideDims();
  activeTool = null;
  document.querySelectorAll(".tool-item").forEach(t => t.classList.remove("active"));
  dimEdit.style.display = "none"; editingAxis = null;

  // Top-view button in steps 0, 1, and 2; stay in top view for Walls step and free-form footprint
  const keepTop = (n === 1) || (n === 0 && houseMode === 'free');
  if (!keepTop && isTopView) disableTopView();
  $("btnTopView").style.display = (n <= 2) ? "flex" : "none";

  // Common visibility — authoritative for design/frame groups.
  syncOverlay();

  const firstVisit = !stepVisited[n];
  stepVisited[n] = true;

  // Small hints shown after intro dismisses (or on revisit)
  const stepSmallHints = [
    "Drag arrows or edit dimensions",
    "Click to draw \u2022 Click to edit",
    "Drag to add \u2022 Click to inspect",
    "Choose a roof type",
    "",
    ""
  ];

  // Show intro hint on first visit, then transition to small hint
  function showIntroThenSmall() {
    hint.classList.remove("small");
    hint.innerHTML = stepIntroHints[n];
    hint.style.pointerEvents = "auto";
    hint.style.cursor = "pointer";
    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      hint.style.pointerEvents = "";
      hint.style.cursor = "";
      hint.removeEventListener("click", dismiss);
      hint.classList.add("small");
      hint.innerHTML = stepSmallHints[n];
    }
    hint.addEventListener("click", dismiss);
    setTimeout(dismiss, 3000);
  }

  switch (n) {
    case 0: // Footprint
      if (houseMode === 'free') {
        if (!isTopView) enableTopView();
        panel.classList.add("open");
        $("rowW").style.display = "none";
        $("rowD").style.display = "none";
        hint.classList.add("small");
        if (footprintWalls.length || ffDrawStart) {
          hint.style.display = "none";
        } else {
          hint.style.display = "";
          hint.innerHTML = "Click to draw \u2022 Right-drag to pan \u2022 Wheel to zoom";
        }
        orbit.enabled = true;   // allow pan/zoom; click-vs-drag is separated by ffPointerDown
        renderer.domElement.style.cursor = "crosshair";
        btnNext.textContent = NEXT_LABELS[0];
        btnNext.style.display = footprintWalls.length ? "" : "none";
        if (footprintWalls.length) maybeFitExtents(true);
      } else if (mode === M.SET) {
        panel.classList.add("open");
        positionArrows();
        updateDims();
        btnNext.textContent = NEXT_LABELS[0];
        btnNext.style.display = "";
        hint.classList.add("small");
        hint.innerHTML = "Drag arrows or edit dimensions";
        maybeFitExtents(true);
      } else {
        btnNext.style.display = "none";
        if (firstVisit) {
          hint.classList.remove("small");
          hint.innerHTML = "Click to place your house";
        } else {
          hint.classList.remove("small");
          hint.innerHTML = "Click to place your house";
        }
        orbit.enabled = false;
        renderer.domElement.style.cursor = "crosshair";
      }
      break;

    case 1: // Interior Walls
      orbit.enabled = true;
      renderer.domElement.style.cursor = "crosshair";
      $("iwPanel").classList.add("open");
      iwGroup.visible = true;
      btnNext.textContent = NEXT_LABELS[1];
      btnNext.style.display = "";
      if (!isTopView) enableTopView();
      rebuildIWEndpointMarkers();
      if (firstVisit) {
        showIntroThenSmall();
      } else {
        hint.classList.add("small");
        hint.innerHTML = "Click empty space to draw • Click a wall to edit";
      }
      break;

    case 2: // Openings
      orbit.enabled = true;
      renderer.domElement.style.cursor = "";
      openingsGroup.visible = true;
      btnNext.textContent = NEXT_LABELS[2];
      btnNext.style.display = "";
      if (firstVisit) {
        showIntroThenSmall();
        // Tutorial: point at the compass so the user knows how to leave top view.
        if (isTopView) showCompassTip();
      } else {
        hint.classList.add("small");
        hint.innerHTML = "Drag a window or door onto a wall";
      }
      break;

    case 3: // Roof
      orbit.enabled = true;
      renderer.domElement.style.cursor = "";
      // Thickness panel only matters when a roof is selected.
      roofPanel.classList.toggle("open", roofType !== "none");
      // Gable assumes a rectangular footprint — hide it for free-form and force flat.
      {
        const gableTile = document.querySelector('.roof-option[data-roof="gable"]');
        if (gableTile) gableTile.style.display = (houseMode === 'free') ? 'none' : '';
        if (houseMode === 'free' && roofType === 'gable') roofType = 'flat';
      }
      rebuildScene();
      document.querySelectorAll(".roof-option").forEach(o => {
        o.classList.toggle("active", o.dataset.roof === roofType);
      });
      $("roofIwToRidgeRow").style.display = roofType === "gable" ? "" : "none";
      btnNext.textContent = NEXT_LABELS[3];
      btnNext.style.display = "";
      if (firstVisit) {
        showIntroThenSmall();
      } else {
        hint.classList.add("small");
        hint.innerHTML = "Drag arrow to adjust slope";
      }
      break;

    case 4: // Generate / Frame
      if (!frameStale && frameGroup) {
        // Cached frame is still valid — just show it. syncOverlay already
        // handled the design-group visibility above.
        frameGroup.visible = true;
        infoPanel.classList.add("open");
        btnNext.textContent = NEXT_LABELS[4];
        btnNext.style.display = "";
        hint.classList.add("small");
        hint.innerHTML = "Frame generated";
      } else if (firstVisit) {
        hint.classList.remove("small");
        hint.innerHTML = stepIntroHints[4];
        setTimeout(() => { generateFrame(); }, 1500);
      } else {
        generateFrame();
      }
      break;

    case 5: // Buy
      orbit.enabled = true;
      renderer.domElement.style.cursor = "";
      infoPanel.classList.add("open");
      btnNext.style.display = "none";
      hint.classList.add("small");
      hint.innerHTML = "Review your frame and purchase";
      break;
  }
}

/* ────────────────── events ────────────────── */
// Start in drawing mode immediately
orbit.enabled = false;
renderer.domElement.style.cursor = "crosshair";

// Allow wheel zoom even while orbit is disabled (e.g. while drawing the first box)
renderer.domElement.addEventListener("wheel", (e) => {
  if (orbit.enabled) return;  // OrbitControls already handles it
  e.preventDefault();
  const factor = Math.pow(0.95, e.deltaY > 0 ? -1 : 1);
  const offset = cam.position.clone().sub(orbit.target);
  offset.multiplyScalar(factor);
  cam.position.copy(orbit.target).add(offset);
  orbit.update();
}, { passive: false });
$("btnTopView").style.display = "flex";

// House type picker — shown first, dismisses to reveal the footprint flow
let houseTypePicked = false;
const housePicker = $("housePicker");
$("tileBox").addEventListener("click", () => {
  houseMode = 'box';
  houseTypePicked = true;
  housePicker.style.display = "none";
  hint.style.display = "";
  $("exampleLink").style.display = "";
});
$("tileFree").addEventListener("click", (e) => {
  if (e.currentTarget.classList.contains("locked")) { e.preventDefault(); return; }
  houseMode = 'free';
  houseTypePicked = true;
  housePicker.style.display = "none";
  // Show dimensions panel with only H + T rows (W/D don't apply to free-form)
  $("rowW").style.display = "none";
  $("rowD").style.display = "none";
  panel.classList.add("open");
  $("exampleLink").style.display = "none";
  hint.style.display = "";
  hint.classList.remove("small");
  hint.innerHTML = "Click to draw \u2022 Right-drag to pan \u2022 Wheel to zoom \u2022 Shift = no ortho";
  enableTopView();
  orbit.enabled = true;    // right-drag pans, wheel zooms (rotation is already locked)
  renderer.domElement.style.cursor = "crosshair";
  rebuildScene();  // shows endpoint markers (empty at first, but wires the group up)
});

/* ────────────────── top view toggle ────────────────── */
// Step-aware opacity: whichever wall category the user is NOT editing fades
// to 30% so the active layer reads clearly.
//   Step 0 (Exterior): interior walls fade, exterior full.
//   Step 1 (Interior) not in top view: exterior fades, interior full.
//   Otherwise: both full.
function updateExtWallOpacity() {
  const extGhost = currentStep === 1 && !isTopView;
  const intGhost = currentStep === 0;
  wallMat.transparent = extGhost;
  wallMat.opacity = extGhost ? 0.3 : 1.0;
  wallMat.needsUpdate = true;
  iwMat.transparent = intGhost;
  iwMat.opacity = intGhost ? 0.3 : 1.0;
  iwMat.needsUpdate = true;
}

function topViewFitZ(cx, cy) {
  if (!c1 || !c2) return 15000;
  const pad = 800;
  const hw = (Math.abs(c2.x - c1.x) / 2) + pad;
  const hd = (Math.abs(c2.y - c1.y) / 2) + pad;
  const fovRad = 25 * Math.PI / 180;
  const aspect = renderer.domElement.clientWidth / renderer.domElement.clientHeight || 1.78;
  const zForH = hd / Math.tan(fovRad / 2);
  const zForW = hw / Math.tan(Math.atan(Math.tan(fovRad / 2) * aspect));
  return Math.max(zForH, zForW) * 1.1;
}

function enableTopView() {
  isTopView = true;
  $("btnTopView").classList.add("active");
  savedCamState = { pos: cam.position.clone(), target: orbit.target.clone() };

  const cx = c1 && c2 ? (c1.x + c2.x) / 2 : 0;
  const cy = c1 && c2 ? (c1.y + c2.y) / 2 : 0;
  orbit.target.set(cx, cy, 0);
  cam.position.set(cx, cy, topViewFitZ(cx, cy));
  cam.fov = 25; cam.updateProjectionMatrix();
  orbit.enableRotate = false;
  orbit.minPolarAngle = 0;
  orbit.maxPolarAngle = 0.0001;
  orbit.update();
  updateExtWallOpacity();
}

function disableTopView() {
  isTopView = false;
  $("btnTopView").classList.remove("active");
  if (savedCamState) {
    cam.position.copy(savedCamState.pos);
    orbit.target.copy(savedCamState.target);
    savedCamState = null;
  }
  orbit.enableRotate = true;
  orbit.minPolarAngle = 0;
  orbit.maxPolarAngle = Math.PI / 2.05;
  cam.fov = 35; cam.updateProjectionMatrix();
  orbit.update();
  updateExtWallOpacity();
}

$("btnTopView").addEventListener("click", () => {
  if (isTopView) disableTopView(); else enableTopView();
  hideCompassTip();
});

function hideCompassTip() { $("compassTip").classList.add("hidden"); }
function showCompassTip() { $("compassTip").classList.remove("hidden"); }

/* ────────────────── undo / redo ────────────────── */
const undoStack = [];
let histIdx = -1;
let applyingHistory = false;

function captureState() {
  return {
    houseMode,
    c1: c1 ? { x: c1.x, y: c1.y, z: c1.z } : null,
    c2: c2 ? { x: c2.x, y: c2.y, z: c2.z } : null,
    signX, signY,
    interiorWalls: interiorWalls.map(w => ({ ...w })),
    iwToRidge,
    openings: openings.map(o => ({ type: o.type, wallIdx: o.wallIdx, posAlong: o.posAlong, width: o.width, height: o.height, sill: o.sill })),
    footprintWalls: footprintWalls.map(w => ({ ...w })),
    roofType,
    flatSlopeH: [...flatSlopeH],
    customRidgeH,
    eaveOH, gableOH,
    inH: inH.value, inW: inW.value, inD: inD.value,
    inT: inT.value, inTI: inTI.value, inTR: inTR.value,
  };
}

function applyState(s) {
  applyingHistory = true;
  houseMode = s.houseMode;
  c1 = s.c1 ? new THREE.Vector3(s.c1.x, s.c1.y, s.c1.z) : null;
  c2 = s.c2 ? new THREE.Vector3(s.c2.x, s.c2.y, s.c2.z) : null;
  signX = s.signX; signY = s.signY;
  interiorWalls.length = 0;
  for (const w of s.interiorWalls) interiorWalls.push({ ...w });
  setIwToRidge(!!s.iwToRidge);
  footprintWalls.length = 0;
  for (const w of s.footprintWalls) footprintWalls.push({ ...w });
  roofType = s.roofType;
  flatSlopeH = [...s.flatSlopeH];
  customRidgeH = s.customRidgeH;
  eaveOH = s.eaveOH || 0;
  gableOH = s.gableOH || 0;
  inH.value = s.inH; inW.value = s.inW; inD.value = s.inD;
  inT.value = s.inT; inTI.value = s.inTI; inTR.value = s.inTR;
  // Rebuild openings from scratch
  clearOpenings();
  for (const o of s.openings) {
    placeOpening(o.wallIdx, o.posAlong, o.type, { width: o.width, height: o.height, sill: o.sill });
  }
  deselectOpening();
  clearMultiSelection && clearMultiSelection();
  deselectIW && deselectIW();
  markFrameStale();
  rebuildScene();
  applyingHistory = false;
}

function pushHistory() {
  if (applyingHistory) return;
  undoStack.length = histIdx + 1;
  undoStack.push(captureState());
  histIdx = undoStack.length - 1;
  if (undoStack.length > 50) { undoStack.shift(); histIdx--; }
  updateUndoRedoButtons();
}

function undo() {
  if (histIdx <= 0) return;
  histIdx--;
  applyState(undoStack[histIdx]);
  updateUndoRedoButtons();
}

function redo() {
  if (histIdx >= undoStack.length - 1) return;
  histIdx++;
  applyState(undoStack[histIdx]);
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  btnUndo.disabled = histIdx <= 0;
  btnRedo.disabled = histIdx >= undoStack.length - 1;
}

btnUndo.addEventListener("click", undo);
btnRedo.addEventListener("click", redo);
window.addEventListener("keydown", (e) => {
  if (btnUndo.style.display === "none") return;  // only when toolbar is showing
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;  // let fields handle it
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
});
btnNext.addEventListener("click", () => goToStep(currentStep + 1));
$("btnBuy").addEventListener("click", () => {
  workerSay("Can't do that yet — still under construction");
});

// Rebuild the frame mesh + cached stats from a /generate-frame response.
// Pure data → scene; does NOT change the active step or open the info panel.
// Caches the raw JSON on window._lastFrameJson so saved projects can persist
// the generated frame and replay it after a reload.
function applyFrameJson(json) {
  if (!json || !Array.isArray(json.vertices)) return;

  if (frameGroup) { scene.remove(frameGroup); frameGroup = null; }
  frameVertices = [];

  const geo = new THREE.BufferGeometry();
  const nVerts = json.vertices.length;
  const pos = new Float32Array(nVerts * 3);
  const nrm = new Float32Array(nVerts * 3);
  const snapVerts = new Array(nVerts);
  for (let i = 0; i < nVerts; i++) {
    pos[i * 3]     = json.vertices[i][0];
    pos[i * 3 + 1] = json.vertices[i][1];
    pos[i * 3 + 2] = json.vertices[i][2];
    nrm[i * 3]     = json.normals[i][0];
    nrm[i * 3 + 1] = json.normals[i][1];
    nrm[i * 3 + 2] = json.normals[i][2];
    snapVerts[i] = new THREE.Vector3(
      json.vertices[i][0], json.vertices[i][1], json.vertices[i][2]
    );
  }
  frameVertices = snapVerts;
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(nrm, 3));

  const tan = new Float32Array(nVerts * 3);
  const hasTangents = Array.isArray(json.tangents) && json.tangents.length === nVerts;
  for (let i = 0; i < nVerts; i++) {
    if (hasTangents) {
      tan[i * 3]     = json.tangents[i][0];
      tan[i * 3 + 1] = json.tangents[i][1];
      tan[i * 3 + 2] = json.tangents[i][2];
    } else {
      tan[i * 3]     = 0; tan[i * 3 + 1] = 0; tan[i * 3 + 2] = 1;
    }
  }
  geo.setAttribute("aMemberTangent", new THREE.BufferAttribute(tan, 3));

  const idx = [];
  for (const f of json.faces) idx.push(f[0], f[1], f[2]);
  geo.setIndex(idx);

  const mesh = new THREE.Mesh(geo, frameMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  frameGroup = new THREE.Group();
  frameGroup.add(mesh);
  scene.add(frameGroup);
  rebuildFrameEdges(json.crease_edges);
  syncOverlay();

  if (json.stats) {
    window._lastFrameStats = json.stats;
    applyPriceFactor(json.stats);
    const s = json.stats;
    const fmt = (n) => n.toLocaleString("en", { maximumFractionDigits: 1 });
    const totalMeters = (s.part_list || []).reduce((a, it) => a + (+it.meters || 0), 0);
    $("infoMembers").textContent = s.member_count + " pcs.";
    $("infoTotalLength").textContent = fmt(totalMeters) + " m";

    const cl = $("infoCutList");
    cl.innerHTML = "";
    for (const item of (s.part_list || [])) {
      const row = document.createElement("div");
      row.className = "cut-row";
      const countSpan = item.count != null
        ? `<span class="cut-count">${item.count} pcs</span>` : "";
      row.innerHTML = `<span class="cut-sec">${item.section}</span>`
        + countSpan
        + `<span class="cut-len">${item.meters} m</span>`;
      cl.appendChild(row);
    }
  }

  window._lastFrameJson = json;
  markFrameFresh();
}

// Build the request body for /generate-frame and the JS spec parity check.
// Returns null when the design isn't placed yet (e.g., before step 0 finishes).
function buildRequestBody() {
  if (!c1 || !c2) return null;
  const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
  const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
  return {
    x0, y0, x1, y1,
    height: +inH.value,
    thickness: +inT.value,
    interiorThickness: +inTI.value,
    roofThickness: +inTR.value,
    openings: openings.map(o => ({
      type: o.type,
      wallIdx: o.wallIdx,
      posAlong: o.posAlong,
      width: o.width,
      height: o.height,
      sill: o.sill,
    })),
    interiorWalls: interiorWalls.map(iw => ({ x0: iw.x0, y0: iw.y0, x1: iw.x1, y1: iw.y1 })),
    iwToRidge: iwToRidge,
    roofType: roofType,
    ridgeH: getRidgeH(),
    flatSlopeH: flatSlopeH,
    eaveOH: eaveOH,
    gableOH: gableOH,
    materialFactor: materialFactor,
    fabFactor: fabFactor,
  };
}


async function generateFrame() {
  const reqBody = buildRequestBody();
  if (!reqBody) return;

  setStep(4);
  hideArrows();
  hideDims();
  btnNext.style.display = "none";
  panel.classList.remove("open");
  infoPanel.classList.remove("open");
  roofPanel.classList.remove("open");
  $("iwPanel").classList.remove("open");
  hint.style.display = "none";

  // Design groups already hidden by setStep(4) → syncOverlay (or kept visible
  // when the dev-mode overlay is on — we respect that).

  // Show loading overlay
  const overlay = $("loadingOverlay");
  overlay.classList.add("active");

  // Step 5 parity diagnostic: builds the same spec bundle in JS and diffs
  // it against /api/compute-specs. Runs in parallel, logs to console only.
  runSpecParityDiff(reqBody);

  try {
    const res = await fetch("/generate-frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const json = await res.json();
    if (json.error) { alert("Error: " + json.error); return; }

    applyFrameJson(json);
    infoPanel.classList.add("open");
    btnNext.textContent = NEXT_LABELS[4];
    btnNext.style.display = "";
    hint.innerHTML = `Frame generated — ${json.result_count} members`;
  } catch (err) {
    alert("Request failed: " + err.message);
  } finally {
    overlay.classList.remove("active");
    hint.style.display = "";
    hint.classList.add("small");
  }
}

// ── Arrow hit-testing ──
function hitArrow(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);
  const pool = heightArrow.visible ? [...arrows, heightArrow] : arrows;
  const hits = rc.intersectObjects(pool);
  return hits.length ? hits[0].object : null;
}

// Always suppress the native context menu on the canvas — right-drag still
// pans via OrbitControls because that listens to pointer events, not
// contextmenu. No in-app feature binds to right-click anymore.
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("pointerleave", () => { hideFFHoverHint(); hideIWHoverHint(); });
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;   // right = OrbitControls pan, middle = dolly
  if (!houseTypePicked) return;

  // Measure tool intercepts every left-click — step handlers and orbit stay
  // in place for right-drag panning.
  if (measureActive) {
    measurePointerDown = { x: e.clientX, y: e.clientY };
    return;
  }

  // Scale-worker hit-test takes precedence over step-specific handlers.
  if (scaleWorker && scaleWorker.visible && scaleWorkerMesh) {
    const r0 = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r0.left) / r0.width) * 2 - 1;
    ndc.y = -((e.clientY - r0.top) / r0.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    if (rc.intersectObject(scaleWorkerMesh).length) {
      const pill = document.getElementById('scaleWorkerPill');
      if (pill) pill.classList.toggle('open');
      updateScaleWorkerPill();
      e.stopPropagation();
      return;
    }
  }
  // Any other pointerdown on the canvas dismisses an open pill (keeps the worker).
  {
    const pill = document.getElementById('scaleWorkerPill');
    if (pill && pill.classList.contains('open')) pill.classList.remove('open');
  }

  // ── Free-form footprint step: record mouse down position (handled on pointerup) ──
  if (currentStep === 0 && houseMode === 'free') {
    ffPointerDown = { x: e.clientX, y: e.clientY };
  }

  // ── Interior Walls step: record mouse down position (handled on pointerup) ──
  if (currentStep === 1) {
    iwPointerDown = { x: e.clientX, y: e.clientY };
  }

  // ── Openings step: click to select opening ──
  if (currentStep === 2) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);

    // Gimbal hit-test (takes precedence — sits on the wall plane on the
    // selected opening). The hit's userData.role tells us which axis the
    // user grabbed; the drag handler reads gizmoDrag each frame and applies
    // shifts uniformly to single + multi selections.
    if (slideHandle.visible && selectedOpeningIndices().length) {
      const handleParts = [];
      slideHandle.traverse(c => { if (c.isMesh) handleParts.push(c); });
      const hits = rc.intersectObjects(handleParts);
      if (hits.length) {
        let role = null, sign = 0, node = hits[0].object;
        while (node && node !== slideHandle) {
          if (node.userData && node.userData.role) {
            role = node.userData.role;
            sign = node.userData.sign || 0;
            break;
          }
          node = node.parent;
        }
        if (role) {
          const indices = selectedOpeningIndices();
          const firstWall = openings[indices[0]].wallIdx;
          const info = wallInfo(firstWall);
          // Wall plane through the gimbal's anchor point.
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
            info.outward.clone(), slideHandle.position.clone()
          );
          const startHit = new THREE.Vector3();
          if (rc.ray.intersectPlane(plane, startHit)) {
            gizmoDrag = {
              role, sign, info, plane, startHit,
              indices: indices.slice(),
              startStates: indices.map(i => ({
                idx: i,
                posAlong: openings[i].posAlong,
                sill: openings[i].sill || 0,
              })),
            };
            draggingSlide = 1;       // sentinel for the existing pointerup
            orbit.enabled = false;
            renderer.domElement.style.cursor = "grabbing";
            setSlideHandleHover(true);
            return;
          }
        }
      }
    }

    // Keep selection when click lands on a dim label — lets the dblclick edit flow
    // fire without losing the dims between the two clicks.
    if (selectedOpening >= 0 && openingDimGroup) {
      const dimSprites = [];
      openingDimGroup.traverse(c => { if (c.isSprite) dimSprites.push(c); });
      if (dimSprites.length && rc.intersectObjects(dimSprites).length) return;
    }

    const openingMeshes = [];
    openingsGroup.traverse(c => { if (c.isMesh) openingMeshes.push(c); });
    const oHits = rc.intersectObjects(openingMeshes);
    if (oHits.length) {
      const hitGroup = oHits[0].object.parent;
      const idx = openings.findIndex(o => o.mesh === hitGroup);
      if (idx >= 0) {
        if (e.shiftKey) {
          toggleMultiSelection(idx);
        } else if (multiSelected.length) {
          // Non-shift click during multi-select → collapse to single.
          clearMultiSelection();
          selectOpening(idx);
        } else if (selectedOpening === idx) {
          deselectOpening();
        } else {
          selectOpening(idx);
        }
        return;
      }
    }

    // Forgiving region around the selected opening: project its AABB to screen
    // space and only deselect if the click is outside the box + margin.
    if (selectedOpening >= 0) {
      const o = openings[selectedOpening];
      if (o && o.mesh) {
        const bbox = new THREE.Box3().setFromObject(o.mesh);
        if (isFinite(bbox.min.x)) {
          const corners = [
            new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z),
            new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
            new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z),
            new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z),
            new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.max.z),
            new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.max.z),
            new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.max.z),
            new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.max.z),
          ];
          let sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
          for (const cp of corners) {
            const p = cp.clone().project(cam);
            const sx = (p.x * 0.5 + 0.5) * r.width;
            const sy = (-p.y * 0.5 + 0.5) * r.height;
            if (sx < sxMin) sxMin = sx;
            if (sy < syMin) syMin = sy;
            if (sx > sxMax) sxMax = sx;
            if (sy > syMax) syMax = sy;
          }
          const margin = 120;  // px tolerance around opening
          const mx = e.clientX - r.left;
          const my = e.clientY - r.top;
          if (mx >= sxMin - margin && mx <= sxMax + margin &&
              my >= syMin - margin && my <= syMax + margin) return;
        }
      }
    }

    deselectOpening();
    if (multiSelected.length) clearMultiSelection();
    return;
  }

  // Roof arrow drag start (roof step)
  if (currentStep === 3) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    // Check gable ridge arrow
    if (ridgeArrow.visible) {
      const hits = rc.intersectObjects([ridgeArrow]);
      if (hits.length) {
        draggingRidge = true;
        orbit.enabled = false;
        renderer.domElement.style.cursor = "grabbing";
        return;
      }
    }
    // Check flat roof slope arrows
    const visSlopeArrows = slopeArrows.filter(a => a.visible);
    if (visSlopeArrows.length) {
      const hits = rc.intersectObjects(visSlopeArrows);
      if (hits.length) {
        draggingSlopeEdge = hits[0].object.userData.slopeEdge;
        orbit.enabled = false;
        renderer.domElement.style.cursor = "grabbing";
        return;
      }
    }
    // Check roof overhang arrows (gable only)
    const visRoofArrows = roofArrows.filter(a => a.visible);
    if (visRoofArrows.length) {
      const hits = rc.intersectObjects(visRoofArrows);
      if (hits.length) {
        const obj = hits[0].object;
        draggingRoofOH = { side: obj.userData.roofSide, role: obj.userData.role };
        orbit.enabled = false;
        renderer.domElement.style.cursor = "grabbing";
        return;
      }
    }
  }

  // Arrow drag start (footprint step) — box mode only
  if (currentStep === 0 && houseMode === 'box' && mode === M.SET) {
    // Height arrow first (it stands above the box so takes precedence on overlap)
    if (heightArrow.visible) {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      rc.setFromCamera(ndc, cam);
      const hh = rc.intersectObjects([heightArrow]);
      if (hh.length) {
        draggingHeight = true;
        orbit.enabled = false;
        renderer.domElement.style.cursor = "grabbing";
        return;
      }
    }
    const hit = hitArrow(e);
    if (hit) {
      const idx = hit.userData.idx;
      dragging = { idx, ...ARROW_DIRS[idx] };
      orbit.enabled = false;
      renderer.domElement.style.cursor = "grabbing";
      return;
    }
  }

  if (currentStep !== 0) return;
  // Free-form footprint: commit handled in pointerup, do not fall through to box drawing
  if (houseMode === 'free') return;

  const pt = groundHit(e);
  if (!pt) return;
  const s = new THREE.Vector3(snap(pt.x), snap(pt.y), 0);

  if (mode === M.P1) {
    c1 = s;
    mode = M.P2;
    $("exampleLink").style.display = "none";
    hint.classList.add("small");
    hint.innerHTML = "Move to size, click to place";
  } else if (mode === M.P2) {
    const w = Math.abs(s.x - c1.x), d = Math.abs(s.y - c1.y);
    if (w < 400 || d < 400) { hint.innerHTML = "Too small — move further"; return; }

    c2 = s;
    signX = c2.x >= c1.x ? 1 : -1;
    signY = c2.y >= c1.y ? 1 : -1;
    placeRoom();
    enterSet();
  }
});

// Also listen on document for opening drag (mouse may leave canvas while dragging from panel)
document.addEventListener("pointermove", (e) => {
  if (!draggingOpening) return;
  // Move cursor ghost
  dragGhost.style.left = e.clientX + "px";
  dragGhost.style.top = e.clientY + "px";
  // Update 3D ghost on walls
  updateGhostOpening(e);
  // Hide cursor ghost when 3D ghost is showing, show it otherwise
  dragGhost.style.opacity = ghostOpening ? "0" : "0.7";
});
document.addEventListener("pointerup", (e) => {
  if (!draggingOpening) return;
  finishOpeningDrag(e);
  document.querySelectorAll(".tool-item").forEach(t => t.classList.remove("active"));
  dragGhost.style.display = "none";
});

renderer.domElement.addEventListener("pointermove", (e) => {
  // Measure tool — roving snap sphere + live preview line. Raycasts into the
  // scene so top-of-wall corners and vertical edges get snap candidates in
  // perspective mode.
  if (measureActive) {
    const hit3D = measureRaycast(e);
    if (hit3D) {
      const snapped = measureSnapAligned(hit3D);
      if (snapped) {
        moveDot(snapped);
        drawMeasure(measurePoints.length === 1 ? snapped : null);
      }
    } else {
      hideDot();
    }
    return;
  }

  // Free-form footprint: snap dot + ghost preview while drawing; hover hint when idle
  if (currentStep === 0 && houseMode === 'free') {
    const pt = groundHit(e);
    if (pt) {
      if (ffDrawStart) {
        const end = ffConstrainEnd(ffDrawStart, new THREE.Vector3(pt.x, pt.y, 0));
        ffHoverEnd = end;
        showFFGhost(ffDrawStart, end);
        moveDot(end);
        hideFFHoverHint();
      } else {
        const snapped = ffSnapPoint(new THREE.Vector3(pt.x, pt.y, 0));
        moveDot(snapped);
        // Hover hint: over a wall (but not in its endpoint-snap zone)
        const hovered = snapped.snapped ? -1 : ffWallAtEvent(e);
        ffHoverPointer.x = e.clientX; ffHoverPointer.y = e.clientY;
        if (hovered >= 0) {
          renderer.domElement.style.cursor = "pointer";
          if (hovered !== ffHoverIdx) {
            hideFFHoverHint();
            ffHoverIdx = hovered;
            ffHoverTimer = setTimeout(showFFHoverHint, 500);
          } else if (ffHoverHintEl().style.display === "block") {
            showFFHoverHint();  // follow cursor
          }
        } else {
          renderer.domElement.style.cursor = "crosshair";
          hideFFHoverHint();
        }
      }
    }
    return;
  }

  // Interior wall snap dot + ghost preview; hover hint when idle
  if (currentStep === 1) {
    // Draw tool is disabled while a wall is selected — no snap dot, no ghost,
    // no snap bars. Click another wall to switch, or click empty space to
    // deselect and start drawing.
    if (selectedIW >= 0) {
      hideDot();
      hideSnapBars();
      hideFaceIndicator();
      hideIWHoverHint();
      return;
    }
    const pt = groundHit(e);
    if (pt) {
      if (iwDrawStart) {
        const end = constrainIWEnd(iwDrawStart, new THREE.Vector3(pt.x, pt.y, 0));
        showIWGhost(iwDrawStart, end);
        moveDot(end);
        showSnapBars(end);
        updateFaceIndicator(end);
        hideIWHoverHint();
      } else {
        const snapped = snapIWPoint(new THREE.Vector3(pt.x, pt.y, 0));
        // Cursor over a wall always means "edit" — no draw indicators, even
        // if we'd otherwise snap to an endpoint. Click empty space to draw.
        const hovered = iwWallAtEvent(e);
        iwHoverPointer.x = e.clientX; iwHoverPointer.y = e.clientY;
        if (hovered >= 0) {
          // Cursor is over a wall — the click will edit, not draw. Hide every
          // draw affordance so the user isn't distracted by a snap tower that
          // won't be used.
          renderer.domElement.style.cursor = "pointer";
          hideDot();
          hideSnapBars();
          hideFaceIndicator();
          if (hovered !== iwHoverIdx) {
            hideIWHoverHint();
            iwHoverIdx = hovered;
            iwHoverTimer = setTimeout(showIWHoverHint, 500);
          } else if (iwHoverHintEl().style.display === "block") {
            showIWHoverHint();  // follow cursor
          }
        } else {
          renderer.domElement.style.cursor = "crosshair";
          moveDot(snapped);
          showSnapBars(snapped);
          updateFaceIndicator(snapped);
          hideIWHoverHint();
        }
      }
    }
    return;
  }

  // Flat roof slope arrow dragging
  if (draggingSlopeEdge >= 0) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    const arrowPos = slopeArrows[draggingSlopeEdge].position.clone();
    const camDir = cam.getWorldDirection(new THREE.Vector3());
    const vertPlane = new THREE.Plane(new THREE.Vector3(-camDir.x, -camDir.y, 0).normalize(), 0);
    vertPlane.constant = -vertPlane.normal.dot(arrowPos);
    const hitPt = new THREE.Vector3();
    if (rc.ray.intersectPlane(vertPlane, hitPt)) {
      const h = +inH.value;
      const roofT = +inTR.value;
      // Snap edge height to nearest 1° slope (treating the other edge as
      // baseline, so the angle reads as the rise from a flat zero-line). The
      // span is the building dimension along the slope axis.
      const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
      const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
      const w = x1 - x0, d = y1 - y0;
      const span = (w >= d) ? d : w;
      const hRaw = hitPt.z - h - roofT;
      const degRaw = Math.atan2(hRaw, span) * 180 / Math.PI;
      const degSnap = clamp(Math.round(degRaw), 0, 45);
      const hSnap = span * Math.tan(degSnap * Math.PI / 180);
      flatSlopeH[draggingSlopeEdge] = clamp(hSnap, 0, LIM.FLAT_SLOPE_MAX);
      markFrameStale();
      rebuildScene();
    }
    return;
  }

  // Roof overhang arrow dragging (eave/gable, mirrors to opposite side)
  if (draggingRoofOH) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    // Project mouse onto the horizontal plane at the arrow's z so dragging
    // tracks ground-plane motion (the value we're editing is XY-only).
    const arrowPos = roofArrows[draggingRoofOH.side].position.clone();
    const horizPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -arrowPos.z);
    const hitPt = new THREE.Vector3();
    if (rc.ray.intersectPlane(horizPlane, hitPt)) {
      const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
      const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
      const off = 350;
      // side 0=S, 1=N, 2=W, 3=E. Distance from outer wall face along outward normal.
      let v = 0;
      if (draggingRoofOH.side === 0)      v = y0 - hitPt.y - off;
      else if (draggingRoofOH.side === 1) v = hitPt.y - y1 - off;
      else if (draggingRoofOH.side === 2) v = x0 - hitPt.x - off;
      else                                v = hitPt.x - x1 - off;
      // 20 mm step (2 cm) — overhangs are read in cm-precision in real frames.
      const snapped = clamp(Math.round(v / 20) * 20, 0, OH_MAX);
      if (draggingRoofOH.role === "eave") eaveOH = snapped;
      else                                gableOH = snapped;
      markFrameStale();
      rebuildScene();
    }
    return;
  }

  // Height arrow dragging — project mouse to vertical plane through box center
  if (draggingHeight) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    const centerPos = heightArrow.position.clone();
    const camDir = cam.getWorldDirection(new THREE.Vector3());
    const vertPlane = new THREE.Plane(new THREE.Vector3(-camDir.x, -camDir.y, 0).normalize(), 0);
    vertPlane.constant = -vertPlane.normal.dot(centerPos);
    const hitPt = new THREE.Vector3();
    if (rc.ray.intersectPlane(vertPlane, hitPt)) {
      const newH = clamp(snap(hitPt.z - 350), LIM.H_MIN, LIM.H_MAX);  // subtract the arrow's 350mm offset
      inH.value = Math.round(newH);
      markFrameStale();
      rebuildScene();
    }
    return;
  }

  // Ridge arrow dragging — project mouse to vertical plane through ridge
  if (draggingRidge) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    // Intersect with a vertical plane facing the camera at the ridge position
    const ridgePos = ridgeArrow.position.clone();
    const camDir = cam.getWorldDirection(new THREE.Vector3());
    // Use a plane perpendicular to camera but only take Z component
    const vertPlane = new THREE.Plane(new THREE.Vector3(-camDir.x, -camDir.y, 0).normalize(), 0);
    vertPlane.constant = -vertPlane.normal.dot(ridgePos);
    const hitPt = new THREE.Vector3();
    if (rc.ray.intersectPlane(vertPlane, hitPt)) {
      const h = +inH.value;
      const t = +inT.value;
      const roofT = +inTR.value;
      // ridge arrow is at h + ridgeH + s where s = roofT - ridgeH*t/halfSpan.
      // hitZ = h + roofT + ridgeH*(1 - t/halfSpan) → solve for ridgeH.
      const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
      const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
      const w = x1 - x0, d = y1 - y0;
      const halfSpan = w >= d ? d / 2 : w / 2;
      const rhRaw = (hitPt.z - h - roofT) * halfSpan / (halfSpan - t);
      // Snap to the nearest 1° slope increment.
      const degRaw = Math.atan2(rhRaw, halfSpan) * 180 / Math.PI;
      const degSnap = Math.max(1, Math.min(45, Math.round(degRaw)));
      const rhSnap = halfSpan * Math.tan(degSnap * Math.PI / 180);
      customRidgeH = Math.max(200, Math.round(rhSnap));
      markFrameStale();
      rebuildScene();
    }
    return;
  }

  // Roof arrow hover (roof step — ridge for gable, slope arrows for flat)
  if (currentStep === 3 && !dragging && draggingSlopeEdge < 0) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    const allRoofArrows = [ridgeArrow, ...slopeArrows, ...roofArrows].filter(a => a.visible);
    const hits = allRoofArrows.length ? rc.intersectObjects(allRoofArrows) : [];
    setArrowHover(hits.length ? hits[0].object : null);
    if (hits.length) {
      renderer.domElement.style.cursor = "grab";
      return;
    } else {
      renderer.domElement.style.cursor = "";
    }
  }

  // Opening gimbal dragging — raycast onto the wall plane, derive
  // (along, vertical) deltas, then constrain to the dragged axis.
  //   role "along"    → posAlong only (snap + collision for single)
  //   role "vertical" → sill only (windows; clamped to wall height)
  //   role "center"   → both axes free; for multi, vertical is suppressed.
  if (draggingSlide >= 0 && gizmoDrag) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    const cur = new THREE.Vector3();
    if (!rc.ray.intersectPlane(gizmoDrag.plane, cur)) return;
    const delta = cur.clone().sub(gizmoDrag.startHit);
    const info = gizmoDrag.info;
    const tVal = +inT.value;
    const wallH = +inH.value;

    let dAlong = delta.dot(info.along);
    let dVert = delta.z;
    // 10 mm (1 cm) snap on both axes — fine enough for trim adjustments
    // without feeling continuous.
    dAlong = Math.round(dAlong / 10) * 10;
    dVert = Math.round(dVert / 10) * 10;
    // Constrain to the grabbed axis. Center allows both; multi has no vertical.
    if (gizmoDrag.role === "along") dVert = 0;
    else if (gizmoDrag.role === "vertical") dAlong = 0;
    if (gizmoDrag.indices.length > 1) dVert = 0;

    // Clamp dAlong so no opening crosses the wall ends.
    for (const ss of gizmoDrag.startStates) {
      const o = openings[ss.idx];
      const half = o.width / 2;
      const edgePad = info.isInterior ? half : (half + tVal);
      const lo = edgePad - ss.posAlong;
      const hi = (info.length - edgePad) - ss.posAlong;
      if (dAlong < lo) dAlong = lo;
      if (dAlong > hi) dAlong = hi;
    }
    // Clamp dVert (windows only): sill ≥ 0 and sill+height ≤ wallH.
    for (const ss of gizmoDrag.startStates) {
      const o = openings[ss.idx];
      if (o.type !== "window") continue;
      const minSill = -ss.sill;
      const maxSill = (wallH - o.height) - ss.sill;
      if (dVert < minSill) dVert = minSill;
      if (dVert > maxSill) dVert = maxSill;
    }
    // Single + along: also resolve collision against neighbour openings.
    if (gizmoDrag.role === "along" && gizmoDrag.startStates.length === 1) {
      const ss = gizmoDrag.startStates[0];
      const o = openings[ss.idx];
      const target = ss.posAlong + dAlong;
      const resolved = resolveOpeningCollision(o.wallIdx, target, o.width, ss.idx);
      dAlong = resolved - ss.posAlong;
    }

    let changed = false;
    for (const ss of gizmoDrag.startStates) {
      const o = openings[ss.idx];
      const newPos = ss.posAlong + dAlong;
      const newSill = (o.type === "window") ? (ss.sill + dVert) : ss.sill;
      if (newPos !== o.posAlong || (o.type === "window" && newSill !== o.sill)) {
        o.posAlong = newPos;
        if (o.type === "window") o.sill = newSill;
        rebuildSingleOpening(ss.idx);
        changed = true;
      }
    }
    if (changed) {
      for (const ss of gizmoDrag.startStates) applySelectionHighlight(ss.idx);
      if (gizmoDrag.startStates.length === 1) {
        const idx = gizmoDrag.startStates[0].idx;
        const o = openings[idx];
        showOpeningDims(info, o.posAlong, o.type,
                        { width: o.width, height: o.height, sill: o.sill }, idx);
        updateInspectorPosition();
      } else {
        hideOpeningDims();
      }
      positionSlideHandle();
      updateDistributePanelPosition();
    }
    return;
  }

  // Opening hover cursor (step 2)
  if (currentStep === 2 && !draggingOpening) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    if (slideHandle.visible) {
      const handleParts = [];
      slideHandle.traverse(c => { if (c.isMesh) handleParts.push(c); });
      const hHits = rc.intersectObjects(handleParts);
      if (hHits.length) {
        // Find the actual arrow mesh inside the hit's sub-group so the
        // project-wide setArrowHover (yellow + 1.3× scale) styles the
        // gimbal arrow the same way as room/ridge/height arrows.
        let node = hHits[0].object;
        let arrowMesh = null;
        while (node && node !== slideHandle) {
          if (node.userData && node.userData.gimbalArrow) {
            arrowMesh = node.userData.gimbalArrow; break;
          }
          node = node.parent;
        }
        setArrowHover(arrowMesh);
        renderer.domElement.style.cursor = "grab";
        return;
      }
      setArrowHover(null);
    }
    const openingMeshes = [];
    openingsGroup.traverse(c => { if (c.isMesh) openingMeshes.push(c); });
    const oHits = rc.intersectObjects(openingMeshes);
    renderer.domElement.style.cursor = oHits.length ? "pointer" : "";
  }

  // Arrow dragging
  if (dragging) {
    const pt = groundHit(e);
    if (!pt) return;
    const sv = snap(dragging.axis === "x" ? pt.x : pt.y);
    const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
    const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);

    let nx0 = x0, nx1 = x1, ny0 = y0, ny1 = y1;
    if (dragging.idx === 0) ny0 = clamp(sv, ny1 - LIM.D_MAX, ny1 - LIM.D_MIN);  // south
    if (dragging.idx === 1) ny1 = clamp(sv, ny0 + LIM.D_MIN, ny0 + LIM.D_MAX);  // north
    if (dragging.idx === 2) nx0 = clamp(sv, nx1 - LIM.W_MAX, nx1 - LIM.W_MIN);  // west
    if (dragging.idx === 3) nx1 = clamp(sv, nx0 + LIM.W_MIN, nx0 + LIM.W_MAX);  // east

    c1 = new THREE.Vector3(nx0, ny0, 0);
    c2 = new THREE.Vector3(nx1, ny1, 0);
    signX = 1; signY = 1;

    clipInteriorWallsToFootprint();
    rebuildScene();

    inW.value = Math.round(nx1 - nx0);
    inD.value = Math.round(ny1 - ny0);
    return;
  }

  // Arrow hover cursor + highlight (footprint step only)
  if (currentStep === 0 && mode === M.SET) {
    const hit = hitArrow(e);
    setArrowHover(hit);
    renderer.domElement.style.cursor = hit ? "grab" : "";
    return;
  }

  if (currentStep !== 0) return;

  const pt = groundHit(e);
  if (!pt) return;
  const s = new THREE.Vector3(snap(pt.x), snap(pt.y), 0);
  moveDot(s);

  if (mode === M.P2 && c1) {
    showGhost(c1, s);
    updateDims(c1, s);
    const w = Math.abs(s.x - c1.x), d = Math.abs(s.y - c1.y);
    tip.style.display = "block";
    tip.style.left = (e.clientX + 18) + "px";
    tip.style.top = (e.clientY - 10) + "px";
    tip.textContent = `${Math.round(w)} × ${Math.round(d)} mm`;
  }
});

renderer.domElement.addEventListener("pointerup", (e) => {
  // Measure tool — commit a click if the cursor didn't drag (separates click
  // from orbit-rotate / pan). Takes precedence over every step-specific path.
  if (measureActive && measurePointerDown) {
    const dx = e.clientX - measurePointerDown.x;
    const dy = e.clientY - measurePointerDown.y;
    measurePointerDown = null;
    if (dx * dx + dy * dy > 25) return;
    const hit3D = measureRaycast(e);
    if (!hit3D) return;
    const snapped = measureSnapAligned(hit3D);
    if (!snapped) return;
    if (measurePoints.length >= 2) measurePoints = [];   // third click starts fresh
    measurePoints.push(snapped);
    drawMeasure();
    return;
  }

  let step0DragEnded = false;
  if (dragging) {
    dragging = null;
    orbit.enabled = true;
    renderer.domElement.style.cursor = "";
    step0DragEnded = true;
  }
  if (draggingRidge) {
    draggingRidge = false;
    orbit.enabled = true;
    renderer.domElement.style.cursor = "";
    pushHistory();
  }
  if (draggingSlopeEdge >= 0) {
    draggingSlopeEdge = -1;
    orbit.enabled = true;
    renderer.domElement.style.cursor = "";
    pushHistory();
  }
  if (draggingRoofOH) {
    draggingRoofOH = null;
    orbit.enabled = true;
    renderer.domElement.style.cursor = "";
    pushHistory();
  }
  if (draggingHeight) {
    draggingHeight = false;
    orbit.enabled = true;
    renderer.domElement.style.cursor = "";
    step0DragEnded = true;
  }
  if (step0DragEnded && currentStep === 0) { pushHistory(); maybeFitExtents(true); }
  if (draggingSlide >= 0) {
    draggingSlide = -1;
    gizmoDrag = null;
    orbit.enabled = true;
    renderer.domElement.style.cursor = "";
    setSlideHandleHover(false);
    pushHistory();
  }

  // ── Free-form footprint (left-click does everything) ──
  // Priority: finish in-progress draw > click an existing wall to select/toggle
  // > start a new wall. The in-progress check wins so the second click of a
  // draw can't accidentally re-select the wall you just landed on.
  if (currentStep === 0 && houseMode === 'free' && ffPointerDown) {
    const dx = e.clientX - ffPointerDown.x;
    const dy = e.clientY - ffPointerDown.y;
    ffPointerDown = null;
    if (dx * dx + dy * dy > 25) return;

    const pt = groundHit(e);
    if (!pt) return;

    if (ffDrawStart) {
      // Finishing an in-progress wall.
      const end = ffConstrainEnd(ffDrawStart, new THREE.Vector3(pt.x, pt.y, 0));
      const len = ffDrawStart.distanceTo(end);
      if (len >= 500) {
        markFrameStale();
        footprintWalls.push({ x0: ffDrawStart.x, y0: ffDrawStart.y, x1: end.x, y1: end.y });
        rebuildScene();
        btnNext.textContent = NEXT_LABELS[0];
        btnNext.style.display = "";
        pushHistory();
      }
      cancelFFDraw();
      return;
    }

    const hitIdx = ffWallAtEvent(e);
    if (hitIdx >= 0) {
      if (selectedFF === hitIdx) deselectFFWall();
      else selectFFWall(hitIdx);
      hideFFHoverHint();
      return;
    }

    // Empty ground → start a new wall. Any lingering selection is cleared.
    deselectFFWall();
    ffDrawStart = ffSnapPoint(new THREE.Vector3(pt.x, pt.y, 0));
    hint.style.display = "none";
    hideFFHoverHint();
    return;
  }

  // ── Interior Walls (left-click does everything) ──
  // Same priority order as free-form above.
  if (currentStep === 1 && iwPointerDown) {
    const dx = e.clientX - iwPointerDown.x;
    const dy = e.clientY - iwPointerDown.y;
    iwPointerDown = null;
    if (dx * dx + dy * dy > 25) return; // moved > 5px → was orbiting

    const pt = groundHit(e);
    if (!pt) return;

    if (iwDrawStart) {
      // Finishing an in-progress wall.
      const end = constrainIWEnd(iwDrawStart, new THREE.Vector3(pt.x, pt.y, 0));
      const len = iwDrawStart.distanceTo(end);
      if (len >= 500) {
        markFrameStale();
        interiorWalls.push({ x0: iwDrawStart.x, y0: iwDrawStart.y, x1: end.x, y1: end.y });
        rebuildInteriorWalls();
        pushHistory();
      }
      cancelIWDraw();
      return;
    }

    // Hit-test an existing interior wall first — click it to select/toggle.
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    rc.setFromCamera(ndc, cam);
    const iwMeshes = [];
    iwGroup.traverse(c => { if (c.isMesh && c.userData.isInteriorWall) iwMeshes.push(c); });
    const iwHits = rc.intersectObjects(iwMeshes);
    if (iwHits.length) {
      const hitIdx = iwHits[0].object.userData.iwIdx;
      if (selectedIW === hitIdx) deselectIW();
      else selectIW(hitIdx);
      hideIWHoverHint();
      return;
    }

    // Empty ground.
    //   If a wall is currently selected, clicking away only exits edit mode —
    //   the next click starts a new wall. One-click-does-both felt too eager.
    //   Otherwise start drawing immediately.
    if (selectedIW >= 0) {
      deselectIW();
      hideIWHoverHint();
      return;
    }
    hideIWHoverHint();
    iwDrawStart = snapIWPoint(new THREE.Vector3(pt.x, pt.y, 0));
  }
});

/* ── Double-click dimension label to edit ── */
const dimEdit = $("dimEdit");
let editingAxis = null;

renderer.domElement.addEventListener("dblclick", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);

  // Opening dim labels (selected state only)
  if (openingDimGroup && selectedOpening >= 0) {
    const oSprites = [];
    openingDimGroup.traverse(c => { if (c.isSprite && c.userData.dimAxis) oSprites.push(c); });
    const oHits = rc.intersectObjects(oSprites);
    if (oHits.length) {
      openOpeningDimEdit(oHits[0].object, e);
      return;
    }
  }

  if (!dimLabels.length) return;
  const hits = rc.intersectObjects(dimLabels);
  if (!hits.length) return;

  const label = hits[0].object;
  editingAxis = label.userData.dimAxis;  // "w" or "d"

  // Project label world pos to screen
  const wp = label.position.clone();
  wp.project(cam);
  const sx = (wp.x * 0.5 + 0.5) * r.width + r.left;
  const sy = (-wp.y * 0.5 + 0.5) * r.height + r.top;

  let curVal, displayStr;
  if (editingAxis === "w") { curVal = Math.abs((c2 || c1).x - c1.x); displayStr = (curVal / 1000).toFixed(2); }
  else if (editingAxis === "d") { curVal = Math.abs((c2 || c1).y - c1.y); displayStr = (curVal / 1000).toFixed(2); }
  else if (editingAxis === "h") { curVal = +inH.value; displayStr = (curVal / 1000).toFixed(2); }
  else if (editingAxis === "kip" || editingAxis === "tagfod") {
    const _x0 = Math.min(c1.x, c2.x), _x1 = Math.max(c1.x, c2.x);
    const _y0 = Math.min(c1.y, c2.y), _y1 = Math.max(c1.y, c2.y);
    const _w = _x1 - _x0, _d = _y1 - _y0;
    const _h = +inH.value, _t = +inT.value, _rT = +inTR.value;
    const _rh = getRidgeH();
    const _hs = (_w >= _d) ? _d / 2 : _w / 2;
    const _s = _rT - _rh * _t / _hs;
    curVal = (editingAxis === "kip") ? (_h + _rh + _s) : (_h + _s);
    displayStr = (curVal / 1000).toFixed(2);
  }
  else if (editingAxis === "slope") {
    const _x0 = Math.min(c1.x, c2.x), _x1 = Math.max(c1.x, c2.x);
    const _y0 = Math.min(c1.y, c2.y), _y1 = Math.max(c1.y, c2.y);
    const _w = _x1 - _x0, _d = _y1 - _y0;
    const _hs = (_w >= _d) ? _d / 2 : _w / 2;
    curVal = Math.atan2(getRidgeH(), _hs) * 180 / Math.PI;
    displayStr = curVal.toFixed(1);
  }

  dimEdit.value = displayStr;
  dimEdit.style.display = "block";
  dimEdit.style.left = (sx - 45) + "px";
  dimEdit.style.top = (sy - 18) + "px";
  dimEdit.focus();
  dimEdit.select();
});

let editingOpeningIdx = -1;

function openOpeningDimEdit(sprite, e) {
  editingAxis = sprite.userData.dimAxis;           // "ow" | "oh" | "os" | "ogL" | "ogR"
  editingOpeningIdx = sprite.userData.openingIdx;
  const o = openings[editingOpeningIdx];
  if (!o) { editingAxis = null; return; }
  let curMM;
  if (editingAxis === "ow") curMM = o.width;
  else if (editingAxis === "oh") curMM = o.height;
  else if (editingAxis === "os") curMM = o.sill;
  else if (editingAxis === "ogL") curMM = Math.max(0, o.posAlong - o.width / 2);
  else if (editingAxis === "ogR") {
    const info = wallInfo(o.wallIdx);
    curMM = info ? Math.max(0, info.length - (o.posAlong + o.width / 2)) : 0;
  }
  dimEdit.value = (curMM / 1000).toFixed(2);
  dimEdit.style.display = "block";
  dimEdit.style.left = (e.clientX - 45) + "px";
  dimEdit.style.top = (e.clientY - 18) + "px";
  dimEdit.focus();
  dimEdit.select();
}

function applyDimEdit() {
  dimEdit.style.display = "none";
  if (!editingAxis) return;

  // Opening dim editing
  if (editingAxis === "ow" || editingAxis === "oh" || editingAxis === "os"
      || editingAxis === "ogL" || editingAxis === "ogR") {
    const val = Math.round(parseFloat(dimEdit.value) * 1000);
    const axis = editingAxis;
    const idx = editingOpeningIdx;
    editingAxis = null; editingOpeningIdx = -1;
    if (!isFinite(val) || idx < 0) return;
    const o = openings[idx];
    if (!o) return;
    if (axis === "ow" && val >= 200 && val <= 6000) o.width = val;
    else if (axis === "oh" && val >= 200 && val <= 4000) o.height = val;
    else if (axis === "os" && val >= 0 && val <= 3000) o.sill = val;
    else if (axis === "ogL" || axis === "ogR") {
      if (val < 0) return;
      const info = wallInfo(o.wallIdx);
      if (!info) return;
      const tW = +inT.value;
      const half = o.width / 2;
      const edgePad = info.isInterior ? half : (half + tW);
      const minPos = edgePad;
      const maxPos = info.length - edgePad;
      if (maxPos < minPos) return;
      const desired = axis === "ogL" ? (val + half) : (info.length - val - half);
      o.posAlong = Math.max(minPos, Math.min(maxPos, desired));
    }
    else return;
    rebuildSingleOpening(idx);
    if (selectedOpening === idx) {
      const info = wallInfo(o.wallIdx);
      if (info) {
        showOpeningDims(info, o.posAlong, o.type, { width: o.width, height: o.height, sill: o.sill }, idx);
        updateInspectorPosition();
      }
    }
    return;
  }

  if (!c1 || !c2) return;

  // Roof dim edits (kip / tagfod / slope)
  if (editingAxis === "kip" || editingAxis === "tagfod" || editingAxis === "slope") {
    const raw = parseFloat(dimEdit.value);
    const axis = editingAxis;
    editingAxis = null;
    if (!isFinite(raw)) return;
    const _x0 = Math.min(c1.x, c2.x), _x1 = Math.max(c1.x, c2.x);
    const _y0 = Math.min(c1.y, c2.y), _y1 = Math.max(c1.y, c2.y);
    const _w = _x1 - _x0, _d = _y1 - _y0;
    const _h = +inH.value, _t = +inT.value, _rT = +inTR.value;
    const _hs = (_w >= _d) ? _d / 2 : _w / 2;
    let newRH;
    if (axis === "slope") {
      const deg = Math.max(1, Math.min(45, raw));
      newRH = _hs * Math.tan(deg * Math.PI / 180);
    } else if (axis === "kip") {
      const kipZ = raw * 1000;
      if (_hs - _t <= 0) return;
      newRH = (kipZ - _h - _rT) * _hs / (_hs - _t);
    } else { // tagfod
      const tagZ = raw * 1000;
      if (_t <= 0) return;
      newRH = (_h + _rT - tagZ) * _hs / _t;
    }
    if (!isFinite(newRH)) return;
    // Clamp so the resulting slope is within 1°–45°.
    const minRH = _hs * Math.tan(LIM.SLOPE_MIN_DEG * Math.PI / 180);
    const maxRH = _hs * Math.tan(LIM.SLOPE_MAX_DEG * Math.PI / 180);
    customRidgeH = clamp(Math.round(newRH), Math.max(LIM.RIDGE_MIN, minRH), maxRH);
    markFrameStale();
    rebuildScene();
    return;
  }

  const rawVal = parseFloat(dimEdit.value) * 1000;
  if (!isFinite(rawVal)) return;
  const clamped = editingAxis === "w" ? clamp(rawVal, LIM.W_MIN, LIM.W_MAX)
                : editingAxis === "d" ? clamp(rawVal, LIM.D_MIN, LIM.D_MAX)
                : editingAxis === "h" ? clamp(rawVal, LIM.H_MIN, LIM.H_MAX)
                : rawVal;
  const val = clamped;

  const x0 = Math.min(c1.x, c2.x), y0 = Math.min(c1.y, c2.y);
  if (editingAxis === "w") {
    c2 = new THREE.Vector3(x0 + val, c2.y, 0);
    c1 = new THREE.Vector3(x0, c1.y, 0);
    signX = 1;
    inW.value = Math.round(val);
  } else if (editingAxis === "d") {
    c2 = new THREE.Vector3(c2.x, y0 + val, 0);
    c1 = new THREE.Vector3(c1.x, y0, 0);
    signY = 1;
    inD.value = Math.round(val);
  } else if (editingAxis === "h") {
    inH.value = Math.round(val);
  }
  editingAxis = null;
  markFrameStale();
  rebuildScene();
}

dimEdit.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyDimEdit();
  if (e.key === "Escape") { dimEdit.style.display = "none"; editingAxis = null; }
});
dimEdit.addEventListener("blur", applyDimEdit);

document.addEventListener("keydown", (e) => {
  if (e.key === "Shift" && currentStep === 0 && houseMode === 'free') ffShiftHeld = true;
  if (e.key === "Escape") {
    // Escape cancels the current action only — never wipes the house. Priority:
    //   any active tool > in-progress draw > active selection > no-op.
    if (measureActive) {
      setMeasureActive(false);
      return;
    }
    // Opening drag (Window/Door tile active): abort the drag, drop the ghost,
    // and release the tile highlight — no opening gets placed.
    if (draggingOpening) {
      draggingOpening = null;
      if (ghostOpening) { scene.remove(ghostOpening); ghostOpening = null; }
      hideOpeningDims();
      dragGhost.style.display = "none";
      document.querySelectorAll(".tool-item.active").forEach(t => t.classList.remove("active"));
      renderer.domElement.style.cursor = "";
      return;
    }
    if (currentStep === 0 && houseMode === 'box' && mode === M.P2) {
      // First corner placed, waiting for second — drop c1 and the ghost.
      c1 = null;
      mode = M.P1;
      if (ghostGroup) { scene.remove(ghostGroup); ghostGroup = null; }
      hint.classList.add("small");
      hint.innerHTML = "Click to place your house";
      return;
    }
    if (currentStep === 0 && houseMode === 'free' && ffDrawStart) {
      cancelFFDraw();
      return;
    }
    if (currentStep === 1 && iwDrawStart) {
      cancelIWDraw();
      hint.classList.add("small");
      hint.innerHTML = "Click empty space to draw • Click a wall to edit";
      return;
    }
    if (selectedOpening >= 0) { deselectOpening(); return; }
    if (currentStep === 0 && houseMode === 'free' && selectedFF >= 0) {
      deselectFFWall();
      return;
    }
    if (currentStep === 1 && selectedIW >= 0) {
      deselectIW();
      return;
    }
    // Nothing in progress, nothing selected — do nothing.
  }
  if (e.key === "Delete" && currentStep === 2 && selectedOpening >= 0) {
    const idx = selectedOpening;
    deselectOpening();
    removeOpeningByIdx(idx);
    rebuildScene();
    pushHistory();
  }
  // Interior wall: Delete to remove selected (Escape handled above)
  if (e.key === "Delete" && currentStep === 1 && selectedIW >= 0) {
    deleteSelectedIW();
  }
  if (e.key === "Delete" && currentStep === 0 && houseMode === 'free' && selectedFF >= 0) {
    deleteSelectedFF();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.key === "Shift") ffShiftHeld = false;
});

$("btnDeleteIW").addEventListener("click", deleteSelectedIW);
$("btnDeleteFF").addEventListener("click", deleteSelectedFF);
$("btnDistributeOpenings").addEventListener("click", distributeSelectedOpenings);
$("btnCenterOpenings").addEventListener("click", centerSelectedOpenings);

// Copy: click to enter copy mode (cursor follows ghost, ghost previews on
// any wall under the cursor). Click on a wall to place the copy and exit;
// click the Copy button again or press Escape to cancel.
$("btnCopyOpening").addEventListener("click", (e) => {
  if (e.currentTarget.disabled) return;
  e.preventDefault();
  // Already in copy mode? Toggle off.
  if (draggingOpening && draggingOpening.copyDims) {
    draggingOpening = null;
    if (ghostOpening) { scene.remove(ghostOpening); ghostOpening = null; }
    hideOpeningDims();
    dragGhost.style.display = "none";
    return;
  }
  const indices = selectedOpeningIndices();
  if (indices.length !== 1) return;
  const o = openings[indices[0]];
  if (typeof measureActive !== "undefined" && measureActive) setMeasureActive(false);
  draggingOpening = {
    type: o.type,
    copyDims: { width: o.width, height: o.height, sill: o.sill },
  };
  document.querySelectorAll(".tool-item").forEach(t => t.classList.remove("active"));
  dragGhost.innerHTML = GHOST_SVGS[o.type];
  dragGhost.style.display = "block";
  dragGhost.style.left = e.clientX + "px";
  dragGhost.style.top = e.clientY + "px";
});
$("btnDismissScaleWorker").addEventListener("click", dismissScaleWorker);

function setIwToRidge(v) {
  iwToRidge = !!v;
  $("inIwToRidge").checked = iwToRidge;
  $("inIwToRidgeRoof").checked = iwToRidge;
  markFrameStale();
  rebuildInteriorWalls();
}
$("inIwToRidge").addEventListener("change", e => { setIwToRidge(e.target.checked); pushHistory(); });
$("inIwToRidgeRoof").addEventListener("change", e => { setIwToRidge(e.target.checked); pushHistory(); });

for (const inp of [inW, inD, inH]) inp.addEventListener("input", rebuildRoom);
// Clamp direct typing on blur/change so HTML max caps are enforced in code.
inW.addEventListener("change", () => { inW.value = Math.round(clamp(+inW.value || LIM.W_MIN, LIM.W_MIN, LIM.W_MAX)); rebuildRoom(); pushHistory(); });
inD.addEventListener("change", () => { inD.value = Math.round(clamp(+inD.value || LIM.D_MIN, LIM.D_MIN, LIM.D_MAX)); rebuildRoom(); pushHistory(); });
inH.addEventListener("change", () => { inH.value = Math.round(clamp(+inH.value || LIM.H_MIN, LIM.H_MIN, LIM.H_MAX)); rebuildRoom(); pushHistory(); });
inT.addEventListener("change", () => { rebuildRoom(); pushHistory(); });
inTI.addEventListener("change", () => { markFrameStale(); rebuildInteriorWalls(); if (selectedIW >= 0) { const prev = selectedIW; deselectIW(); selectIW(prev); } pushHistory(); });
inTR.addEventListener("change", () => { rebuildRoom(); if (roofGroup) { buildRoof(); positionRoofArrows(); } pushHistory(); });

// Opening inspector inputs
$("oInspW").addEventListener("input", () => {
  if (selectedOpening < 0) return;
  const raw = parseInt($("oInspW").value);
  if (!raw || raw < 200) return;
  const o = openings[selectedOpening];
  const maxW = Math.floor(maxAllowedWidth(o.wallIdx, o.posAlong, selectedOpening));
  o.width = Math.min(raw, Math.max(200, maxW));
  rebuildSingleOpening(selectedOpening);
});
$("oInspW").addEventListener("change", () => {
  if (selectedOpening < 0) return;
  $("oInspW").value = openings[selectedOpening].width;
});
$("oInspH").addEventListener("input", () => {
  if (selectedOpening < 0) return;
  const v = parseInt($("oInspH").value);
  if (!v || v < 200) return;
  openings[selectedOpening].height = v;
  rebuildSingleOpening(selectedOpening);
});
$("oInspSill").addEventListener("input", () => {
  if (selectedOpening < 0) return;
  const v = parseInt($("oInspSill").value);
  if (isNaN(v) || v < 0) return;
  openings[selectedOpening].sill = v;
  rebuildSingleOpening(selectedOpening);
});
$("btnDeleteOpening").addEventListener("click", () => {
  const indices = selectedOpeningIndices();
  if (!indices.length) return;
  // Sort descending so removing by index doesn't shift the indices we still
  // need to remove.
  const sorted = indices.slice().sort((a, b) => b - a);
  // Tear down selection state before removing — both single and multi paths
  // poke at openings[selectedOpening] / multiSelected and would otherwise
  // dereference the just-removed entries.
  deselectOpening();
  if (multiSelected.length) clearMultiSelection();
  for (const i of sorted) removeOpeningByIdx(i);
  rebuildScene();
  pushHistory();
});

// Step tab clicks — goToStep (case 4) handles cache vs. regenerate.
for (let i = 0; i < 5; i++) {
  stepEls[i].addEventListener("click", () => {
    if (!c1 || !c2 || mode !== M.SET) return;
    goToStep(i);
  });
}

/* ────────────────── measure tool ──────────────────
   A two-click ruler. Active state → first ground click seeds a start point,
   second click completes the measurement and shows the distance. A third click
   starts fresh (completed measurement is replaced). Esc or clicking the button
   again exits and clears. Snaps to existing nodes (exterior corners, interior
   wall endpoints, free-form endpoints) before falling back to a coarse grid.
*/
let measureActive = false;
let measurePoints = [];          // THREE.Vector3[]  — 0, 1, or 2 committed points
let measurePointerDown = null;   // {x,y} screen — click-vs-drag
const measureGroup = new THREE.Group();
measureGroup.renderOrder = 996;
scene.add(measureGroup);

function clearMeasureVisuals() {
  while (measureGroup.children.length) {
    const c = measureGroup.children[0];
    measureGroup.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material && c.material.dispose && !c.material.isBuiltIn) c.material.dispose();
  }
}

// Raycast from the cursor into the scene. Prefers hitting actual geometry
// (walls, roof) so top-of-wall snaps work in perspective; falls back to the
// infinite ground plane when nothing is under the cursor.
function measureRaycast(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  rc.setFromCamera(ndc, cam);
  const targets = [];
  if (roomGroup)  roomGroup.traverse(c => { if (c.isMesh) targets.push(c); });
  if (iwGroup)    iwGroup.traverse(c => { if (c.isMesh) targets.push(c); });
  if (roofGroup)  roofGroup.traverse(c => { if (c.isMesh) targets.push(c); });
  if (frameGroup) frameGroup.traverse(c => { if (c.isMesh) targets.push(c); });
  const hits = rc.intersectObjects(targets, false);
  if (hits.length) return hits[0].point.clone();
  const gp = groundHit(e);
  return gp ? new THREE.Vector3(gp.x, gp.y, 0) : null;
}

// 3D snap: corner > edge > raw hit. Candidate corners include bottom AND top
// of every wall (box, interior, free-form) so vertical measurements lock on
// the way the horizontal ones do. Edges cover all four edges of each wall
// rectangle (bottom/top horizontals + two verticals). Ranking uses raw 3D
// distance to the raycast hit — in top view the z=0 candidates naturally win
// (since the hit is at z=0), in perspective the candidate physically closest
// to the wall face the user pointed at wins.
function measureSnap(hit3D) {
  if (!hit3D) return null;
  const h = +inH.value;
  const corners = [];
  const edges = [];   // [Vector3, Vector3]

  const addRectSnapset = (pts2d) => {
    // pts2d = [[x,y] x4] in CCW/CW order. Adds 8 corners + 4 bot/top edges + 4 verticals.
    for (const z of [0, h]) {
      for (const [x, y] of pts2d) corners.push(new THREE.Vector3(x, y, z));
      for (let i = 0; i < 4; i++) {
        const a = pts2d[i], b = pts2d[(i + 1) % 4];
        edges.push([new THREE.Vector3(a[0], a[1], z), new THREE.Vector3(b[0], b[1], z)]);
      }
    }
    for (const [x, y] of pts2d) edges.push([new THREE.Vector3(x, y, 0), new THREE.Vector3(x, y, h)]);
  };
  const addWallSnapset = (x0, y0, x1, y1) => {
    for (const z of [0, h]) {
      corners.push(new THREE.Vector3(x0, y0, z), new THREE.Vector3(x1, y1, z));
      edges.push([new THREE.Vector3(x0, y0, z), new THREE.Vector3(x1, y1, z)]);
    }
    edges.push([new THREE.Vector3(x0, y0, 0), new THREE.Vector3(x0, y0, h)]);
    edges.push([new THREE.Vector3(x1, y1, 0), new THREE.Vector3(x1, y1, h)]);
  };

  if (c1 && c2) {
    const x0 = Math.min(c1.x, c2.x), x1 = Math.max(c1.x, c2.x);
    const y0 = Math.min(c1.y, c2.y), y1 = Math.max(c1.y, c2.y);
    const t = +inT.value;
    addRectSnapset([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);                     // outer face rect
    addRectSnapset([[x0 + t, y0 + t], [x1 - t, y0 + t], [x1 - t, y1 - t], [x0 + t, y1 - t]]);  // inner face rect
  }
  for (const w of footprintWalls) addWallSnapset(w.x0, w.y0, w.x1, w.y1);
  for (const iw of interiorWalls) addWallSnapset(iw.x0, iw.y0, iw.x1, iw.y1);

  // Roof corners — extracted from whatever mesh is currently in roofGroup
  // (flat, sloped-flat, or gable; any future type works automatically). Only
  // when the roof is actually visible so we don't snap to stale geometry.
  if (roofGroup && roofGroup.visible) {
    roofGroup.traverse(c => {
      if (!c.isMesh) return;
      const pos = c.geometry && c.geometry.attributes && c.geometry.attributes.position;
      if (!pos) return;
      c.updateMatrixWorld();
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld);
        corners.push(v.clone());
      }
    });
  }

  // Frame-member corners — every vertex of every generated stud/plate/beam is
  // a snap candidate. Only active while the frame is actually visible so we
  // don't snap into invisible stale geometry from a prior generate.
  const frameOn = frameGroup && frameGroup.visible && frameVertices.length;

  // Screen-aware radii (world mm). worldPerPixel is measured at orbit.target
  // which lives near the floor; good enough for the whole scene at normal zoom.
  const wpp = worldPerPixel();
  const cornerR = Math.max(500, 40 * wpp);
  const edgeR   = Math.max(300, 22 * wpp);

  // 1 — corners (design geometry)
  let bestC = null, bestCD = cornerR;
  for (const v of corners) {
    const d = v.distanceTo(hit3D);
    if (d < bestCD) { bestCD = d; bestC = v; }
  }
  // 1b — corners (frame vertices). Kept in the same radius/priority bucket.
  if (frameOn) {
    for (const v of frameVertices) {
      const d = v.distanceTo(hit3D);
      if (d < bestCD) { bestCD = d; bestC = v; }
    }
  }
  if (bestC) {
    const out = bestC.clone();
    out.snapped = true;
    return out;
  }

  // 2 — edges (closest point on a 3D segment)
  let bestE = null, bestED = edgeR;
  for (const [a, b] of edges) {
    const ab = b.clone().sub(a);
    const len2 = ab.lengthSq();
    if (len2 < 1) continue;
    const ap = hit3D.clone().sub(a);
    let u = ap.dot(ab) / len2;
    u = Math.max(0, Math.min(1, u));
    const proj = a.clone().add(ab.multiplyScalar(u));
    const d = proj.distanceTo(hit3D);
    if (d < bestED) { bestED = d; bestE = proj; }
  }
  if (bestE) {
    bestE.snapped = true;
    return bestE;
  }

  // 3 — fall back to the raw raycast hit (un-snapped cursor).
  const out = hit3D.clone();
  out.snapped = false;
  return out;
}

// Soft ortho alignment for the live measurement direction. When the user's
// second point lands on free space (un-snapped) and the line A→B is within a
// few degrees of a world axis or the horizontal plane, we nudge B onto the
// cleaner direction. Hard snaps (corner/edge hits) take priority and bypass
// this — we respect deliberate intent. "Soft" = only engages inside the
// tolerance band, so the cursor still roams freely when off-axis.
function softOrtho(A, B) {
  const v = B.clone().sub(A);
  const len = v.length();
  if (len < 50) return null;
  const AXIS_TOL  = Math.sin(4 * Math.PI / 180);   // ±4° for a cardinal axis
  const PLANE_TOL = Math.sin(5 * Math.PI / 180);   // ±5° for the horizontal plane

  // Pure X axis (same Y, same Z as A)
  if (Math.hypot(v.y, v.z) / len < AXIS_TOL) {
    const out = new THREE.Vector3(B.x, A.y, A.z);
    out.snapped = true;
    return out;
  }
  // Pure Y axis
  if (Math.hypot(v.x, v.z) / len < AXIS_TOL) {
    const out = new THREE.Vector3(A.x, B.y, A.z);
    out.snapped = true;
    return out;
  }
  // Plumb (Z axis)
  if (Math.hypot(v.x, v.y) / len < AXIS_TOL) {
    const out = new THREE.Vector3(A.x, A.y, B.z);
    out.snapped = true;
    return out;
  }
  // Horizontal plane (parallel to ground)
  if (Math.abs(v.z) / len < PLANE_TOL) {
    const out = new THREE.Vector3(B.x, B.y, A.z);
    out.snapped = true;
    return out;
  }
  return null;
}

// Wrap measureSnap with the soft-ortho pass. Applies only when we have a
// committed first point and the second point is un-snapped.
function measureSnapAligned(hit3D) {
  const s = measureSnap(hit3D);
  if (!s || s.snapped || measurePoints.length !== 1) return s;
  const o = softOrtho(measurePoints[0], s);
  return o || s;
}

const measureLineMat = new THREE.LineBasicMaterial({ color: 0xF9BC06, depthTest: false, transparent: true, opacity: 0.95 });
const measureDotMat = new THREE.MeshBasicMaterial({ color: 0xF9BC06, depthTest: false });
const MEASURE_DOT_RADIUS = 28;           // geometry radius for committed markers
const MEASURE_DOT_TARGET_PX = 13;        // target pixel radius at close zoom
function measureDotZoomScaleAt(pos) {
  const t = Math.min(MEASURE_DOT_RADIUS, MEASURE_DOT_TARGET_PX * worldPerPixelAt(pos));
  return t / MEASURE_DOT_RADIUS;
}
function drawMeasure(hoverPt) {
  clearMeasureVisuals();
  const pts = [...measurePoints];
  if (hoverPt && pts.length === 1) pts.push(hoverPt);
  if (!pts.length) return;

  // Spherical "committed" markers — visible from any angle, unlike the
  // flat circles they used to be. Only the committed points get markers;
  // the live-preview end follows the roving snap sphere (the shared `dot`).
  // Tagged so the render loop can rescale them with zoom, same as the dot.
  for (const p of measurePoints) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(MEASURE_DOT_RADIUS, 20, 16), measureDotMat);
    m.position.set(p.x, p.y, (p.z !== undefined ? p.z : 0));
    m.renderOrder = 997;
    m.userData.zoomDot = true;
    measureGroup.add(m);
  }
  if (pts.length === 2) {
    const [a, b] = pts;
    const az = a.z !== undefined ? a.z : 0;
    const bz = b.z !== undefined ? b.z : 0;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.x, a.y, az),
      new THREE.Vector3(b.x, b.y, bz),
    ]);
    const line = new THREE.Line(geo, measureLineMat);
    line.renderOrder = 997;
    measureGroup.add(line);
    const dist = Math.hypot(b.x - a.x, b.y - a.y, bz - az);   // true 3D distance
    if (dist > 50) {
      const label = makeTextSprite((dist / 1000).toFixed(2) + " m", "#F9BC06", 44, "rgba(40, 40, 40, 0.82)");
      label.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, ((az + bz) / 2) + 120);
      label.renderOrder = 998;
      measureGroup.add(label);
    }
  }
}

function setMeasureActive(on) {
  measureActive = on;
  $("toolMeasure").classList.toggle("active", on);
  measurePoints = [];
  measurePointerDown = null;
  clearMeasureVisuals();
  if (on) {
    // Measure is mutually exclusive with every other tool — kill any active
    // drag, selection, or highlighted tile so the canvas is clean for the
    // two-click ruler. Individual tools' handlers also call
    // setMeasureActive(false) before they activate, keeping the exclusion
    // symmetric.
    activeTool = null;
    document.querySelectorAll(".tool-item.active").forEach(t => {
      if (t.id !== "toolMeasure") t.classList.remove("active");
    });
    if (draggingOpening) {
      draggingOpening = null;
      if (ghostOpening) { scene.remove(ghostOpening); ghostOpening = null; }
      dragGhost.style.display = "none";
    }
    deselectIW();
    deselectOpening();
    clearMultiSelection();
    renderer.domElement.style.cursor = "crosshair";
    hint.classList.add("small");
    hint.style.display = "";
    hint.innerHTML = "Click two points to measure • Esc to exit";
  } else {
    // Hand cursor state back to whatever the current step expects.
    hideDot();
    renderer.domElement.style.cursor = "";
  }
}

$("toolMeasure").addEventListener("click", () => {
  setMeasureActive(!measureActive);
});

// Openings drag-and-drop from tool panel
const dragGhost = $("dragGhost");
const GHOST_SVGS = {
  window: '<svg viewBox="0 0 40 40" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round"><rect x="5" y="8" width="30" height="24" rx="2"/><line x1="20" y1="8" x2="20" y2="32"/><line x1="5" y1="20" x2="35" y2="20"/></svg>',
  door: '<svg viewBox="0 0 40 40" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round"><rect x="8" y="4" width="24" height="32" rx="2"/><circle cx="27" cy="22" r="2" fill="white" stroke="none"/></svg>',
};

document.querySelectorAll('.tool-item[data-tool="window"], .tool-item[data-tool="door"]').forEach(el => {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (measureActive) setMeasureActive(false);   // Measure + drag-tool are mutually exclusive
    const tool = el.dataset.tool;
    draggingOpening = { type: tool };
    activeTool = null;
    document.querySelectorAll(".tool-item").forEach(t => t.classList.remove("active"));
    el.classList.add("active");
    // Show cursor ghost
    dragGhost.innerHTML = GHOST_SVGS[tool];
    dragGhost.style.display = "block";
    dragGhost.style.left = e.clientX + "px";
    dragGhost.style.top = e.clientY + "px";
  });
});

// Roof type selection. Clicking the currently-active tile toggles it OFF
// (roofType = "none") so users who want walls only can opt out of a roof.
document.querySelectorAll(".roof-option").forEach(el => {
  el.addEventListener("click", () => {
    if (measureActive) setMeasureActive(false);
    markFrameStale();
    roofType = (roofType === el.dataset.roof) ? "none" : el.dataset.roof;
    if (roofType === "gable") flatSlopeH = [0, 0];
    if (roofType === "none") { eaveOH = 0; gableOH = 0; }
    document.querySelectorAll(".roof-option").forEach(o => o.classList.toggle("active", o.dataset.roof === roofType));
    $("roofIwToRidgeRow").style.display = roofType === "gable" ? "" : "none";
    // Thickness panel is only meaningful when there's a roof to thicken.
    roofPanel.classList.toggle("open", currentStep === 3 && roofType !== "none");
    rebuildScene();
    pushHistory();
  });
});

function enterSet() {
  mode = M.SET;
  currentStep = 0;
  setStep(0);
  tip.style.display = "none";
  hideDot();
  panel.classList.add("open");
  btnUndo.style.display = "";
  btnRedo.style.display = "";
  updateUndoRedoButtons();
  btnNext.textContent = NEXT_LABELS[0];
  btnNext.style.display = "";
  orbit.enabled = true;
  renderer.domElement.style.cursor = "";
  hint.classList.add("small");
  hint.innerHTML = "Drag arrows or edit dimensions";

  // Frame the room in view
  const cx = (c1.x + c2.x) / 2;
  const cy = (c1.y + c2.y) / 2;
  orbit.target.set(cx, cy, (+inH.value) / 3);

  undoStack.length = 0; histIdx = -1;
  pushHistory();
}

function loadExample() {
  // Pre-built example: 7m x 5m house with a door and two windows
  c1 = new THREE.Vector3(0, 0, 0);
  c2 = new THREE.Vector3(7000, 5000, 0);
  signX = 1; signY = 1;
  inW.value = 7000; inD.value = 5000; inH.value = 2400; inT.value = 195; inTI.value = 120; inTR.value = 295;
  roofType = "none";
  placeRoom();
  placeOpening(0, 3500, "door");
  placeOpening(2, 1200, "window");
  placeOpening(3, 1200, "window");
  rebuildWalls();
  // Mark step 0 as visited so it won't show the intro hint
  stepVisited[0] = true;
  enterSet();
  $("exampleLink").style.display = "none";
}

$("loadExample").addEventListener("click", (e) => {
  e.preventDefault();
  loadExample();
});

function startDrawing() {
  if (isTopView) disableTopView();
  deselectOpening();
  if (ghostGroup) { scene.remove(ghostGroup); ghostGroup = null; }
  if (roomGroup)  { scene.remove(roomGroup);  roomGroup = null; }
  if (frameGroup) { scene.remove(frameGroup); frameGroup = null; }
  frameVertices = [];
  if (roofGroup)  { scene.remove(roofGroup);  roofGroup = null; }
  markFrameStale();
  clearOpenings();
  interiorWalls.length = 0;
  while (iwGroup.children.length) iwGroup.remove(iwGroup.children[0]);
  cancelIWDraw();
  selectedIW = -1;
  // Free-form reset
  footprintWalls.length = 0;
  cancelFFDraw();
  selectedFF = -1;
  $("ffInspector").style.display = "none";
  houseMode = 'box';
  houseTypePicked = false;
  housePicker.style.display = "";  // re-show picker to let user choose again
  $("rowW").style.display = "";
  $("rowD").style.display = "";
  hideArrows();
  hideDims();
  dimEdit.style.display = "none"; editingAxis = null;
  c1 = c2 = null;
  mode = M.P1;
  scaleWorkerDismissed = false;
  currentStep = 0;
  setStep(0);
  stepVisited.fill(false);
  stepVisited[0] = true;  // footprint intro is the default view
  roofType = "none";
  customRidgeH = null;
  flatSlopeH = [0, 0];
  eaveOH = 0;
  gableOH = 0;
  activeTool = null;
  tip.style.display = "none";
  panel.classList.remove("open");
  roofPanel.classList.remove("open");
  $("iwPanel").classList.remove("open");
  btnUndo.style.display = "none";
  btnRedo.style.display = "none";
  btnNext.style.display = "none";
  $("btnTopView").style.display = "flex";
  orbit.enabled = false;
  renderer.domElement.style.cursor = "crosshair";
  hint.classList.remove("small");
  hint.innerHTML = "";
}

/* ────────────────── resize / loop ────────────────── */
function onResize() {
  const w = vp.clientWidth, h = vp.clientHeight;
  renderer.setSize(w, h);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
}
window.addEventListener("resize", onResize);
onResize();

(function loop() {
  requestAnimationFrame(loop);
  orbit.update();
  updateInspectorPosition();
  positionFFInspector();
  positionIWInspector();
  updateDistributePanelPosition();
  // Keep the snap sphere + committed measurement markers looking consistent
  // in screen space as the user zooms — shrink when zoomed in, cap at the
  // geometry radius when zoomed way out.
  if (dot.visible) applyDotScale();
  if (measureGroup.children.length) {
    measureGroup.traverse(c => {
      if (c.userData && c.userData.zoomDot) {
        const ms = measureDotZoomScaleAt(c.position);
        c.scale.set(ms, ms, ms);
      }
    });
  }
  if (scaleWorker) {
    tickScaleWorkerWalk();
    tickScaleWorkerRestage();
    tickWorkerSpin();
    scaleWorker.visible = scaleWorkerShouldShow();
    if (scaleWorker.visible) {
      const dx = cam.position.x - scaleWorker.position.x;
      const dy = cam.position.y - scaleWorker.position.y;
      scaleWorker.rotation.z = Math.atan2(dx, -dy) + workerSpinOffset;
    }
    updateScaleWorkerPill();
    updateScaleWorkerSpeechPosition();
  }
  for (const a of VERTICAL_ARROWS) {
    if (!a.visible) continue;
    const dx = cam.position.x - a.position.x;
    const dy = cam.position.y - a.position.y;
    a.rotation.z = Math.atan2(dx, -dy);
  }
  updateAxisGizmo();
  renderer.render(scene, cam);
})();

/* ────────────────── auth + saved projects ────────────────── */
(function setupAccounts() {
  const veil       = $("loginVeil");
  const loginName  = $("loginName");
  const loginPw    = $("loginPw");
  const loginErr   = $("loginError");
  const loginBtn   = $("loginBtn");
  const userPill   = $("userPill");
  const userName   = $("userName");
  const userProj   = $("userProj");
  const userMenu   = $("userMenu");
  const projPanel  = $("projectsPanel");
  const projList   = $("projectsList");
  const projNameIn = $("projectName");
  const btnSave    = $("btnSaveProject");
  const btnSaveAs  = $("btnSaveAsProject");
  const btnSaveTop = $("btnSaveTop");
  const btnSaveTopLabel = $("btnSaveTopLabel");

  let currentUser = null;
  let currentProjectId = null;
  let currentProjectName = null;
  let projectDirty = false;
  // When a guest clicks Save (or hits Ctrl+S) the modal pops with a save
  // intent; on successful sign-up we resume the save automatically.
  let pendingActionAfterLogin = null;

  function showLogin(intent) {
    const titleEl = document.getElementById("loginTitle");
    const subEl = document.getElementById("loginSub");
    if (intent === "save") {
      if (titleEl) titleEl.textContent = "Save your design";
      if (subEl) subEl.textContent = "Pick a name and password to keep this design.";
    } else {
      if (titleEl) titleEl.textContent = "Welcome to FrameAI";
      if (subEl) subEl.textContent = "New here? Just pick a name and password.";
    }
    loginErr.textContent = "";
    veil.classList.add("open");
    setTimeout(() => loginName.focus(), 30);
  }
  function hideLogin() { veil.classList.remove("open"); }

  function refreshPill() {
    // Save button is always available — guests get prompted to sign up when
    // they click it. The dirty highlight signals "click to save" most loudly
    // when there are unsaved edits, and stays subtle otherwise.
    btnSaveTop.classList.add("shown");
    userPill.classList.add("shown");
    if (!currentUser) {
      userName.textContent = "Sign in";
      userProj.style.display = "none";
      userProj.textContent = "";
      userPill.classList.add("guest");
      btnSaveTop.classList.toggle("dirty", projectDirty);
      btnSaveTopLabel.textContent = "Save design";
      return;
    }
    userPill.classList.remove("guest");
    userName.textContent = currentUser.name;
    if (currentProjectName) {
      userProj.style.display = "";
      userProj.textContent = currentProjectName;
      userProj.classList.toggle("dirty", projectDirty);
    } else {
      userProj.style.display = "none";
      userProj.textContent = "";
    }
    btnSaveTop.classList.toggle("dirty", projectDirty || !currentProjectId);
    btnSaveTopLabel.textContent = currentProjectId ? "Save" : "Save design";
  }

  function setCurrentProject(id, name) {
    currentProjectId = id;
    currentProjectName = name;
    projectDirty = false;
    if (projNameIn) projNameIn.value = name || "";
    refreshPill();
  }

  function markDirty() {
    if (!currentUser) return;
    if (!projectDirty) {
      projectDirty = true;
      refreshPill();
    }
  }
  // Any edit that pushes onto the undo stack is also a "design changed since
  // last save" event — wrap pushHistory so we don't have to sprinkle calls.
  // Skip when applyingHistory is true so loading a project / undo / redo does
  // not flip the dirty flag. Reassigning the outer function binding works
  // because `function pushHistory()` declarations are mutable bindings.
  if (typeof pushHistory === "function") {
    const _orig = pushHistory;
    pushHistory = function () {
      if (typeof applyingHistory === "undefined" || !applyingHistory) markDirty();
      return _orig.apply(this, arguments);
    };
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, opts || {}));
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-json error */ }
    return { ok: res.ok, status: res.status, json: json || {} };
  }

  async function init() {
    const r = await api("/api/auth/me");
    if (r.ok && r.json.user) {
      currentUser = r.json.user;
    }
    // Guests aren't prompted — they can play around freely. The login modal
    // pops only when they try to save.
    refreshPill();
  }

  async function doLogin() {
    const name = (loginName.value || "").trim();
    const pw = loginPw.value || "";
    if (!name || !pw) { loginErr.textContent = "Name and password required."; return; }
    loginBtn.disabled = true;
    loginErr.textContent = "";
    const r = await api("/api/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ name, password: pw }),
    });
    loginBtn.disabled = false;
    if (!r.ok) {
      loginErr.textContent = r.json.error || ("Sign-in failed (" + r.status + ").");
      return;
    }
    currentUser = r.json.user;
    loginPw.value = "";
    loginErr.textContent = "";
    hideLogin();
    refreshPill();
    // If the modal was opened to gate a Save action, finish that action now.
    if (pendingActionAfterLogin === "save") {
      pendingActionAfterLogin = null;
      saveCurrentDesign({ promptIfNeeded: true });
    } else {
      pendingActionAfterLogin = null;
    }
  }

  loginBtn.addEventListener("click", doLogin);
  loginName.addEventListener("keydown", (e) => { if (e.key === "Enter") loginPw.focus(); });
  loginPw.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("loginClose").addEventListener("click", () => {
    pendingActionAfterLogin = null;
    hideLogin();
  });

  // ── User menu ──
  userPill.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!currentUser) {
      showLogin();
      return;
    }
    userMenu.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!userMenu.contains(e.target) && !userPill.contains(e.target)) {
      userMenu.classList.remove("open");
    }
    if (!projPanel.contains(e.target) && !userPill.contains(e.target) &&
        !userMenu.contains(e.target)) {
      // leave panel open when clicking anywhere inside it; only close on outside
      // clicks via the explicit X-pattern below if added later. For now keep open
      // until user explicitly closes via menu or escape.
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      projPanel.classList.remove("open");
      userMenu.classList.remove("open");
      if (veil.classList.contains("open")) {
        pendingActionAfterLogin = null;
        hideLogin();
      }
    }
  });

  $("menuProjects").addEventListener("click", () => {
    userMenu.classList.remove("open");
    projPanel.classList.add("open");
    loadProjectList();
  });
  $("projectsClose").addEventListener("click", () => {
    projPanel.classList.remove("open");
  });
  $("menuNew").addEventListener("click", () => {
    userMenu.classList.remove("open");
    if (projectDirty && !confirm("You have unsaved changes. Start a new design anyway?")) return;
    location.reload();
  });
  $("menuSignOut").addEventListener("click", async () => {
    userMenu.classList.remove("open");
    await api("/api/auth/sign-out", { method: "POST" });
    location.reload();
  });

  // ── Projects list ──
  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const now = new Date();
    const same = d.toDateString() === now.toDateString();
    if (same) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  async function loadProjectList() {
    projList.innerHTML = '<div class="projects-empty">Loading…</div>';
    const r = await api("/api/projects");
    if (!r.ok) {
      projList.innerHTML = '<div class="projects-empty">Failed to load projects.</div>';
      return;
    }
    const items = r.json.projects || [];
    if (!items.length) {
      projList.innerHTML = '<div class="projects-empty">No saved projects yet.</div>';
      return;
    }
    projList.innerHTML = "";
    for (const p of items) {
      const row = document.createElement("div");
      row.className = "project-row";
      if (p.id === currentProjectId) row.classList.add("current");
      const nm = document.createElement("div");
      nm.className = "pname";
      nm.textContent = p.name;
      const dt = document.createElement("div");
      dt.className = "pdate";
      dt.textContent = fmtDate(p.updated_at);
      const del = document.createElement("button");
      del.className = "pdelete";
      del.textContent = "×";
      del.title = "Delete project";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${p.name}"?`)) return;
        const dr = await api(`/api/projects/${p.id}`, { method: "DELETE" });
        if (!dr.ok) { alert(dr.json.error || "Delete failed."); return; }
        if (p.id === currentProjectId) setCurrentProject(null, null);
        loadProjectList();
      });
      row.addEventListener("click", () => loadProject(p.id));
      row.appendChild(nm);
      row.appendChild(dt);
      row.appendChild(del);
      projList.appendChild(row);
    }
  }

  async function loadProject(id) {
    if (projectDirty && !confirm("Discard unsaved changes and load this project?")) return;
    const r = await api(`/api/projects/${id}`);
    if (!r.ok) { alert(r.json.error || "Load failed."); return; }
    const p = r.json.project;
    if (!p || !p.data) { alert("Project has no design data."); return; }
    try {
      applyState(p.data);
    } catch (e) {
      alert("Could not apply project state: " + (e && e.message || e));
      return;
    }
    // applyState restores geometry but the first-run "Box House / Free Form"
    // picker is gated by DOM state it doesn't touch — drop the user straight
    // into editing mode on the loaded design.
    enterEditingMode(p.data && p.data.houseMode);
    // Replay the cached frame if the project was saved post-generation.
    // applyState always flips frameStale=true, so this must come after.
    // applyFrameJson re-marks fresh on success.
    if (p.data && p.data._frame && typeof applyFrameJson === "function") {
      try { applyFrameJson(p.data._frame); }
      catch (e) { console.warn("Cached frame failed to load:", e); }
    }
    projPanel.classList.remove("open");
    setCurrentProject(p.id, p.name);
    projectDirty = false;
    refreshPill();
    loadProjectList();   // re-render to highlight current row
  }

  // Dismiss the intro picker + flip from "click to draw" mode into
  // "edit existing room" mode the same way enterSet() does after the user
  // finishes drawing the second corner. Safe to call repeatedly.
  function enterEditingMode(houseModeFromSave) {
    if (typeof houseTypePicked !== "undefined") {
      try { houseTypePicked = true; } catch (e) { /* binding may be const-ish */ }
    }
    const picker = document.getElementById("housePicker");
    if (picker) picker.style.display = "none";
    const hintEl = document.getElementById("hint");
    if (hintEl) hintEl.style.display = "none";
    const exLink = document.getElementById("exampleLink");
    if (exLink) exLink.style.display = "none";

    if (houseModeFromSave === "free") {
      const rW = document.getElementById("rowW"); if (rW) rW.style.display = "none";
      const rD = document.getElementById("rowD"); if (rD) rD.style.display = "none";
    } else {
      const rW = document.getElementById("rowW"); if (rW) rW.style.display = "";
      const rD = document.getElementById("rowD"); if (rD) rD.style.display = "";
    }

    // Mark step 0 as visited so the intro hint ("Click to place your house")
    // doesn't fire on next entry.
    if (typeof stepVisited !== "undefined" && Array.isArray(stepVisited)) {
      stepVisited[0] = true;
    }

    // If the saved design has actual exterior walls, drop straight into
    // editing — enterSet() handles mode = M.SET, opens the dimensions panel,
    // shows undo/redo + Next, frames the camera, resets the undo stack.
    // Otherwise fall back to drawing mode for an empty project.
    const hasRoom = (typeof c1 !== "undefined" && c1) && (typeof c2 !== "undefined" && c2);
    if (hasRoom && typeof enterSet === "function") {
      try { enterSet(); }
      catch (e) {
        const dimPanel = document.getElementById("panel");
        if (dimPanel) dimPanel.classList.add("open");
      }
    } else {
      const dimPanel = document.getElementById("panel");
      if (dimPanel) dimPanel.classList.add("open");
      if (typeof goToStep === "function") {
        try { goToStep(0); } catch (e) { /* swallow */ }
      }
    }
  }

  function gatherDesign() {
    if (typeof captureState !== "function") {
      alert("Internal error: captureState() missing.");
      return null;
    }
    const data = captureState();
    // If the user has a fresh frame in the scene, persist it so loading the
    // project restores the generated frame too — no second GH solve needed.
    // Stale frames (design edited since last generate) are intentionally
    // omitted; they'd misrepresent the saved design.
    if (typeof frameStale !== "undefined" && !frameStale && window._lastFrameJson) {
      data._frame = window._lastFrameJson;
    }
    return data;
  }

  // Core save flow used by the in-panel Save button, the top-right Save
  // button, and Ctrl+S. Behaviour:
  //   - currentProjectId set + no rename     → PUT (overwrite)
  //   - currentProjectId set + new typedName → PUT (rename + overwrite)
  //   - no currentProjectId, name available  → POST (create)
  //   - no currentProjectId, no name         → prompt for name, then POST
  async function saveCurrentDesign({ typedName = "", promptIfNeeded = false } = {}) {
    const data = gatherDesign();
    if (!data) return;
    typedName = (typedName || "").trim();

    if (currentProjectId && (!typedName || typedName === currentProjectName)) {
      const r = await api(`/api/projects/${currentProjectId}`, {
        method: "PUT", body: JSON.stringify({ data }),
      });
      if (!r.ok) { alert(r.json.error || "Save failed."); return; }
      projectDirty = false;
      refreshPill();
      loadProjectList();
      return;
    }
    if (currentProjectId && typedName && typedName !== currentProjectName) {
      const r = await api(`/api/projects/${currentProjectId}`, {
        method: "PUT", body: JSON.stringify({ name: typedName, data }),
      });
      if (!r.ok) { alert(r.json.error || "Save failed."); return; }
      setCurrentProject(currentProjectId, typedName);
      loadProjectList();
      return;
    }
    let name = typedName;
    if (!name && promptIfNeeded) {
      const entered = prompt("Name this design:", "");
      if (entered === null) return;
      name = entered.trim();
    }
    if (!name) {
      if (projNameIn) projNameIn.focus();
      else alert("Type a name first.");
      return;
    }
    const r = await api("/api/projects", {
      method: "POST", body: JSON.stringify({ name, data }),
    });
    if (!r.ok) { alert(r.json.error || "Save failed."); return; }
    setCurrentProject(r.json.project.id, r.json.project.name);
    loadProjectList();
  }

  btnSave.addEventListener("click", () => {
    saveCurrentDesign({ typedName: projNameIn.value });
  });

  btnSaveTop.addEventListener("click", () => {
    if (!currentUser) {
      pendingActionAfterLogin = "save";
      showLogin("save");
      return;
    }
    saveCurrentDesign({ promptIfNeeded: true });
  });

  // Ctrl+S / Cmd+S — save current design. Ignored while typing in an input.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() !== "s") return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    if (!currentUser) {
      pendingActionAfterLogin = "save";
      showLogin("save");
      return;
    }
    saveCurrentDesign({ promptIfNeeded: true });
  });

  btnSaveAs.addEventListener("click", async () => {
    const data = gatherDesign();
    if (!data) return;
    const suggested = currentProjectName ? `${currentProjectName} (copy)` : "";
    const name = prompt("Save as new project — name:", suggested);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const r = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: trimmed, data }),
    });
    if (!r.ok) { alert(r.json.error || "Save failed."); return; }
    setCurrentProject(r.json.project.id, r.json.project.name);
    loadProjectList();
  });

  init();
})();

/* ────────────────── spec mesh debug toggle (Step 6) ────────────────── */
// Renders the JS spec bundle as Three.js geometry alongside the legacy
// preview. Toggle from the dev console:
//   toggleSpecMesh()
// When on, refreshes automatically on every rebuildScene().
let specDebugGroup = null;
let specDebugOn = false;

function updateSpecMesh() {
  if (specDebugGroup) { scene.remove(specDebugGroup); specDebugGroup = null; }
  if (!specDebugOn) return;
  const reqBody = buildRequestBody();
  if (!reqBody) return;
  const bundle = computeGeometrySpecs(reqBody);
  specDebugGroup = specsToGroup(bundle);
  scene.add(specDebugGroup);
}

window.toggleSpecMesh = function() {
  specDebugOn = !specDebugOn;
  updateSpecMesh();
  console.log(`[specmesh] ${specDebugOn ? "ON" : "off"}`);
};


/* ────────────────── parity diagnostic (Step 5) ────────────────── */
// Mirrors compute_geometry_specs in JS (specs.js) and diffs against the
// Python-built spec returned by /api/compute-specs. Console-only — never
// blocks generation. Will be removed once the JS spec drives the preview
// AND the GH solve directly (Step 8).
async function runSpecParityDiff(reqBody) {
  try {
    const jsSpecs = computeGeometrySpecs(reqBody);
    const res = await fetch("/api/compute-specs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const pySpecs = await res.json();
    if (pySpecs.error) {
      console.warn("[parity] python spec error:", pySpecs.error);
      return;
    }
    const diffs = deepSpecDiff(jsSpecs, pySpecs);
    const summary = `${jsSpecs.walls.length} walls, ${jsSpecs.roof.length} roof, ` +
                    `${jsSpecs.doors.length} doors, ${jsSpecs.windows.length} windows`;
    if (diffs.length === 0) {
      console.log(`[parity] specs match: ${summary} ✓`);
    } else {
      console.warn(`[parity] DIFF (${diffs.length}, ${summary}):`, diffs.slice(0, 10));
      console.log("[parity] js:", jsSpecs);
      console.log("[parity] py:", pySpecs);
    }
  } catch (err) {
    console.warn("[parity] check failed:", err);
  }
}

function deepSpecDiff(a, b, path = "") {
  const TOL = 1e-6;
  if (typeof a !== typeof b) return [`${path}: type js=${typeof a} py=${typeof b}`];
  if (a === null || b === null) {
    return a === b ? [] : [`${path}: null mismatch js=${a} py=${b}`];
  }
  if (typeof a === "number") {
    return Math.abs(a - b) <= TOL ? [] : [`${path}: js=${a} py=${b}`];
  }
  if (typeof a !== "object") {
    return a === b ? [] : [`${path}: js=${JSON.stringify(a)} py=${JSON.stringify(b)}`];
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return [`${path}: js array, py not`];
    if (a.length !== b.length) return [`${path}: length js=${a.length} py=${b.length}`];
    const out = [];
    for (let i = 0; i < a.length; i++) {
      out.push(...deepSpecDiff(a[i], b[i], `${path}[${i}]`));
    }
    return out;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
    return [`${path}: keys js=[${aKeys.join(",")}] py=[${bKeys.join(",")}]`];
  }
  const out = [];
  for (const k of aKeys) {
    out.push(...deepSpecDiff(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return out;
}


/* ────────────────── tooltip ────────────────── */
(function(){
  const tip = document.getElementById('ui-tooltip');
  let hideTimer = null;

  document.addEventListener('mouseover', function(e) {
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    clearTimeout(hideTimer);
    tip.textContent = el.dataset.tip;
    tip.classList.add('visible');
    positionTip(e);
  });

  document.addEventListener('mousemove', function(e) {
    if (!tip.classList.contains('visible')) return;
    if (!e.target.closest('[data-tip]')) return;
    positionTip(e);
  });

  document.addEventListener('mouseout', function(e) {
    if (!e.target.closest('[data-tip]')) return;
    hideTimer = setTimeout(() => tip.classList.remove('visible'), 80);
  });

  function positionTip(e) {
    const margin = 12;
    const tw = tip.offsetWidth || 220;
    const th = tip.offsetHeight || 40;
    let x = e.clientX + margin;
    let y = e.clientY - th - margin;
    if (x + tw > window.innerWidth - 8) x = e.clientX - tw - margin;
    if (y < 8) y = e.clientY + margin;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
  }
})();
