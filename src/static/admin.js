/* Woodstock Operations dashboard — Polycam-inspired project library.
   Architecturally isolated from app.js: own importmap, own three.js
   instance, own state. Renders 3D thumbnails for projects with a saved
   frame using a single shared offscreen renderer. */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

/* ── Status vocabulary ────────────────────────────────────────────── */
const STATUS_ORDER = [
  "requested", "reviewed", "quoted", "contracted",
  "in_production", "delivered", "installed",
  "draft", "archived", "declined",
];
const STATUS_LABEL = {
  draft: "Draft",
  requested: "Requested",
  reviewed: "Reviewed",
  quoted: "Quoted",
  contracted: "Contracted",
  in_production: "In Production",
  delivered: "Delivered",
  installed: "Installed",
  archived: "Archived",
  declined: "Declined",
};

/* ── State ────────────────────────────────────────────────────────── */
let projects = [];
let activeFilter = "all";
let activeSort = "updated";
let searchTerm = "";
const frameCache = new Map();   // project_id → frame JSON
const thumbCache = new Map();   // project_id → data URL

/* ── API ──────────────────────────────────────────────────────────── */
async function api(path, opts) {
  const res = await fetch(path, Object.assign(
    { headers: { "Content-Type": "application/json" } },
    opts || {},
  ));
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, json: json || {} };
}

function fmtRel(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60)        return "just now";
  if (diff < 3600)      return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)     return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/* ── Auth gate + bootstrap ────────────────────────────────────────── */
async function bootstrap() {
  const me = await api("/api/auth/me");
  if (!me.ok || !me.json.user) {
    showGate("Sign in to continue.");
    return;
  }
  if (!me.json.user.is_admin) {
    showGate("This account isn't an admin. Sign in with the admin email.");
    return;
  }
  const r = await api("/api/admin/projects");
  if (!r.ok) {
    showGate("Could not load projects.");
    return;
  }
  hideGate();
  projects = r.json.projects || [];
  $("dashPageCount").textContent = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  renderFilters();
  renderGrid();
  renderThumbnails();
}

function showGate(msg) {
  document.querySelector(".dash-side").style.display = "none";
  document.querySelector(".dash-main").style.display = "none";
  $("dashGate").style.display = "flex";
  $("dashGateText").textContent = msg;
  $("dashGateError").textContent = "";
  // Focus the first empty field once the form is on screen.
  setTimeout(() => {
    const e = $("dashLoginEmail");
    const p = $("dashLoginPw");
    if (e && !e.value) e.focus();
    else if (p) p.focus();
  }, 30);
}
function hideGate() {
  document.querySelector(".dash-side").style.display = "";
  document.querySelector(".dash-main").style.display = "";
  $("dashGate").style.display = "none";
}

$("dashLoginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = ($("dashLoginEmail").value || "").trim().toLowerCase();
  const pw = $("dashLoginPw").value || "";
  const errEl = $("dashGateError");
  errEl.textContent = "";
  if (!email || !pw) {
    errEl.textContent = "Email and password required.";
    return;
  }
  const btn = $("dashLoginBtn");
  btn.disabled = true;
  try {
    const r = await api("/api/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ email, password: pw }),
    });
    if (!r.ok) {
      errEl.textContent = r.json.error || "Sign-in failed.";
      return;
    }
    if (!r.json.user || !r.json.user.is_admin) {
      // Non-admin signed in — clear the session so a stray account doesn't
      // linger, and surface the message to the user.
      await api("/api/auth/sign-out", { method: "POST" });
      errEl.textContent = "That account isn't authorised for the dashboard.";
      return;
    }
    $("dashLoginPw").value = "";
    bootstrap();
  } finally {
    btn.disabled = false;
  }
});

/* ── Filter chips ─────────────────────────────────────────────────── */
function renderFilters() {
  const counts = { all: projects.length };
  for (const s of STATUS_ORDER) counts[s] = 0;
  for (const p of projects) counts[p.status] = (counts[p.status] || 0) + 1;

  const wrap = $("dashFilters");
  wrap.innerHTML = "";

  const chips = [{ key: "all", label: "All" }];
  // Show every status that has at least one project, in canonical order.
  for (const s of STATUS_ORDER) {
    if (counts[s]) chips.push({ key: s, label: STATUS_LABEL[s] });
  }

  for (const c of chips) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dash-chip" + (activeFilter === c.key ? " active" : "");
    btn.dataset.filter = c.key;
    btn.innerHTML = `${esc(c.label)}<span class="dash-chip-count">${counts[c.key] || 0}</span>`;
    btn.addEventListener("click", () => {
      activeFilter = c.key;
      renderFilters();
      renderGrid();
    });
    wrap.appendChild(btn);
  }
}

/* ── Sort + filter ────────────────────────────────────────────────── */
function visibleProjects() {
  const q = searchTerm.trim().toLowerCase();
  let list = projects.slice();
  if (activeFilter !== "all") {
    list = list.filter(p => p.status === activeFilter);
  }
  if (q) {
    list = list.filter(p =>
      (p.name || "").toLowerCase().includes(q) ||
      (p.address || "").toLowerCase().includes(q) ||
      (p.owner_email || "").toLowerCase().includes(q) ||
      (p.owner_display_name || "").toLowerCase().includes(q)
    );
  }
  switch (activeSort) {
    case "created": list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)); break;
    case "name":    list.sort((a, b) => (a.name || "").localeCompare(b.name || "")); break;
    case "status":
      list.sort((a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
      break;
    default:        list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }
  return list;
}

/* ── Grid ─────────────────────────────────────────────────────────── */
function renderGrid() {
  const grid = $("dashGrid");
  const items = visibleProjects();
  if (!items.length) {
    grid.innerHTML = `<div class="dash-empty">No projects match.</div>`;
    return;
  }
  grid.innerHTML = "";
  for (const p of items) {
    const card = document.createElement("a");
    card.className = "dash-card";
    card.dataset.status = p.status;
    card.dataset.projectId = p.id;
    card.href = `/p/${p.id}`;

    const owner = p.owner_display_name || p.owner_email || "?";
    const sub = `${esc(owner)}<span class="dash-card-sub-sep"></span>${esc(fmtRel(p.updated_at))}`;
    const cachedThumb = thumbCache.get(p.id);

    card.innerHTML = `
      <div class="dash-card-thumb">
        <span class="dash-card-status">${esc(STATUS_LABEL[p.status] || p.status)}</span>
        <span class="dash-card-id">#${p.id}</span>
        <button class="dash-card-delete" type="button" aria-label="Delete project">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
            <path d="M10 11v6M14 11v6"/>
          </svg>
        </button>
        ${cachedThumb
          ? `<img src="${cachedThumb}" alt="">`
          : (p.has_frame
              ? `<div class="dash-card-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 2v20M2 12h20"/></svg></div>`
              : `<div class="dash-card-placeholder">${houseGlyph(p.summary && p.summary.roof)}<span class="dash-card-placeholder-text">No frame yet</span></div>`)
        }
      </div>
      <div class="dash-card-meta">
        <h3 class="dash-card-title">${esc(p.name)}</h3>
        <div class="dash-card-sub">${sub}</div>
      </div>
    `;
    card.querySelector(".dash-card-delete").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteProject(p);
    });
    grid.appendChild(card);
  }
}

async function deleteProject(p) {
  const owner = p.owner_display_name || p.owner_email || "?";
  const ok = confirm(
    `Delete "${p.name}" (#${p.id})?\n\nOwner: ${owner}\n` +
    `This permanently removes the project, its frame, events, versions, ` +
    `and on-disk files. This action cannot be undone.`
  );
  if (!ok) return;
  const r = await api(`/api/admin/projects/${p.id}`, { method: "DELETE" });
  if (!r.ok) {
    alert((r.json && r.json.error) || "Delete failed.");
    return;
  }
  // Drop from local state, refresh chip counts + grid in place.
  projects = projects.filter(x => x.id !== p.id);
  thumbCache.delete(p.id);
  frameCache.delete(p.id);
  $("dashPageCount").textContent = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  renderFilters();
  renderGrid();
}

function houseGlyph(roof) {
  if (roof === "gable") {
    return `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
      <path d="M10 50V32L32 14l22 18v18z"/><path d="M22 50V36h20v14"/>
    </svg>`;
  }
  if (roof === "flat") {
    return `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
      <rect x="10" y="20" width="44" height="30" rx="1.5"/><path d="M22 50V36h20v14"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">
    <rect x="14" y="26" width="36" height="24"/><path d="M22 50V36h20v14"/>
  </svg>`;
}

/* ── 3D thumbnail rendering ───────────────────────────────────────── */
let _thumbRenderer = null;
let _thumbScene = null;
let _thumbCamera = null;
let _woodMat = null;

async function initThumbRenderer() {
  if (_thumbRenderer) return;
  const canvas = $("dashThumbRenderer");
  _thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  _thumbRenderer.setPixelRatio(2);  // sharp thumbnails
  _thumbRenderer.setSize(560, 380, false);
  _thumbRenderer.toneMapping = THREE.NeutralToneMapping;
  _thumbRenderer.toneMappingExposure = 0.8;

  _thumbScene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(_thumbRenderer);
  _thumbScene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
  pmrem.dispose();

  _thumbCamera = new THREE.PerspectiveCamera(35, 560 / 380, 100, 200000);
  _thumbCamera.up.set(0, 0, 1);

  // Wait for the wood texture to fully decode before starting any renders.
  // Without this, the first card or two would render with a black diffuse
  // because the GPU samples the texture before its pixels arrive.
  const tex = await new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      '/static/assets/pine.jpg',
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        resolve(t);
      },
      undefined,
      reject,
    );
  });
  _woodMat = makeWoodMaterial(tex);
}

function makeWoodMaterial(tex) {
  // Same shader as project_dashboard / FrameAI editor, kept in sync.
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

async function renderThumbnails() {
  await initThumbRenderer();
  // Sequential — keeps memory + GPU pressure low.
  for (const p of projects) {
    if (!p.has_frame) continue;
    if (thumbCache.has(p.id)) continue;
    try {
      const frame = await fetchFrame(p.id);
      if (!frame) continue;
      const url = renderFrameToDataURL(frame);
      thumbCache.set(p.id, url);
      // Patch the live card in place if it's currently in the grid.
      const card = document.querySelector(`.dash-card[data-project-id="${p.id}"] .dash-card-thumb`);
      if (card) {
        const ph = card.querySelector(".dash-card-placeholder");
        if (ph) ph.remove();
        const img = document.createElement("img");
        img.alt = "";
        img.src = url;
        card.appendChild(img);
      }
      // Yield to the event loop so the page stays responsive.
      await new Promise(r => setTimeout(r, 0));
    } catch (e) {
      console.warn("thumbnail render failed for project", p.id, e);
    }
  }
}

async function fetchFrame(pid) {
  if (frameCache.has(pid)) return frameCache.get(pid);
  const r = await api(`/api/projects/${pid}/frame`);
  const f = (r.ok && r.json && r.json.frame) ? r.json.frame : null;
  frameCache.set(pid, f);
  return f;
}

function renderFrameToDataURL(frame) {
  // Wipe any previous mesh from the scene.
  for (let i = _thumbScene.children.length - 1; i >= 0; i--) {
    const obj = _thumbScene.children[i];
    if (obj.userData && obj.userData._thumbModel) {
      _thumbScene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
    }
  }

  const { vertices, normals, tangents, faces } = frame;
  if (!vertices || !faces || !vertices.length || !faces.length) return "";

  const positions = new Float32Array(vertices.length * 3);
  const norms     = new Float32Array(vertices.length * 3);
  const tans      = new Float32Array(vertices.length * 3);
  for (let i = 0; i < vertices.length; i++) {
    positions[i*3]   = vertices[i][0];
    positions[i*3+1] = vertices[i][1];
    positions[i*3+2] = vertices[i][2];
    if (normals && normals[i]) {
      norms[i*3]   = normals[i][0];
      norms[i*3+1] = normals[i][1];
      norms[i*3+2] = normals[i][2];
    }
    if (tangents && tangents[i]) {
      tans[i*3]   = tangents[i][0];
      tans[i*3+1] = tangents[i][1];
      tans[i*3+2] = tangents[i][2];
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
  if (normals && normals.length) geo.setAttribute("normal", new THREE.BufferAttribute(norms, 3));
  else geo.computeVertexNormals();
  if (tangents && tangents.length) geo.setAttribute("aMemberTangent", new THREE.BufferAttribute(tans, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;

  const mesh = new THREE.Mesh(geo, _woodMat);
  mesh.position.set(-cx, -cy, 0);
  mesh.userData._thumbModel = true;
  _thumbScene.add(mesh);

  const radius = Math.max(size.x, size.y, size.z) * 0.7;
  const dist = radius / Math.tan((_thumbCamera.fov * Math.PI / 180) / 2) * 1.0;
  _thumbCamera.position.set(dist * 0.7, -dist * 0.85, dist * 0.55);
  _thumbCamera.lookAt(0, 0, size.z * 0.35);

  _thumbRenderer.render(_thumbScene, _thumbCamera);
  return _thumbRenderer.domElement.toDataURL("image/png");
}

/* ── Wiring ───────────────────────────────────────────────────────── */
$("dashSearch").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderGrid();
});
$("dashSort").addEventListener("change", (e) => {
  activeSort = e.target.value;
  renderGrid();
});
$("dashSignOut").addEventListener("click", async () => {
  await api("/api/auth/sign-out", { method: "POST" });
  location.href = "/";
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("dashSearch").focus();
    $("dashSearch").select();
  }
});

bootstrap();
