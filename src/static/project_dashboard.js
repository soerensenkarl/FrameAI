/* FrameAI Project Dashboard — read/render a single project, with a slowly
   rotating 3D view of the generated frame. Architecturally isolated: no
   imports from app.js. Three.js is loaded fresh via the importmap. */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const LIFECYCLE = [
  { key: "draft",         label: "Draft",         sub: "Design in progress" },
  { key: "requested",     label: "Requested",     sub: "Quote submitted" },
  { key: "reviewed",      label: "Reviewed",      sub: "Admin has looked it over" },
  { key: "quoted",        label: "Quoted",        sub: "Price proposed" },
  { key: "contracted",    label: "Contracted",    sub: "Agreement signed" },
  { key: "in_production", label: "In Production", sub: "Frame being fabricated" },
  { key: "delivered",     label: "Delivered",     sub: "On site" },
  { key: "installed",     label: "Installed",     sub: "Construction complete" },
];
const STATUS_LABEL = Object.fromEntries(LIFECYCLE.map(s => [s.key, s.label]));
STATUS_LABEL.archived = "Archived";
STATUS_LABEL.declined = "Declined";

const projectId = (() => {
  const m = location.pathname.match(/\/p\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
})();

let project = null;
let projectFrame = null;
let viewerIsAdmin = false;

/* ── API plumbing ─────────────────────────────────────────────────── */
async function api(path, opts) {
  const r = await fetch(path, Object.assign(
    { headers: { "Content-Type": "application/json" } },
    opts || {},
  ));
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, json: json || {} };
}

function showGate(text) {
  $("pdGate").style.display = "flex";
  $("pdGateText").textContent = text;
}

/* ── Bootstrap ────────────────────────────────────────────────────── */
async function load() {
  if (!projectId) {
    showGate("Invalid project URL.");
    return;
  }
  const me = await api("/api/auth/me");
  if (!me.ok || !me.json.user) {
    showGate("Sign in on the FrameAI page first, then come back.");
    return;
  }
  const r = await api(`/api/projects/${projectId}`);
  if (r.status === 404) { showGate("Project not found."); return; }
  if (r.status === 401 || r.status === 403) {
    showGate("You don't have access to this project.");
    return;
  }
  if (!r.ok) { showGate("Failed to load project."); return; }
  project = r.json.project;
  viewerIsAdmin = !!project.viewer_is_admin;

  // Pull the frame once so every render path can use the same payload —
  // stats, stat-bar, and 3D scene all read from it.
  if (project.has_frame) {
    const fr = await api(`/api/projects/${projectId}/frame`);
    if (fr.ok && fr.json && fr.json.frame) projectFrame = fr.json.frame;
  }

  renderHeader();
  renderLifecycle();
  renderConnections();
  renderDetails();
  renderStakeholders();
  renderStatBar();
  renderQuoteTab();
  renderLastActivity();
  if (viewerIsAdmin) {
    $("pdAdminBar").style.display = "flex";
    $("pdStatusSelect").value = project.status;
  }
  loadEvents();
  initStage3D();
}

/* ── Header ───────────────────────────────────────────────────────── */
function renderHeader() {
  $("pdName").textContent = project.name || "(untitled)";
  $("pdId").textContent = project.id;
  const s = $("pdStatus");
  s.textContent = STATUS_LABEL[project.status] || project.status;
  s.dataset.status = project.status;
}

/* ── Lifecycle list ───────────────────────────────────────────────── */
function renderLifecycle() {
  const wrap = $("pdLifecycle");
  wrap.innerHTML = "";
  const currentIdx = LIFECYCLE.findIndex(s => s.key === project.status);
  // archived/declined fall outside the linear flow — mark whatever we've done
  // up to the typical end as "done", and let the status pill tell the truth.
  const effectiveIdx = currentIdx === -1 ? LIFECYCLE.length : currentIdx;
  LIFECYCLE.forEach((s, i) => {
    const li = document.createElement("li");
    let cls = "pd-lc-row ";
    let mark = "";
    if (i < effectiveIdx)       { cls += "done";    mark = "✓"; }
    else if (i === effectiveIdx){ cls += "current"; mark = "●"; }
    else                        { cls += "pending"; mark = ""; }
    li.className = cls;
    li.innerHTML = `
      <span class="pd-lc-mark">${mark}</span>
      <span class="pd-lc-text">
        <span class="pd-lc-name">${esc(s.label)}</span>
        <span class="pd-lc-sub">${esc(s.sub)}</span>
      </span>
    `;
    wrap.appendChild(li);
  });
}

/* ── Connections panel (on/off indicators for project artifacts) ──── */
function renderConnections() {
  const wrap = $("pdConnections");
  const quote = project.quote;
  const hasFrame = !!project.has_frame;
  const bygge = quote && quote.byggetilladelse;
  const byggeText = bygge === "yes" ? "Approved"
    : bygge === "no" ? "Not yet"
    : bygge === "waiting" ? "Awaiting"
    : "—";
  const byggeClass = bygge === "yes" ? "" : bygge ? "warn" : "muted";
  const conns = [
    { name: "Quote info",    state: quote ? "Submitted"  : "—",     cls: quote ? "" : "muted" },
    { name: "Design saved",  state: "Saved",                          cls: "" },
    { name: "Frame",         state: hasFrame ? "Generated" : "Pending", cls: hasFrame ? "" : "warn" },
    { name: "Byggetilladelse", state: byggeText,                       cls: byggeClass },
  ];
  wrap.innerHTML = "";
  for (const c of conns) {
    const li = document.createElement("li");
    li.className = "pd-conn-row";
    li.innerHTML = `
      <span class="pd-conn-name">${esc(c.name)}</span>
      <span class="pd-conn-state ${c.cls}">${esc(c.state)}</span>
    `;
    wrap.appendChild(li);
  }
}

/* ── Project details (right rail) ─────────────────────────────────── */
function renderDetails() {
  const data = project.data || {};
  const quote = project.quote || {};
  const stats = (projectFrame && projectFrame.stats) || {};
  const w = +data.inW || 0, d = +data.inD || 0, h = +data.inH || 0;
  const area = (w && d) ? (w * d / 1e6).toFixed(1) + " m²" : "—";
  const totLen = stats.total_length_m ? stats.total_length_m.toFixed(0) + " m" :
                 (stats.part_list ? stats.part_list.reduce((a,p)=>a+(p.meters||0),0).toFixed(0) + " m" : "—");
  const price = (stats.pricing && stats.pricing.price) ?
    Number(stats.pricing.price).toLocaleString("da-DK") + " DKK" : "—";
  const created = fmtDate(project.created_at);
  const updated = fmtDate(project.updated_at);
  const rows = [
    ["Address",    quote.address || project.name || "—"],
    ["Owner",      `${project.owner_display_name || ""} <${project.owner_email || ""}>`],
    ["Created",    created],
    ["Updated",    updated],
    ["Floor area", area],
    ["Wall height",h ? (h / 1000).toFixed(2) + " m" : "—"],
    ["Total timber", totLen],
    ["Estimate",   price, "accent"],
  ];
  $("pdDetails").innerHTML = rows.map(([k, v, cls]) =>
    `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ""}>${esc(v)}</dd>`
  ).join("");
}

/* ── Stakeholders ─────────────────────────────────────────────────── */
function renderStakeholders() {
  const wrap = $("pdStakeholders");
  const owner = {
    name: project.owner_display_name || project.owner_email || "Owner",
    email: project.owner_email || "",
    role: "OWNER",
  };
  // Admin row is generic until a real per-project member system lands.
  const admin = { name: "FrameAI Admin", email: "", role: "ADMIN" };
  wrap.innerHTML = "";
  for (const p of [owner, admin]) {
    const initials = (p.name || "?").split(/\s+/).map(s => s[0]).slice(0, 2).join("").toUpperCase();
    const li = document.createElement("li");
    li.className = "pd-stake-row";
    li.innerHTML = `
      <span class="pd-stake-avatar">${esc(initials)}</span>
      <span class="pd-stake-text">
        <span class="pd-stake-name">${esc(p.name)}${p.email ? ` <span style="color:var(--pd-fg-faint);">${esc(p.email)}</span>` : ""}</span>
        <span class="pd-stake-role">${esc(p.role)}</span>
      </span>
    `;
    wrap.appendChild(li);
  }
}

/* ── Stat strip ────────────────────────────────────────────────────── */
function renderStatBar() {
  const data = project.data || {};
  const stats = (projectFrame && projectFrame.stats) || {};
  const w = +data.inW || 0, d = +data.inD || 0, h = +data.inH || 0;
  $("statWidth").textContent  = w ? (w / 1000).toFixed(1) + " m" : "—";
  $("statDepth").textContent  = d ? (d / 1000).toFixed(1) + " m" : "—";
  $("statHeight").textContent = h ? (h / 1000).toFixed(2) + " m" : "—";
  $("statRoof").textContent   = (data.roofType || "—").replace(/^./, c => c.toUpperCase());
  $("statArea").textContent   = (w && d) ? (w * d / 1e6).toFixed(0) + " m²" : "—";
  const partCount = (stats.part_list || []).reduce((a, p) => a + (p.count || 0), 0);
  $("statParts").textContent  = partCount || "—";
  const price = (stats.pricing && stats.pricing.price);
  $("statPrice").textContent  = price ?
    Math.round(price).toLocaleString("da-DK") + " kr" : "—";
}

/* ── Quote tab ────────────────────────────────────────────────────── */
function renderQuoteTab() {
  const q = project.quote;
  if (!q) {
    $("pdQuoteFields").innerHTML = `<dt>—</dt><dd>No quote submitted yet.</dd>`;
    $("pdQuoteMsg").textContent = "(none)";
    return;
  }
  const rows = [
    ["Full name", q.full_name],
    ["Email", q.email],
    ["Phone", q.phone || "—"],
    ["Address", q.address],
    ["Byggetilladelse", q.byggetilladelse || "—"],
    ["Submitted", fmtDate(q.submitted_at)],
  ];
  $("pdQuoteFields").innerHTML = rows.map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd>`
  ).join("");
  $("pdQuoteMsg").textContent = q.message || "(none)";
}

/* ── Activity ─────────────────────────────────────────────────────── */
function renderLastActivity() {
  const u = fmtDate(project.updated_at);
  const status = STATUS_LABEL[project.status] || project.status;
  $("pdLastActivity").textContent = `${status} · updated ${u}`;
}

async function loadEvents() {
  const r = await api(`/api/projects/${projectId}/events`);
  const wrap = $("pdEvents");
  if (!r.ok) {
    wrap.innerHTML = `<li class="pd-event-row"><span class="pd-event-time">—</span><span class="pd-event-text">Could not load activity.</span></li>`;
    return;
  }
  const events = r.json.events || [];
  if (!events.length) {
    wrap.innerHTML = `<li class="pd-event-row"><span class="pd-event-time">—</span><span class="pd-event-text">No activity yet.</span></li>`;
    return;
  }
  wrap.innerHTML = events.map(e => {
    const txt = describeEvent(e);
    const actor = e.actor_display_name || e.actor_email || "system";
    return `
      <li class="pd-event-row">
        <span class="pd-event-time">${fmtDate(e.created_at)}</span>
        <span>
          <div class="pd-event-text">${esc(txt)}</div>
          <div class="pd-event-actor">by ${esc(actor)}</div>
        </span>
      </li>`;
  }).join("");
}

function describeEvent(e) {
  const p = e.payload || {};
  switch (e.kind) {
    case "created":          return `Project created (${STATUS_LABEL[p.status] || p.status || "draft"})`;
    case "quote_submitted":  return `Quote request submitted${p.address ? ` for ${p.address}` : ""}`;
    case "status_changed":   return `Status changed: ${STATUS_LABEL[p.from] || p.from} → ${STATUS_LABEL[p.to] || p.to}`;
    case "design_updated":   return `Design updated`;
    default:                 return e.kind;
  }
}

/* ── Tabs ─────────────────────────────────────────────────────────── */
function setActiveTab(name) {
  document.querySelectorAll(".pd-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".pd-tabpanel").forEach(p => {
    p.hidden = p.id !== `tabpanel-${name}` || name === "overview";
  });
}
document.querySelectorAll(".pd-tab").forEach(t => {
  t.addEventListener("click", () => setActiveTab(t.dataset.tab));
});

function handleRadialAction(action) {
  switch (action) {
    case "update":
      location.href = "/?project=" + projectId;
      break;
    case "quote":
    case "activity":
    case "files":
    case "comments":
      setActiveTab(action);
      break;
    case "members":
      alert("Stakeholder management lands in v2.");
      break;
  }
}

/* ── Header buttons ───────────────────────────────────────────────── */
$("pdEditBtn").addEventListener("click", () => {
  // FrameAI's init() reads ?project=N and auto-loads the saved design,
  // skipping the envelope/roof pickers.
  location.href = "/?project=" + projectId;
});
$("pdSignOut").addEventListener("click", async () => {
  await fetch("/api/auth/sign-out", { method: "POST" });
  location.href = "/";
});
$("pdMembersBtn").addEventListener("click", () => {
  alert("Stakeholder management lands in v2 — for now: owner + admin.");
});
$("pdMore").addEventListener("click", () => {
  alert("Archive / decline / delete — coming soon.");
});

/* ── Admin status change ──────────────────────────────────────────── */
$("pdStatusApply").addEventListener("click", async () => {
  const newStatus = $("pdStatusSelect").value;
  const btn = $("pdStatusApply");
  btn.disabled = true;
  try {
    const r = await api(`/api/projects/${projectId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: newStatus }),
    });
    if (!r.ok) {
      alert(r.json.error || "Status update failed.");
      return;
    }
    project.status = newStatus;
    renderHeader();
    renderLifecycle();
    renderLastActivity();
    loadEvents();
  } finally {
    btn.disabled = false;
  }
});

/* ── 3D stage ─────────────────────────────────────────────────────── */
function makeFrameWoodMaterial() {
  // Mirror of FrameAI's frameMat in app.js: pine.jpg sampled along each
  // member's tangent so the grain runs down its length, plus a subtle
  // crease bevel via fwidth(normal). Keep these two definitions in sync.
  const tex = new THREE.TextureLoader().load('/static/assets/pine.jpg');
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide,
  });
  mat.userData.uniforms = {
    tWood:      { value: tex },
    uTileScale: { value: 1.0 / 600.0 },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tWood      = mat.userData.uniforms.tWood;
    shader.uniforms.uTileScale = mat.userData.uniforms.uTileScale;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>
        attribute vec3 aMemberTangent;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vWorldTangent;`)
      .replace('#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vWorldNormal  = normalize(mat3(modelMatrix) * objectNormal);
        vWorldTangent = normalize(mat3(modelMatrix) * aMemberTangent);`)
      .replace('#include <project_vertex>',
        `#include <project_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>
        uniform sampler2D tWood;
        uniform float uTileScale;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying vec3 vWorldTangent;`)
      .replace('#include <map_fragment>',
        `#include <map_fragment>
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
        diffuseColor.rgb *= texture2D(tWood, woodUv).rgb;`)
      .replace('#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float edgeAmt = length(fwidth(vWorldNormal));
        float bevel = smoothstep(0.25, 1.0, edgeAmt);
        totalEmissiveRadiance += vec3(1.0, 0.92, 0.78) * bevel * 0.4;`);
  };
  return mat;
}

function initStage3D() {
  const container = $("pdStage3D");
  const frame = projectFrame;
  if (!frame || !Array.isArray(frame.vertices) || !frame.vertices.length) {
    $("pdStageEmpty").style.display = "flex";
    return;
  }

  const w = container.clientWidth;
  const h = container.clientHeight;
  // Match FrameAI's editor render settings: neutral tone-mapping, IBL-only
  // lighting via a PMREM-prefiltered RoomEnvironment, exposure 0.8.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.8;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(35, w / h, 100, 200000);
  camera.up.set(0, 0, 1);

  // Build geometry from the frame snapshot.
  const verts = frame.vertices;
  const norms = frame.normals;
  const tans  = frame.tangents;
  const faces = frame.faces;
  const positions = new Float32Array(verts.length * 3);
  const normals  = new Float32Array(verts.length * 3);
  const tangents = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i*3]   = verts[i][0];
    positions[i*3+1] = verts[i][1];
    positions[i*3+2] = verts[i][2];
    if (norms && norms[i]) {
      normals[i*3]   = norms[i][0];
      normals[i*3+1] = norms[i][1];
      normals[i*3+2] = norms[i][2];
    }
    if (tans && tans[i]) {
      tangents[i*3]   = tans[i][0];
      tangents[i*3+1] = tans[i][1];
      tangents[i*3+2] = tans[i][2];
    }
  }
  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    indices[i*3]   = faces[i][0];
    indices[i*3+1] = faces[i][1];
    indices[i*3+2] = faces[i][2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (norms && norms.length) {
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  } else {
    geo.computeVertexNormals();
  }
  if (tans && tans.length) {
    geo.setAttribute("aMemberTangent", new THREE.BufferAttribute(tangents, 3));
  }
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  const wood = makeFrameWoodMaterial();
  const mesh = new THREE.Mesh(geo, wood);

  // Centre the geometry around its own origin so rotation is around the model.
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  mesh.position.set(-cx, -cy, 0);

  const rig = new THREE.Group();
  rig.add(mesh);

  // Soft floor disc to anchor the model visually.
  const floorR = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) * 0.85;
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(floorR, 64),
    new THREE.MeshStandardMaterial({
      color: 0x111114,
      roughness: 1.0,
      metalness: 0.0,
      transparent: true,
      opacity: 0.55,
    })
  );
  rig.add(floor);

  scene.add(rig);

  // Position camera to fit the model with a comfortable margin.
  const size = bb.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.75;
  const dist = radius / Math.tan((camera.fov * Math.PI / 180) / 2) * 0.95;
  camera.position.set(dist * 0.7, -dist * 0.85, dist * 0.55);
  camera.lookAt(0, 0, size.z * 0.35);

  function resize() {
    const W = container.clientWidth;
    const H = container.clientHeight;
    renderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  // Drag to rotate freely; release returns to the slow turntable. Horizontal
  // drag spins around the vertical axis (offsetting the auto-rotation), and
  // vertical drag tilts the model. Tilt eases back to 0 after release so the
  // model "settles" to the turntable plane; the horizontal angle keeps
  // whatever the user left it at and continues spinning from there.
  const TURN_SPEED   = 0.0012;
  const TILT_DECAY   = 0.93;          // per-frame multiplier; lower = faster ease
  const DRAG_SENS_Z  = 0.008;         // radians per pixel
  const DRAG_SENS_X  = 0.005;
  const TILT_MIN     = -Math.PI / 2.5;
  const TILT_MAX     =  Math.PI / 4;

  const dom = renderer.domElement;
  dom.style.cursor = "grab";
  dom.style.touchAction = "none";

  let isDragging = false;
  let userTilt   = 0;
  let lastX = 0, lastY = 0;

  dom.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    dom.setPointerCapture(e.pointerId);
    dom.style.cursor = "grabbing";
  });
  dom.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    rig.rotation.z -= dx * DRAG_SENS_Z;
    userTilt = Math.max(TILT_MIN, Math.min(TILT_MAX, userTilt - dy * DRAG_SENS_X));
  });
  function endDrag() {
    if (!isDragging) return;
    isDragging = false;
    dom.style.cursor = "grab";
  }
  dom.addEventListener("pointerup", endDrag);
  dom.addEventListener("pointercancel", endDrag);

  // Two-stage radial: hovering the stage shows just the pulsing hub;
  // moving the cursor inside the menu's circular footprint (anywhere within
  // the items' radius) keeps the full menu open. Drag suppresses the menu.
  const radial = $("pdRadial");
  const items  = radial.querySelectorAll(".pd-radial-item");
  // Stay-open zone: items live at radius 240; with 76px buttons the outer
  // edge sits at 240 + 38 = 278. Add ~14px of breathing room.
  const MENU_OUTER_RADIUS = 292;
  let pointerInStage = false;
  let pointerInMenu  = false;
  let _lastState = "false";

  function setState(s) {
    if (_lastState === s) return;
    _lastState = s;
    radial.dataset.open = s;                            // "false" | "hub" | "full"
    radial.setAttribute("aria-hidden", s === "false" ? "true" : "false");
  }
  function syncRadial() {
    if (isDragging || !pointerInStage) { setState("false"); return; }
    setState(pointerInMenu ? "full" : "hub");
  }
  function updatePointerInMenu(clientX, clientY) {
    const r = container.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inside = Math.hypot(clientX - cx, clientY - cy) <= MENU_OUTER_RADIUS;
    if (inside !== pointerInMenu) {
      pointerInMenu = inside;
      syncRadial();
    }
  }

  container.addEventListener("pointerenter", (e) => {
    pointerInStage = true;
    updatePointerInMenu(e.clientX, e.clientY);
    syncRadial();
  });
  container.addEventListener("pointerleave", () => {
    pointerInStage = false;
    pointerInMenu = false;
    syncRadial();
  });
  container.addEventListener("pointermove", (e) => {
    if (!pointerInStage || isDragging) return;
    updatePointerInMenu(e.clientX, e.clientY);
  });

  items.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleRadialAction(btn.dataset.action);
    });
  });

  // Drag wraps the existing callbacks so the menu hides during rotation.
  const _origEndDrag = endDrag;
  endDrag = function () {
    _origEndDrag();
    syncRadial();
  };
  dom.addEventListener("pointerdown", () => { syncRadial(); }, true);
  dom.addEventListener("pointerup", () => { syncRadial(); });
  dom.addEventListener("pointercancel", () => { syncRadial(); });

  function loop() {
    if (!isDragging) {
      rig.rotation.z += TURN_SPEED;
      userTilt *= TILT_DECAY;
      if (Math.abs(userTilt) < 0.0005) userTilt = 0;
    }
    rig.rotation.x = userTilt;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();
}

/* ── Date helper ──────────────────────────────────────────────────── */
function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

load();
