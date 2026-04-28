"""Flask app – wall framing via rhinoinside."""
import math
import os
from functools import wraps

# Ensure Rhino's native DLLs are findable
RHINO_SYSTEM = r"C:\Program Files\Rhino 8\System"
os.environ["PATH"] = RHINO_SYSTEM + os.pathsep + os.environ.get("PATH", "")

from flask import Flask, request, send_file, jsonify

from specs import compute_geometry_specs

# Dev/prod coexistence mode. Only one process can hold the Rhino license,
# so the dev process loads without rhinoinside and forwards geometry
# requests to prod via RHINO_PROXY_URL. UI-only iteration then works
# concurrently with prod serving testers on port 5000.
#   FRAMEAI_SKIP_RHINO=1            → don't load rhinoinside in this process
#   RHINO_PROXY_URL=http://.../     → forward Rhino-requiring routes here
SKIP_RHINO = os.environ.get("FRAMEAI_SKIP_RHINO") == "1"
RHINO_PROXY_URL = (os.environ.get("RHINO_PROXY_URL") or "").rstrip("/")
RHINO_AVAILABLE = False

if not SKIP_RHINO:
    import rhinoinside
    rhinoinside.load(RHINO_SYSTEM, "net8.0")
    from gh_runner import solve_definition
    import System
    import Rhino.FileIO as rio
    import Rhino.Geometry as rg
    RHINO_AVAILABLE = True


def _proxy_to_rhino():
    """Forward the current request to RHINO_PROXY_URL and relay the response.

    Uses stdlib urllib so no extra dependency. Passes JSON body through,
    returns raw bytes + status + Content-Type so binary responses (e.g.
    .3dm file downloads) survive the hop.
    """
    import urllib.request
    import urllib.error
    url = f"{RHINO_PROXY_URL}{request.path}"
    body = request.get_data() or b""
    req = urllib.request.Request(
        url,
        data=body,
        method=request.method,
        headers={"Content-Type": request.headers.get("Content-Type", "application/json")},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return (
                resp.read(),
                resp.status,
                {"Content-Type": resp.getheader("Content-Type", "application/json")},
            )
    except urllib.error.HTTPError as e:
        return (e.read(), e.code, {"Content-Type": e.headers.get("Content-Type", "application/json")})
    except urllib.error.URLError as e:
        return (
            jsonify({"error": f"Rhino proxy unreachable at {RHINO_PROXY_URL}: {e.reason}. Is the prod server running on that port?"}).get_data(),
            502,
            {"Content-Type": "application/json"},
        )


def _is_rhino_not_licensed(exc):
    """Match Rhino.Runtime.NotLicensedException without requiring a clean import.

    Pythonnet wraps the .NET exception; checking the class name is robust
    whether the .NET type is loaded here or surfaces through a nested call.
    """
    e = exc
    while e is not None:
        if "NotLicensed" in type(e).__name__:
            return True
        e = getattr(e, "__cause__", None) or getattr(e, "__context__", None)
    return False


def requires_rhino(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if RHINO_AVAILABLE:
            # rhinoinside + Rhino GUI share one Cloud Zoo seat and
            # periodic re-validation occasionally misses. Retry a few
            # times with backoff — this is the only lever rhinoinside
            # gives us. The real fix is migrating to rhino.compute.exe
            # which holds the license in a long-lived parent process.
            import time
            delays = [0.5, 1.0, 2.0]  # 3 retries, total up to ~3.5s extra
            last_exc = None
            for attempt in range(1 + len(delays)):
                try:
                    return fn(*args, **kwargs)
                except Exception as e:
                    if _is_rhino_not_licensed(e):
                        last_exc = e
                        if attempt < len(delays):
                            time.sleep(delays[attempt])
                            continue
                        import traceback
                        traceback.print_exc()
                        return jsonify({
                            "error": "Rhino license unavailable after 4 attempts. Rhino GUI on the server PC is likely contending for the seat — close Rhino there and retry."
                        }), 503
                    raise
            if last_exc is not None:
                raise last_exc
        if RHINO_PROXY_URL:
            return _proxy_to_rhino()
        return jsonify({
            "error": "Geometry disabled in this process (FRAMEAI_SKIP_RHINO=1) and no RHINO_PROXY_URL set. Start the prod server and set RHINO_PROXY_URL=http://localhost:5000, or stop prod and restart this process without FRAMEAI_SKIP_RHINO=1."
        }), 503
    return wrapper


OUTPUT_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "output")
FEEDBACK_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "feedback")

os.makedirs(OUTPUT_DIR, exist_ok=True)

app = Flask(__name__, static_folder=os.path.join(os.path.dirname(__file__), "static"))
# Sessions are signed cookies — set FRAMEAI_SECRET_KEY in prod (run_prod.bat).
# The dev fallback is fine for local-only testing on port 5001.
app.secret_key = os.environ.get("FRAMEAI_SECRET_KEY", "dev-only-change-in-prod")
from datetime import timedelta
app.permanent_session_lifetime = timedelta(days=30)

import accounts
accounts.init_app(app)


# ── helpers ──

def _brep_crease_segments(breps, threshold_deg=20.0):
    """Extract crease-edge line segments from a list of Breps.

    An edge is emitted when:
      - it's naked (only one adjacent face), OR
      - the dihedral angle between its two adjacent faces exceeds threshold_deg.

    This bypasses mesh-triangulation entirely — boolean-cut members no longer
    spray fan-triangulated edges across their "flat" faces, since we're reading
    topology from the clean Brep rather than the tessellated mesh.
    Returns a list of [[x,y,z], [x,y,z]] pairs.
    """
    segments = []
    threshold_dot = math.cos(math.radians(threshold_deg))

    for brep in breps:
        if brep is None:
            continue
        for edge in brep.Edges:
            adj = edge.AdjacentFaces()
            unique_faces = list(set(int(i) for i in adj))

            is_crease = False
            if len(unique_faces) < 2:
                is_crease = True  # naked / non-manifold
            else:
                face0 = brep.Faces[unique_faces[0]]
                face1 = brep.Faces[unique_faces[1]]
                # Sample each face normal at its parametric center — fine for
                # planar faces (timber members are all planar-faced).
                d0u, d0v = face0.Domain(0), face0.Domain(1)
                d1u, d1v = face1.Domain(0), face1.Domain(1)
                n0 = face0.NormalAt(0.5 * (d0u.Min + d0u.Max),
                                    0.5 * (d0v.Min + d0v.Max))
                n1 = face1.NormalAt(0.5 * (d1u.Min + d1u.Max),
                                    0.5 * (d1v.Min + d1v.Max))
                s0 = -1.0 if face0.OrientationIsReversed else 1.0
                s1 = -1.0 if face1.OrientationIsReversed else 1.0
                dot = s0 * s1 * (n0.X * n1.X + n0.Y * n1.Y + n0.Z * n1.Z)
                is_crease = (dot < threshold_dot)

            if not is_crease:
                continue

            # Straight timber edges: endpoints are enough. For curved edges,
            # tessellate so the polyline tracks the curve.
            if edge.IsLinear():
                p0, p1 = edge.PointAtStart, edge.PointAtEnd
                segments.append([
                    [float(p0.X), float(p0.Y), float(p0.Z)],
                    [float(p1.X), float(p1.Y), float(p1.Z)],
                ])
            else:
                params = edge.DivideByCount(12, True)
                if params is None:
                    continue
                pts = [edge.PointAt(t) for t in params]
                for i in range(len(pts) - 1):
                    a, b = pts[i], pts[i + 1]
                    segments.append([
                        [float(a.X), float(a.Y), float(a.Z)],
                        [float(b.X), float(b.Y), float(b.Z)],
                    ])

    return segments


def _member_long_axis(brep):
    """World-axis unit vector most aligned with a member's longest bbox dimension.

    Used by the frontend shader to run wood-grain UVs along each member's length.
    """
    bb = brep.GetBoundingBox(True)
    dx = abs(bb.Max.X - bb.Min.X)
    dy = abs(bb.Max.Y - bb.Min.Y)
    dz = abs(bb.Max.Z - bb.Min.Z)
    if dx >= dy and dx >= dz:
        return [1.0, 0.0, 0.0]
    if dy >= dz:
        return [0.0, 1.0, 0.0]
    return [0.0, 0.0, 1.0]


def _members_to_triangles(mesh_geoms, brep_geoms):
    """Build per-member verts/normals/tangents/tris arrays.

    Each member's vertices carry the member's long-axis as a tangent so the
    frontend can orient the wood-grain texture along the member.
    Pairs ``mesh_geoms[i]`` with ``brep_geoms[i]`` (same GH output order).
    """
    verts, normals, tangents, tris = [], [], [], []
    n = min(len(mesh_geoms), len(brep_geoms))
    for i in range(n):
        mg = mesh_geoms[i]
        bg = brep_geoms[i]
        mesh = mg if isinstance(mg, rg.Mesh) else None
        if mesh is None and getattr(mg, "GetType", lambda: None)() and mg.GetType().Name == "Mesh":
            mesh = mg
        if mesh is None:
            continue
        if isinstance(bg, rg.Brep):
            brep = bg
        elif isinstance(bg, rg.Extrusion):
            brep = bg.ToBrep()
        elif getattr(bg, "GetType", lambda: None)() and bg.GetType().Name == "Extrusion":
            brep = bg.ToBrep()
        elif getattr(bg, "GetType", lambda: None)() and bg.GetType().Name == "Brep":
            brep = bg
        else:
            continue
        mesh.FaceNormals.ComputeFaceNormals()
        mesh.Normals.ComputeNormals()
        tangent = _member_long_axis(brep)
        offset = len(verts)
        for j in range(mesh.Vertices.Count):
            v = mesh.Vertices[j]
            nrm = mesh.Normals[j]
            verts.append([float(v.X), float(v.Y), float(v.Z)])
            normals.append([float(nrm.X), float(nrm.Y), float(nrm.Z)])
            tangents.append(tangent)
        for j in range(mesh.Faces.Count):
            f = mesh.Faces[j]
            tris.append([f.A + offset, f.B + offset, f.C + offset])
            if f.IsQuad:
                tris.append([f.A + offset, f.C + offset, f.D + offset])
    return verts, normals, tangents, tris


def _write_3dm(model, filename):
    """Write a File3dm to OUTPUT_DIR as Rhino 7 format. Returns abs path."""
    path = os.path.join(OUTPUT_DIR, filename)
    opts = rio.File3dmWriteOptions()
    opts.Version = 7
    model.Write(path, opts)
    return os.path.abspath(path)


def _save_breps_3dm(breps, filename):
    """Save a list of Breps to a Rhino 7 .3dm file."""
    model = rio.File3dm()
    for b in breps:
        model.Objects.AddBrep(b)
    return _write_3dm(model, filename)


def _save_layered_breps_3dm(layer_groups, filename):
    """Save Breps grouped onto named layers.

    `layer_groups` is an iterable of (layer_name, (r, g, b), [breps]).
    Empty groups still create the layer so the layer structure is stable.
    """
    import Rhino.DocObjects as rdoc
    from System.Drawing import Color
    model = rio.File3dm()
    for name, rgb, breps in layer_groups:
        color = Color.FromArgb(int(rgb[0]), int(rgb[1]), int(rgb[2]))
        layer_idx = model.AllLayers.AddLayer(name, color)
        attrs = rdoc.ObjectAttributes()
        attrs.LayerIndex = layer_idx
        for b in breps:
            if b is not None:
                model.Objects.AddBrep(b, attrs)
    return _write_3dm(model, filename)


# ────────────────────────────────────────────────────────────────────────────
# Rhino-dependent Brep construction (only reached when RHINO_AVAILABLE).
# Pure-Python spec builders live in specs.py — these helpers turn those
# JSON-serializable dicts into RhinoCommon Breps for the GH solve.
# ────────────────────────────────────────────────────────────────────────────


def _planar_face(pts):
    """Build a single-face planar Brep from an ordered point loop."""
    closed = list(pts) + [pts[0]]
    curve = rg.PolylineCurve(System.Array[rg.Point3d](closed))
    faces = rg.Brep.CreatePlanarBreps(curve, 1.0)
    return faces[0] if faces and len(faces) > 0 else None


def _solid_from_profile(profile_pts, direction):
    """Sweep a 4-point planar profile along `direction` and return a closed solid
    Brep with 6 distinct planar faces (2 caps + 4 sides)."""
    p0, p1, p2, p3 = profile_pts
    q0 = rg.Point3d(p0.X + direction.X, p0.Y + direction.Y, p0.Z + direction.Z)
    q1 = rg.Point3d(p1.X + direction.X, p1.Y + direction.Y, p1.Z + direction.Z)
    q2 = rg.Point3d(p2.X + direction.X, p2.Y + direction.Y, p2.Z + direction.Z)
    q3 = rg.Point3d(p3.X + direction.X, p3.Y + direction.Y, p3.Z + direction.Z)
    # 6 faces — start cap, end cap, and 4 side quads. Winding is not critical
    # for JoinBreps; it rebuilds orientation.
    face_loops = [
        [p0, p1, p2, p3],          # start cap (profile)
        [q0, q1, q2, q3],          # end cap
        [p0, p1, q1, q0],          # side 0→1
        [p1, p2, q2, q1],          # side 1→2
        [p2, p3, q3, q2],          # side 2→3
        [p3, p0, q0, q3],          # side 3→0
    ]
    face_breps = []
    for loop in face_loops:
        fb = _planar_face(loop)
        if fb is not None:
            face_breps.append(fb)
    if len(face_breps) != 6:
        return None
    joined = rg.Brep.JoinBreps(System.Array[rg.Brep](face_breps), 1.0)
    if joined and len(joined) > 0:
        return joined[0]
    return None


def _breps_from_specs(specs):
    """Convert a list of pure-Python spec dicts into RhinoCommon Breps."""
    breps = []
    for s in specs:
        kind = s["kind"]
        if kind == "box":
            box = rg.Box(rg.Plane.WorldXY,
                         rg.Interval(*s["x"]),
                         rg.Interval(*s["y"]),
                         rg.Interval(*s["z"]))
            breps.append(box.ToBrep())
        elif kind == "extruded":
            pts = [rg.Point3d(*p) for p in s["pts"]]
            curve = rg.PolylineCurve(System.Array[rg.Point3d](pts))
            srf = rg.Surface.CreateExtrusion(curve, rg.Vector3d(*s["dir"]))
            brep = srf.ToBrep()
            if s.get("cap"):
                capped = brep.CapPlanarHoles(1.0)
                brep = capped if capped else brep
            breps.append(brep)
        elif kind == "planar_solid":
            pts = [rg.Point3d(*p) for p in s["profile"]]
            direction = rg.Vector3d(*s["dir"])
            solid = _solid_from_profile(pts, direction)
            if solid:
                breps.append(solid)
        else:
            raise ValueError(f"Unknown spec kind: {kind!r}")
    return breps


# ── routes ──

@app.route("/")
def index():
    return send_file(os.path.join(app.static_folder, "index.html"))


def _forward_specs_to_rhino(specs):
    """Forward a spec bundle to prod's /solve-frame and relay the response.

    Used by dev (FRAMEAI_SKIP_RHINO=1) so dev-side Python changes to the
    pure-Python spec builders take effect immediately without needing to ship
    to prod. Prod only has to know how to turn specs → Breps → GH solution.
    """
    import urllib.request
    import urllib.error
    import json
    url = f"{RHINO_PROXY_URL}/solve-frame"
    body = json.dumps(specs).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return (
                resp.read(),
                resp.status,
                {"Content-Type": resp.getheader("Content-Type", "application/json")},
            )
    except urllib.error.HTTPError as e:
        return (e.read(), e.code, {"Content-Type": e.headers.get("Content-Type", "application/json")})
    except urllib.error.URLError as e:
        return (
            jsonify({"error": f"Rhino proxy unreachable at {RHINO_PROXY_URL}: {e.reason}. Is the prod server running?"}).get_data(),
            502,
            {"Content-Type": "application/json"},
        )


@app.route("/generate-frame", methods=["POST"])
def generate_frame():
    """Front door. Always does the pure-Python spec computation; then either
    solves locally (when Rhino is available) or forwards specs to prod's
    /solve-frame endpoint (when running as dev)."""
    try:
        data = request.get_json()
        specs = compute_geometry_specs(data)

        if not RHINO_AVAILABLE:
            if RHINO_PROXY_URL:
                return _forward_specs_to_rhino(specs)
            return jsonify({
                "error": "FRAMEAI_SKIP_RHINO=1 but RHINO_PROXY_URL is empty. Start dev via run_dev.bat (it sets both), or stop prod and restart this process without FRAMEAI_SKIP_RHINO=1."
            }), 503

        return _solve_and_respond(specs)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/solve-frame", methods=["POST"])
@requires_rhino
def solve_frame():
    """Rhino-side entry point. Takes a pre-computed spec bundle (usually from
    dev), builds Breps, runs GH, returns the same response shape as
    /generate-frame."""
    try:
        specs = request.get_json()
        return _solve_and_respond(specs)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _solve_and_respond(specs):
    """Build Breps from specs, solve the Grasshopper definition, and return
    the full Flask JSON response (mesh triangles + part list + saved files)."""
    wall_breps = _breps_from_specs(specs["walls"])
    door_breps = _breps_from_specs(specs["doors"])
    window_breps = _breps_from_specs(specs["windows"])
    roof_breps = _breps_from_specs(specs["roof"])

    outputs = solve_definition("generator_3.0.gh", {
        "WallBreps": wall_breps,
        "DoorBreps": door_breps,
        "WindowBreps": window_breps,
        "RoofBreps": roof_breps,
    }, data_nicknames=["cross_sec_out", "count_out", "total_length_out"])

    # "MeshOut" → display in browser, "BrepOut" → save to .3dm
    mesh_geoms = outputs.get("MeshOut", [])
    brep_geoms = outputs.get("BrepOut", [])

    # Build display mesh from MeshOut
    joined = rg.Mesh()
    for geom in mesh_geoms:
        if isinstance(geom, rg.Mesh):
            joined.Append(geom)
        else:
            tn = geom.GetType().Name
            if tn == "Mesh":
                joined.Append(geom)
    joined.FaceNormals.ComputeFaceNormals()
    joined.Normals.ComputeNormals()

    # Collect Breps from BrepOut for .3dm saving
    breps_out = []
    for geom in brep_geoms:
        if isinstance(geom, rg.Brep):
            breps_out.append(geom)
        elif isinstance(geom, rg.Extrusion):
            breps_out.append(geom.ToBrep())
        else:
            tn = geom.GetType().Name
            if tn == "Brep":
                breps_out.append(geom)
            elif tn == "Extrusion":
                breps_out.append(geom.ToBrep())

    # Save all input breps to design.3dm, organized by layer.
    input_saved = _save_layered_breps_3dm([
        ("walls",   (180, 140,  90), wall_breps),
        ("windows", ( 80, 170, 220), window_breps),
        ("doors",   (230, 150,  60), door_breps),
        ("roof",    (200,  70,  60), roof_breps),
    ], "design.3dm")

    # Save frame Breps to frame.3dm
    frame_brep_saved = None
    if breps_out:
        frame_brep_saved = _save_breps_3dm(breps_out, "frame.3dm")

    # Save frame mesh to frame_mesh.3dm
    frame_mesh_saved = None
    if joined.Vertices.Count > 0:
        model = rio.File3dm()
        model.Objects.AddMesh(joined)
        frame_mesh_saved = _write_3dm(model, "frame_mesh.3dm")

    verts, normals, tangents, tris = _members_to_triangles(mesh_geoms, breps_out)

    # Crease edges from the clean Brep topology — renders true member edges
    # without the triangulation artifacts that plague mesh-based EdgesGeometry
    # on boolean-cut window-adjacent members.
    crease_edges = _brep_crease_segments(breps_out)

    # Prefer stats straight from the GH definition (cross_sec_out / count_out /
    # total_length_out — parallel lists, one entry per cross-section).
    # Fall back to brep-bbox scanning when the data params are missing / empty.
    cs_list = outputs.get("cross_sec_out") or []
    ct_list = outputs.get("count_out") or []
    tl_list = outputs.get("total_length_out") or []

    part_list = []
    total_volume_m3 = 0.0
    member_count = 0

    if cs_list and len(cs_list) == len(ct_list) == len(tl_list):
        for sec_str, cnt, tot_len_m in zip(cs_list, ct_list, tl_list):
            sec_str = str(sec_str).lower().replace(" ", "")
            try:
                a_mm, b_mm = (int(round(float(x))) for x in sec_str.split("x"))
            except Exception:
                a_mm, b_mm = 0, 0
            # Canonical section string: larger dimension first. Keeps keys
            # aligned with the indkøbspriser table ("295x45", never "45x295").
            w_mm, d_mm = max(a_mm, b_mm), min(a_mm, b_mm)
            cnt = int(cnt)
            tot_len_m = float(tot_len_m)
            member_count += cnt
            # Cross-section in mm² → m², times length in m → m³
            total_volume_m3 += (w_mm * d_mm * 1e-6) * tot_len_m
            part_list.append({
                "section": f"{w_mm}x{d_mm}",
                "meters": round(tot_len_m, 1),
                "count": cnt,
            })
    else:
        # Legacy fallback: walk the frame Breps and infer sections by bbox.
        from collections import defaultdict
        section_lengths = defaultdict(float)
        total_volume_mm3 = 0.0
        for b in breps_out:
            bb = b.GetBoundingBox(True)
            dims = sorted([
                round(bb.Max.X - bb.Min.X),
                round(bb.Max.Y - bb.Min.Y),
                round(bb.Max.Z - bb.Min.Z),
            ])
            sec_w, sec_d, length = dims[0], dims[1], dims[2]
            sec_w = round(sec_w / 5) * 5
            sec_d = round(sec_d / 5) * 5
            length = round(length / 100) * 100
            section_lengths[(sec_d, sec_w)] += length
            total_volume_mm3 += sec_w * sec_d * length
            member_count += 1
        for (sec_d, sec_w), total_len_mm in sorted(section_lengths.items()):
            part_list.append({
                "section": f"{sec_d}x{sec_w}",
                "meters": round(total_len_mm / 1000, 1),
                "count": None,
            })
        total_volume_m3 = total_volume_mm3 / 1e9

    # Waste is no longer available from GH (per-member lengths needed) —
    # report the fabrication mark-up line separately.
    waste_pct = 0
    weight_kg = total_volume_m3 * 500

    # Estimated build time: ~5 min per member
    build_minutes = member_count * 5
    build_h = build_minutes // 60
    build_m = build_minutes % 60

    # Pricing (DKK). Material = per-section indkøbspris × meters. Fabrication
    # = Material × fab_factor (admin-controlled slider, default 1×). Total is
    # the sum. Unknown sections fall back to a volumetric rate so one surprise
    # section doesn't silently price at zero.
    timber_price_per_m = {
        "295x45": 48.00,
        "245x45": 36.00,
        "220x45": 32.00,
        "195x45": 27.00,
        "170x45": 24.50,
        "145x45": 21.00,
        "120x45": 18.95,
        "95x45":  14.00,
        "70x45":  11.00,
        "50x45":   7.00,
        "45x45":   7.00,
    }
    # Raw purchase cost (indkøbspris × meters). Tolerates both "295x45" and
    # "45x295" orderings, and falls back to a volumetric estimate when a
    # section isn't in the table so one surprise never prices a frame at zero.
    def _rate_for(section):
        rate = timber_price_per_m.get(section)
        if rate is not None:
            return rate
        try:
            a, b = (int(x) for x in str(section).split("x"))
        except (ValueError, AttributeError):
            return 0.0
        # Canonical key is bigger-first; try both before fallback.
        rate = timber_price_per_m.get(f"{max(a, b)}x{min(a, b)}")
        if rate is not None:
            return rate
        return (a * b / 1e6) * 3350

    raw_timber_cost = 0.0
    for it in part_list:
        meters = it.get("meters")
        try:
            meters = float(meters)
        except (TypeError, ValueError):
            continue
        if meters <= 0:
            continue
        raw_timber_cost += _rate_for(it.get("section")) * meters

    # Material and Fabrication each scale rawCost INDEPENDENTLY — they do not
    # chain. Total = Material + Fabrication. Factors clamped to [0, 10] so a
    # malformed request can't bloat or zero the price.
    material_factor = max(0.0, min(10.0, float(specs.get("material_factor", 3.1))))
    fab_factor      = max(0.0, min(10.0, float(specs.get("fab_factor", 1.0))))
    material_cost    = raw_timber_cost * material_factor
    fabrication_cost = raw_timber_cost * fab_factor
    price = material_cost + fabrication_cost
    # Keep the historical field name populated for any external consumer.
    timber_cost = material_cost

    return jsonify({
        "vertices": verts,
        "normals": normals,
        "tangents": tangents,
        "faces": tris,
        "crease_edges": crease_edges,
        "result_count": len(mesh_geoms),
        "design_saved": input_saved,
        "frame_brep_saved": frame_brep_saved,
        "frame_mesh_saved": frame_mesh_saved,
        "stats": {
            "member_count": member_count,
            "waste_pct": round(waste_pct, 1),
            "build_time": f"{build_h}h {build_m:02d}m",
            "weight_kg": round(weight_kg, 1),
            "raw_timber_cost": round(raw_timber_cost, 2),
            "material_cost": round(material_cost, 2),
            "fabrication_cost": round(fabrication_cost, 2),
            "timber_cost": round(timber_cost, 2),   # alias of material_cost (back-compat)
            "price": round(price, 2),
            "part_list": part_list,
        },
    })


@app.route("/api/feedback", methods=["POST"])
def submit_feedback():
    import base64
    import json as _json
    from datetime import datetime

    try:
        data = request.get_json(force=True) or {}
        text = (data.get("text") or "").strip()
        image_data_url = data.get("image") or ""
        state = data.get("state")

        if not text and not image_data_url:
            return jsonify({"error": "empty feedback"}), 400

        os.makedirs(FEEDBACK_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        target = os.path.join(FEEDBACK_DIR, stamp)
        # Disambiguate if a second feedback lands in the same second
        suffix = 0
        while os.path.exists(target):
            suffix += 1
            target = os.path.join(FEEDBACK_DIR, f"{stamp}_{suffix}")
        os.makedirs(target)

        if text:
            with open(os.path.join(target, "comment.txt"), "w", encoding="utf-8") as f:
                f.write(text)

        if image_data_url.startswith("data:image/png;base64,"):
            b64 = image_data_url.split(",", 1)[1]
            with open(os.path.join(target, "annotation.png"), "wb") as f:
                f.write(base64.b64decode(b64))

        if state is not None:
            with open(os.path.join(target, "state.json"), "w", encoding="utf-8") as f:
                _json.dump(state, f, indent=2)

        return jsonify({"success": True, "id": os.path.basename(target)})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    env_label = os.environ.get("FRAMEAI_ENV", "prod" if port == 5000 else "dev")
    print(f"Server running at http://localhost:{port}  (env: {env_label})")
    app.run(debug=False, port=port, threaded=False)
