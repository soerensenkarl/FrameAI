"""Flask app – wall framing via rhinoinside."""
import math
import os
from functools import wraps

# Ensure Rhino's native DLLs are findable
RHINO_SYSTEM = r"C:\Program Files\Rhino 8\System"
os.environ["PATH"] = RHINO_SYSTEM + os.pathsep + os.environ.get("PATH", "")

from flask import Flask, request, send_file, jsonify

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


def _post_to_rhino_proxy(path, body, content_type="application/json"):
    """POST `body` (bytes) to RHINO_PROXY_URL + `path`; relay the response.

    Used when running as dev (FRAMEAI_SKIP_RHINO=1) to forward Rhino-requiring
    routes to a local prod instance. Returns (bytes, status, headers) so
    binary responses (e.g. .3dm file downloads) survive the hop.

    All proxied routes are POST today; if a GET route ever needs proxying,
    accept method as a parameter.
    """
    import urllib.request
    import urllib.error
    url = f"{RHINO_PROXY_URL}{path}"
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return (resp.read(), resp.status,
                    {"Content-Type": resp.getheader("Content-Type", "application/json")})
    except urllib.error.HTTPError as e:
        return (e.read(), e.code,
                {"Content-Type": e.headers.get("Content-Type", "application/json")})
    except urllib.error.URLError as e:
        return (
            jsonify({"error": f"Rhino proxy unreachable at {RHINO_PROXY_URL}: {e.reason}. Is the prod server running?"}).get_data(),
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
            return _post_to_rhino_proxy(
                request.path,
                request.get_data() or b"",
                request.headers.get("Content-Type", "application/json"),
            )
        return jsonify({
            "error": "Geometry disabled in this process (FRAMEAI_SKIP_RHINO=1) and no RHINO_PROXY_URL set. Start the prod server and set RHINO_PROXY_URL=http://localhost:5000, or stop prod and restart this process without FRAMEAI_SKIP_RHINO=1."
        }), 503
    return wrapper


OUTPUT_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "output")
FEEDBACK_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "feedback")

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Indkøbspriser per linear meter (DKK), keyed by canonical "WxD" (W >= D).
# Sections not in the table fall back to a volumetric estimate so one
# surprise never silently prices a frame at zero.
TIMBER_PRICE_PER_M = {
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


def _rate_for_section(section):
    """DKK per linear meter for a given cross-section (e.g. '295x45').

    Tolerates both '295x45' and '45x295' orderings; unknown sections fall
    back to a volumetric estimate.
    """
    rate = TIMBER_PRICE_PER_M.get(section)
    if rate is not None:
        return rate
    try:
        a, b = (int(x) for x in str(section).split("x"))
    except (ValueError, AttributeError):
        return 0.0
    rate = TIMBER_PRICE_PER_M.get(f"{max(a, b)}x{min(a, b)}")
    if rate is not None:
        return rate
    return (a * b / 1e6) * 3350


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


def _to_brep(geom):
    """Coerce a Rhino geometry value to a Brep, or None if not coercible.

    Handles both isinstance checks and pythonnet GetType().Name fallback —
    Grasshopper's IGH_Goo wrapper occasionally produces values where
    isinstance fails despite the underlying type being a Brep/Extrusion.
    """
    if isinstance(geom, rg.Brep):
        return geom
    if isinstance(geom, rg.Extrusion):
        return geom.ToBrep()
    get_type = getattr(geom, "GetType", None)
    if get_type is None:
        return None
    name = get_type().Name
    if name == "Brep":
        return geom
    if name == "Extrusion":
        return geom.ToBrep()
    return None


def _as_mesh(geom):
    """Return geom if it's a Rhino Mesh (isinstance OR pythonnet type name)."""
    if isinstance(geom, rg.Mesh):
        return geom
    get_type = getattr(geom, "GetType", None)
    if get_type and get_type().Name == "Mesh":
        return geom
    return None


def _members_to_triangles(mesh_geoms, brep_geoms):
    """Build per-member verts/normals/tangents/tris arrays.

    Each member's vertices carry the member's long-axis as a tangent so the
    frontend can orient the wood-grain texture along the member.
    Pairs ``mesh_geoms[i]`` with ``brep_geoms[i]`` (same GH output order).
    """
    verts, normals, tangents, tris = [], [], [], []
    n = min(len(mesh_geoms), len(brep_geoms))
    for i in range(n):
        mesh = _as_mesh(mesh_geoms[i])
        brep = _to_brep(brep_geoms[i])
        if mesh is None or brep is None:
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


@app.route("/solve-frame", methods=["POST"])
@requires_rhino
def solve_frame():
    """Geometry entry point. Receives a JS-built spec bundle, builds Breps,
    runs Grasshopper, returns mesh + part list + saved files."""
    try:
        specs = request.get_json()
        return _solve_and_respond(specs)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


def _solve_inputs(specs):
    """Build Brep inputs from specs and run the GH definition.

    Returns (outputs, wall_breps, door_breps, window_breps, roof_breps).
    """
    wall_breps   = _breps_from_specs(specs["walls"])
    door_breps   = _breps_from_specs(specs["doors"])
    window_breps = _breps_from_specs(specs["windows"])
    roof_breps   = _breps_from_specs(specs["roof"])
    outputs = solve_definition("generator_3.0.gh", {
        "WallBreps":   wall_breps,
        "DoorBreps":   door_breps,
        "WindowBreps": window_breps,
        "RoofBreps":   roof_breps,
    }, data_nicknames=["cross_sec_out", "count_out", "total_length_out"])
    return outputs, wall_breps, door_breps, window_breps, roof_breps


def _save_design_artifacts(wall_breps, door_breps, window_breps, roof_breps,
                           breps_out, joined_mesh):
    """Save design.3dm (inputs, layered), frame.3dm (output Breps), and
    frame_mesh.3dm (display mesh). Returns the three file paths (any may
    be None if the source was empty).
    """
    design_path = _save_layered_breps_3dm([
        ("walls",   (180, 140,  90), wall_breps),
        ("windows", ( 80, 170, 220), window_breps),
        ("doors",   (230, 150,  60), door_breps),
        ("roof",    (200,  70,  60), roof_breps),
    ], "design.3dm")

    frame_brep_path = _save_breps_3dm(breps_out, "frame.3dm") if breps_out else None

    frame_mesh_path = None
    if joined_mesh.Vertices.Count > 0:
        model = rio.File3dm()
        model.Objects.AddMesh(joined_mesh)
        frame_mesh_path = _write_3dm(model, "frame_mesh.3dm")

    return design_path, frame_brep_path, frame_mesh_path


def _build_part_list(outputs, breps_out):
    """Build the per-cross-section part list. Prefers GH data outputs;
    falls back to Brep-bbox scanning when those are missing / empty.

    Returns (part_list, member_count, total_volume_m3).
    """
    cs_list = outputs.get("cross_sec_out") or []
    ct_list = outputs.get("count_out") or []
    tl_list = outputs.get("total_length_out") or []

    if cs_list and len(cs_list) == len(ct_list) == len(tl_list):
        part_list = []
        total_volume_m3 = 0.0
        member_count = 0
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
        return part_list, member_count, total_volume_m3

    # Legacy fallback: walk frame Breps and infer sections by bbox.
    from collections import defaultdict
    section_lengths = defaultdict(float)
    total_volume_mm3 = 0.0
    member_count = 0
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

    part_list = [
        {"section": f"{sec_d}x{sec_w}",
         "meters":  round(total_len_mm / 1000, 1),
         "count":   None}
        for (sec_d, sec_w), total_len_mm in sorted(section_lengths.items())
    ]
    return part_list, member_count, total_volume_mm3 / 1e9


def _compute_pricing(part_list, material_factor, fab_factor):
    """Material/fabrication/total cost for the given part list.

    Material and Fabrication each scale rawCost INDEPENDENTLY — they do not
    chain. Total = Material + Fabrication. Factors clamped to [0, 10] so a
    malformed request can't bloat or zero the price.
    """
    material_factor = max(0.0, min(10.0, float(material_factor)))
    fab_factor      = max(0.0, min(10.0, float(fab_factor)))
    raw_timber_cost = 0.0
    for it in part_list:
        meters = it.get("meters")
        try:
            meters = float(meters)
        except (TypeError, ValueError):
            continue
        if meters <= 0:
            continue
        raw_timber_cost += _rate_for_section(it.get("section")) * meters
    material_cost    = raw_timber_cost * material_factor
    fabrication_cost = raw_timber_cost * fab_factor
    return {
        "raw_timber_cost":  round(raw_timber_cost, 2),
        "material_cost":    round(material_cost, 2),
        "fabrication_cost": round(fabrication_cost, 2),
        "timber_cost":      round(material_cost, 2),  # alias of material_cost (back-compat)
        "price":            round(material_cost + fabrication_cost, 2),
    }


def _solve_and_respond(specs):
    """Build Breps from specs, solve GH, return the full Flask JSON response."""
    outputs, wall_breps, door_breps, window_breps, roof_breps = _solve_inputs(specs)

    mesh_geoms = outputs.get("MeshOut", [])
    brep_geoms = outputs.get("BrepOut", [])

    # Joined display mesh from MeshOut
    joined = rg.Mesh()
    for geom in mesh_geoms:
        m = _as_mesh(geom)
        if m is not None:
            joined.Append(m)
    joined.FaceNormals.ComputeFaceNormals()
    joined.Normals.ComputeNormals()

    breps_out = [b for b in (_to_brep(g) for g in brep_geoms) if b is not None]

    design_saved, frame_brep_saved, frame_mesh_saved = _save_design_artifacts(
        wall_breps, door_breps, window_breps, roof_breps, breps_out, joined,
    )

    verts, normals, tangents, tris = _members_to_triangles(mesh_geoms, breps_out)
    # Crease edges from the clean Brep topology — renders true member edges
    # without the triangulation artifacts that plague mesh-based EdgesGeometry
    # on boolean-cut window-adjacent members.
    crease_edges = _brep_crease_segments(breps_out)

    part_list, member_count, total_volume_m3 = _build_part_list(outputs, breps_out)
    pricing = _compute_pricing(
        part_list,
        specs.get("material_factor", 3.1),
        specs.get("fab_factor", 1.0),
    )

    weight_kg = total_volume_m3 * 500
    build_minutes = member_count * 5  # ~5 min per member
    build_h, build_m = build_minutes // 60, build_minutes % 60

    return jsonify({
        "vertices": verts,
        "normals": normals,
        "tangents": tangents,
        "faces": tris,
        "crease_edges": crease_edges,
        "result_count": len(mesh_geoms),
        "design_saved": design_saved,
        "frame_brep_saved": frame_brep_saved,
        "frame_mesh_saved": frame_mesh_saved,
        "stats": {
            "member_count": member_count,
            "waste_pct": 0,
            "build_time": f"{build_h}h {build_m:02d}m",
            "weight_kg": round(weight_kg, 1),
            **pricing,
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
