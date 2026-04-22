"""Flask app – wall framing via rhinoinside."""
import io
import os
import tempfile
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
    from box_gen import generate_box
    from wall_framer import frame_wall
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


import math

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "output")
FEEDBACK_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "feedback")

# Opening dimensions (must match frontend constants)
WINDOW_W, WINDOW_H, WINDOW_SILL = 1000, 1000, 900
DOOR_W, DOOR_H = 900, 2100
os.makedirs(OUTPUT_DIR, exist_ok=True)

app = Flask(__name__, static_folder=os.path.join(os.path.dirname(__file__), "static"))


# ── helpers ──

def _mesh_to_triangles(mesh):
    """Extract vertices, normals and triangle indices from a Rhino Mesh."""
    verts = []
    normals = []
    for i in range(mesh.Vertices.Count):
        v = mesh.Vertices[i]
        verts.append([float(v.X), float(v.Y), float(v.Z)])
        n = mesh.Normals[i]
        normals.append([float(n.X), float(n.Y), float(n.Z)])
    tris = []
    for i in range(mesh.Faces.Count):
        f = mesh.Faces[i]
        tris.append([f.A, f.B, f.C])
        if f.IsQuad:
            tris.append([f.A, f.C, f.D])
    return verts, normals, tris


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


def _breps_to_mesh(breps):
    """Convert Breps into a single clean Mesh for Three.js rendering.

    Each member is meshed and cleaned individually (normals unified per
    connected component) before joining, so winding is always consistent.
    SimplePlanes keeps flat box faces as minimal quads.
    Normals are computed once on the final joined mesh.
    """
    mp = rg.MeshingParameters.Default
    mp.SimplePlanes = True

    joined = rg.Mesh()
    for brep in breps:
        face_meshes = rg.Mesh.CreateFromBrep(brep, mp)
        if not face_meshes:
            continue
        part = rg.Mesh()
        for fm in face_meshes:
            part.Append(fm)
        part.Vertices.CombineIdentical(True, True)
        part.UnifyNormals()
        part.Compact()
        joined.Append(part)

    joined.FaceNormals.ComputeFaceNormals()
    joined.Normals.ComputeNormals()
    return joined


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
# Pure-Python geometry spec computation. Runs in dev AND prod — never touches
# RhinoCommon. The spec dicts it emits are JSON-serializable so dev can forward
# them to prod's /solve-frame endpoint for Brep construction + GH solve.
#
# Spec shapes (all boxes/extrusions/solids the frontend renders):
#   {"kind": "box",          "x": [x0,x1], "y": [y0,y1], "z": [z0,z1]}
#   {"kind": "extruded",     "pts": [[x,y,z], ...], "dir": [dx,dy,dz], "cap": bool}
#   {"kind": "planar_solid", "profile": [[x,y,z]]*4,  "dir": [dx,dy,dz]}
# ────────────────────────────────────────────────────────────────────────────


def _opening_spec(x0, y0, x1, y1, t, wall_idx, pos_along, opening_type,
                  interior_walls=None, iw_t=None,
                  width=None, height=None, sill=None):
    """Axis-aligned box spec for a door or window cutter."""
    default_w = WINDOW_W if opening_type == "window" else DOOR_W
    default_h = WINDOW_H if opening_type == "window" else DOOR_H
    default_sill = WINDOW_SILL if opening_type == "window" else 0
    ow = float(width) if width is not None else default_w
    oh = float(height) if height is not None else default_h
    z_base = float(sill) if (opening_type == "window" and sill is not None) else default_sill
    i_t = float(iw_t) if iw_t is not None else t
    # Extrude 50 mm past each face of the host wall so the cutter overshoots.
    pad = 50.0

    if wall_idx == 0:  # south wall, along +X
        cx = x0 + pos_along
        return {"kind": "box",
                "x": [cx - ow / 2, cx + ow / 2],
                "y": [y0 - pad, y0 + t + pad],
                "z": [z_base, z_base + oh]}
    if wall_idx == 1:  # north wall, along +X
        cx = x0 + pos_along
        return {"kind": "box",
                "x": [cx - ow / 2, cx + ow / 2],
                "y": [y1 - t - pad, y1 + pad],
                "z": [z_base, z_base + oh]}
    if wall_idx == 2:  # west wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        return {"kind": "box",
                "x": [x0 - pad, x0 + t + pad],
                "y": [cy - ow / 2, cy + ow / 2],
                "z": [z_base, z_base + oh]}
    if wall_idx == 3:  # east wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        return {"kind": "box",
                "x": [x1 - t - pad, x1 + pad],
                "y": [cy - ow / 2, cy + ow / 2],
                "z": [z_base, z_base + oh]}

    # Interior wall: wall_idx 4+ indexes into interior_walls list
    if not interior_walls:
        return None
    idx = wall_idx - 4
    if idx < 0 or idx >= len(interior_walls):
        return None
    iw = interior_walls[idx]
    ix0, iy0 = float(iw["x0"]), float(iw["y0"])
    ix1, iy1 = float(iw["x1"]), float(iw["y1"])
    is_horiz = abs(iy1 - iy0) < 1
    if is_horiz:
        xMin = min(ix0, ix1)
        cx = xMin + pos_along
        return {"kind": "box",
                "x": [cx - ow / 2, cx + ow / 2],
                "y": [iy0 - i_t / 2 - pad, iy0 + i_t / 2 + pad],
                "z": [z_base, z_base + oh]}
    yMin = min(iy0, iy1)
    cy = yMin + pos_along
    return {"kind": "box",
            "x": [ix0 - i_t / 2 - pad, ix0 + i_t / 2 + pad],
            "y": [cy - ow / 2, cy + ow / 2],
            "z": [z_base, z_base + oh]}


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


def _roof_specs(x0, y0, x1, y1, h, roof_type, ridge_h=None, flat_slope=None, t=0, roof_t=295):
    """Pure-Python roof geometry specs. No RhinoCommon."""
    # "none" → walls only, no roof members generated.
    if roof_type == "none":
        return []
    w = x1 - x0
    d = y1 - y0
    if flat_slope is None:
        flat_slope = [0, 0]

    if roof_type == "gable":
        if ridge_h is None:
            ridge_h = min(w, d) * 0.35
        slab = roof_t
        specs = []
        if w >= d:
            # Ridge along X. Roof extent in Y is [y0, y1] (flush with outer
            # long-wall faces) and in X is [x0+t, x1-t] (inside of pentagon
            # gable walls). s lifts the whole roof so the bottom plane passes
            # through the inner-top corner of the long walls.
            mid_y = (y0 + y1) / 2
            half_span = d / 2
            s = slab - ridge_h * t / half_span
            eave_z = h + s
            ridge_z = h + ridge_h + s
            x_len = w - 2 * t
            direction = [x_len, 0, 0]
            x_ref = x0 + t
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [x_ref, y0,    eave_z],
                [x_ref, mid_y, ridge_z],
                [x_ref, mid_y, ridge_z - slab],
                [x_ref, y0,    eave_z - slab],
            ]})
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [x_ref, mid_y, ridge_z],
                [x_ref, y1,    eave_z],
                [x_ref, y1,    eave_z - slab],
                [x_ref, mid_y, ridge_z - slab],
            ]})
        else:
            # Ridge along Y.
            mid_x = (x0 + x1) / 2
            half_span = w / 2
            s = slab - ridge_h * t / half_span
            eave_z = h + s
            ridge_z = h + ridge_h + s
            y_len = d - 2 * t
            direction = [0, y_len, 0]
            y_ref = y0 + t
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [x0,    y_ref, eave_z],
                [mid_x, y_ref, ridge_z],
                [mid_x, y_ref, ridge_z - slab],
                [x0,    y_ref, eave_z - slab],
            ]})
            specs.append({"kind": "planar_solid", "dir": direction, "profile": [
                [mid_x, y_ref, ridge_z],
                [x1,    y_ref, eave_z],
                [x1,    y_ref, eave_z - slab],
                [mid_x, y_ref, ridge_z - slab],
            ]})
        return specs

    # Flat roof — flush with outer wall footprint (no eaves).
    slab = roof_t
    f, b = flat_slope[0], flat_slope[1]
    if f == 0 and b == 0:
        return [{"kind": "box", "x": [x0, x1], "y": [y0, y1], "z": [h, h + slab]}]

    # Sloped flat roof: tilted slab. Slope is anchored at the wall footprint;
    # cross-section is a parallelogram extruded perpendicular to the slope axis.
    if w >= d:
        # Slope along Y, extrude along X.
        profile = [
            [x0, y0, h + f],
            [x0, y0, h + slab + f],
            [x0, y1, h + slab + b],
            [x0, y1, h + b],
        ]
        direction = [w, 0, 0]
    else:
        # Slope along X, extrude along Y.
        profile = [
            [x0, y0, h + f],
            [x0, y0, h + slab + f],
            [x1, y0, h + slab + b],
            [x1, y0, h + b],
        ]
        direction = [0, d, 0]
    return [{"kind": "planar_solid", "profile": profile, "dir": direction}]


def _exterior_wall_specs(x0, y0, x1, y1, h, t, roof_type, flat_slope,
                          roof_t, ridge_h, ridge_along_x):
    """Pure-Python exterior wall specs. Matches frontend buildRoom layout."""
    w = x1 - x0
    d = y1 - y0

    if ridge_along_x:
        # perp = W/E (full depth); long = S/N (inset)
        wall_specs_raw = [
            (x0 + t, y0,       w - 2 * t, t),  # south
            (x0 + t, y1 - t,   w - 2 * t, t),  # north
            (x0,     y0,       t,         d),  # west
            (x1 - t, y0,       t,         d),  # east
        ]
    else:
        # perp = S/N (full width); long = W/E (inset)
        wall_specs_raw = [
            (x0,     y0,       w,         t),
            (x0,     y1 - t,   w,         t),
            (x0,     y0 + t,   t,         d - 2 * t),
            (x1 - t, y0 + t,   t,         d - 2 * t),
        ]

    is_flat_sloped = roof_type == "flat" and (flat_slope[0] != 0 or flat_slope[1] != 0)

    if roof_type == "gable":
        gbl_half_span = (d / 2) if ridge_along_x else (w / 2)
        gbl_eave_lift = roof_t - ridge_h * t / gbl_half_span
        h_eave = h + gbl_eave_lift
        h_apex = h + ridge_h + gbl_eave_lift
    else:
        h_eave = h_apex = 0  # unused

    specs = []
    for i, (ox, oy, sx, sy) in enumerate(wall_specs_raw):
        if sx <= 0 or sy <= 0:
            continue
        is_gable_wall = roof_type == "gable" and (
            (ridge_along_x and i in (2, 3)) or
            (not ridge_along_x and i in (0, 1))
        )

        if is_gable_wall:
            # Pentagonal wall: rectangle + triangle up to ridge
            if ridge_along_x:
                # Gable ends are west/east: profile in YZ, extruded along X
                mid = sy / 2
                pts = [
                    [ox, oy, 0],
                    [ox, oy + sy, 0],
                    [ox, oy + sy, h_eave],
                    [ox, oy + mid, h_apex],
                    [ox, oy, h_eave],
                    [ox, oy, 0],
                ]
                direction = [sx, 0, 0]
            else:
                # Gable ends are south/north: profile in XZ, extruded along Y
                mid = sx / 2
                pts = [
                    [ox, oy, 0],
                    [ox + sx, oy, 0],
                    [ox + sx, oy, h_eave],
                    [ox + mid, oy, h_apex],
                    [ox, oy, h_eave],
                    [ox, oy, 0],
                ]
                direction = [0, sy, 0]
            specs.append({"kind": "extruded", "pts": pts, "dir": direction, "cap": True})
            continue

        if is_flat_sloped:
            is_trap = (ridge_along_x and i in (2, 3)) or (not ridge_along_x and i in (0, 1))
            if is_trap:
                if ridge_along_x:
                    # W/E walls run along Y: south end at flat_slope[0], north end at flat_slope[1]
                    h_start = h + flat_slope[0]
                    h_end = h + flat_slope[1]
                    pts = [
                        [ox, oy, 0],
                        [ox, oy + sy, 0],
                        [ox, oy + sy, h_end],
                        [ox, oy, h_start],
                        [ox, oy, 0],
                    ]
                    direction = [sx, 0, 0]
                else:
                    # S/N walls run along X: west end at flat_slope[0], east end at flat_slope[1]
                    h_start = h + flat_slope[0]
                    h_end = h + flat_slope[1]
                    pts = [
                        [ox, oy, 0],
                        [ox + sx, oy, 0],
                        [ox + sx, oy, h_end],
                        [ox, oy, h_start],
                        [ox, oy, 0],
                    ]
                    direction = [0, sy, 0]
                specs.append({"kind": "extruded", "pts": pts, "dir": direction, "cap": True})
                continue
            # Constant-height wall at the roof edge height
            if ridge_along_x:
                wall_h = h + flat_slope[0] if i == 0 else h + flat_slope[1]
            else:
                wall_h = h + flat_slope[0] if i == 2 else h + flat_slope[1]
            specs.append({"kind": "box",
                          "x": [ox, ox + sx], "y": [oy, oy + sy], "z": [0, wall_h]})
            continue

        # Default flat roof with no slope — simple box at wall height
        specs.append({"kind": "box",
                      "x": [ox, ox + sx], "y": [oy, oy + sy], "z": [0, h]})

    return specs


def _compute_iw_joints(interior_walls_list, iw_t, ix0=None, iy0=None, ix1=None, iy1=None):
    """Per-interior-wall retraction per end (side 0 = (x0,y0), side 1 = (x1,y1)).

    Matches the frontend's computeIwJoints. Retracts by iw_t / 2 when the wall
    end butts into (T) another interior wall's mid-span, or coincides with
    another's endpoint and loses the longer-wall tiebreak. Ends flush with an
    exterior inner face stay put.
    """
    EPS = 1.0

    def on_ext_face(x, y):
        if ix0 is None:
            return False
        on_v = (abs(x - ix0) < EPS or abs(x - ix1) < EPS) and iy0 - EPS <= y <= iy1 + EPS
        on_h = (abs(y - iy0) < EPS or abs(y - iy1) < EPS) and ix0 - EPS <= x <= ix1 + EPS
        return on_v or on_h

    def point_vs_wall(px, py, w):
        wy0, wy1 = float(w["y0"]), float(w["y1"])
        wx0, wx1 = float(w["x0"]), float(w["x1"])
        is_horiz = abs(wy1 - wy0) < 1
        if is_horiz:
            if abs(py - wy0) > EPS:
                return None
            xmn, xmx = min(wx0, wx1), max(wx0, wx1)
            if abs(px - xmn) < EPS or abs(px - xmx) < EPS:
                return "endpoint"
            if xmn + EPS < px < xmx - EPS:
                return "mid"
            return None
        if abs(px - wx0) > EPS:
            return None
        ymn, ymx = min(wy0, wy1), max(wy0, wy1)
        if abs(py - ymn) < EPS or abs(py - ymx) < EPS:
            return "endpoint"
        if ymn + EPS < py < ymx - EPS:
            return "mid"
        return None

    def wall_len(w):
        return ((float(w["x1"]) - float(w["x0"])) ** 2 +
                (float(w["y1"]) - float(w["y0"])) ** 2) ** 0.5

    retractions = [[0.0, 0.0] for _ in interior_walls_list]
    for i, w in enumerate(interior_walls_list):
        my_len = wall_len(w)
        ends = [(float(w["x0"]), float(w["y0"]), 0), (float(w["x1"]), float(w["y1"]), 1)]
        for x, y, side in ends:
            if on_ext_face(x, y):
                continue
            mid = 0
            endpoint_hits = []  # (idx, len)
            for j, w2 in enumerate(interior_walls_list):
                if j == i:
                    continue
                rel = point_vs_wall(x, y, w2)
                if rel == "mid":
                    mid += 1
                elif rel == "endpoint":
                    endpoint_hits.append((j, wall_len(w2)))
            if mid > 0:
                retractions[i][side] = iw_t / 2
                continue
            if endpoint_hits:
                winner_idx, winner_len = i, my_len
                for j, L in endpoint_hits:
                    if L > winner_len + EPS or (abs(L - winner_len) < EPS and j < winner_idx):
                        winner_idx, winner_len = j, L
                if winner_idx != i:
                    retractions[i][side] = iw_t / 2
    return retractions


def _interior_wall_specs(interior_walls_list, iw_t, h, iw_to_ridge,
                          ridge_along_x, ridge_h,
                          gbl_half_span, gbl_h_eave_under, gbl_h_apex_under,
                          gbl_center_x, gbl_center_y,
                          ext_ix0=None, ext_iy0=None, ext_ix1=None, ext_iy1=None):
    """Pure-Python interior wall specs (simple boxes, or gable-profile when iw_to_ridge).

    Applies joint retractions at each end so T-junctions and L-corners render
    cleanly against the current iw_t (and automatically re-resolve on change).
    """
    joints = _compute_iw_joints(interior_walls_list, iw_t,
                                 ix0=ext_ix0, iy0=ext_iy0, ix1=ext_ix1, iy1=ext_iy1)
    specs = []
    for i, iw in enumerate(interior_walls_list):
        ix0, iy0 = float(iw["x0"]), float(iw["y0"])
        ix1, iy1 = float(iw["x1"]), float(iw["y1"])
        is_horiz = abs(iy1 - iy0) < 1
        r0, r1 = joints[i]
        # Retractions at the lower / upper coord ends.
        if is_horiz:
            low_retract  = r0 if ix0 <= ix1 else r1
            high_retract = r1 if ix0 <= ix1 else r0
            bx0 = min(ix0, ix1) + low_retract
            bx1 = max(ix0, ix1) - high_retract
            by0 = iy0 - iw_t / 2
            by1 = iy0 + iw_t / 2
        else:
            low_retract  = r0 if iy0 <= iy1 else r1
            high_retract = r1 if iy0 <= iy1 else r0
            bx0 = ix0 - iw_t / 2
            bx1 = ix0 + iw_t / 2
            by0 = min(iy0, iy1) + low_retract
            by1 = max(iy0, iy1) - high_retract
        if bx1 - bx0 < 1 or by1 - by0 < 1:
            continue

        if iw_to_ridge:
            # Pentagon/trapezoid profile that follows the gable underside.
            def _underside(xw, yw):
                if ridge_along_x:
                    dist = min(gbl_half_span, abs(yw - gbl_center_y))
                else:
                    dist = min(gbl_half_span, abs(xw - gbl_center_x))
                return gbl_h_eave_under + ridge_h * (1 - dist / gbl_half_span)

            if is_horiz:
                y_wall = iy0
                z_left = _underside(bx0, y_wall)
                z_right = _underside(bx1, y_wall)
                pts = [
                    [bx0, by0, 0],
                    [bx1, by0, 0],
                    [bx1, by0, z_right],
                ]
                # Peak only if ridge is perpendicular to the wall and crosses it
                if (not ridge_along_x) and bx0 + 1 < gbl_center_x < bx1 - 1:
                    pts.append([gbl_center_x, by0, gbl_h_apex_under])
                pts.append([bx0, by0, z_left])
                pts.append([bx0, by0, 0])
                direction = [0, iw_t, 0]
            else:
                x_wall = ix0
                z_bot = _underside(x_wall, by0)
                z_top = _underside(x_wall, by1)
                pts = [
                    [bx0, by0, 0],
                    [bx0, by1, 0],
                    [bx0, by1, z_top],
                ]
                if ridge_along_x and by0 + 1 < gbl_center_y < by1 - 1:
                    pts.append([bx0, gbl_center_y, gbl_h_apex_under])
                pts.append([bx0, by0, z_bot])
                pts.append([bx0, by0, 0])
                direction = [iw_t, 0, 0]
            specs.append({"kind": "extruded", "pts": pts, "dir": direction, "cap": True})
        else:
            specs.append({"kind": "box",
                          "x": [bx0, bx1], "y": [by0, by1], "z": [0, h]})
    return specs


def _compute_geometry_specs(data):
    """Parse request data and return the full spec bundle for /solve-frame.

    Pure Python. No RhinoCommon. The output is JSON-serializable so dev can
    forward it verbatim to prod's /solve-frame endpoint.
    """
    x0 = float(data["x0"])
    y0 = float(data["y0"])
    x1 = float(data["x1"])
    y1 = float(data["y1"])
    h = float(data.get("height", 2400))
    t = float(data.get("thickness", 150))
    roof_t = float(data.get("roofThickness", 295))

    w = x1 - x0
    d = y1 - y0

    roof_type = data.get("roofType", "flat")
    default_ridge = min(w, d) * 0.35
    ridge_h = float(data.get("ridgeH", default_ridge)) if roof_type == "gable" else 0
    ridge_along_x = w >= d

    flat_slope = data.get("flatSlopeH", [0, 0])

    iw_t = float(data.get("interiorThickness", t))
    iw_to_ridge = bool(data.get("iwToRidge")) and roof_type == "gable"
    interior_walls = data.get("interiorWalls", [])

    # Gable parameters (shared by exterior walls AND iw-to-ridge interior walls)
    if roof_type == "gable":
        gbl_half_span = (d / 2) if ridge_along_x else (w / 2)
        gbl_eave_lift = roof_t - ridge_h * t / gbl_half_span
        # Interior walls with iwToRidge stop at the roof UNDERSIDE (one slab
        # below roof top), matching the frontend. The exterior gable pentagon
        # walls go all the way up to the roof TOP and compute their own apex
        # locally in _exterior_wall_specs.
        gbl_h_eave_under = h + gbl_eave_lift - roof_t
        gbl_h_apex_under = h + ridge_h + gbl_eave_lift - roof_t
        gbl_center_x = (x0 + x1) / 2
        gbl_center_y = (y0 + y1) / 2
    else:
        gbl_half_span = gbl_h_eave_under = gbl_h_apex_under = 0
        gbl_center_x = gbl_center_y = 0

    wall_specs = _exterior_wall_specs(x0, y0, x1, y1, h, t, roof_type, flat_slope,
                                       roof_t, ridge_h, ridge_along_x)
    # Inner footprint (where interior walls actually live) — used to detect "end
    # lands on exterior face" for joint retraction.
    wall_specs += _interior_wall_specs(interior_walls, iw_t, h, iw_to_ridge,
                                        ridge_along_x, ridge_h,
                                        gbl_half_span, gbl_h_eave_under, gbl_h_apex_under,
                                        gbl_center_x, gbl_center_y,
                                        ext_ix0=x0 + t, ext_iy0=y0 + t,
                                        ext_ix1=x1 - t, ext_iy1=y1 - t)

    door_specs = []
    window_specs = []
    for op in data.get("openings", []):
        spec = _opening_spec(x0, y0, x1, y1, t,
                             int(op["wallIdx"]), float(op["posAlong"]), op["type"],
                             interior_walls=interior_walls, iw_t=iw_t,
                             width=op.get("width"), height=op.get("height"),
                             sill=op.get("sill"))
        if spec is None:
            continue
        (door_specs if op["type"] == "door" else window_specs).append(spec)

    roof_spec_list = _roof_specs(x0, y0, x1, y1, h, roof_type,
                                  ridge_h=ridge_h if roof_type == "gable" else None,
                                  flat_slope=flat_slope, t=t, roof_t=roof_t)

    try:
        material_factor = float(data.get("materialFactor", 3.1))
    except (TypeError, ValueError):
        material_factor = 3.1
    try:
        fab_factor = float(data.get("fabFactor", 1.0))
    except (TypeError, ValueError):
        fab_factor = 1.0
    return {
        "walls": wall_specs,
        "roof": roof_spec_list,
        "doors": door_specs,
        "windows": window_specs,
        "material_factor": material_factor,
        "fab_factor": fab_factor,
    }


# ────────────────────────────────────────────────────────────────────────────
# Rhino-dependent Brep construction (only reached when RHINO_AVAILABLE).
# ────────────────────────────────────────────────────────────────────────────


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


@app.route("/generate", methods=["POST"])
@requires_rhino
def generate():
    data = request.get_json()
    mesh = generate_box(float(data["width"]), float(data["depth"]), float(data["height"]))
    if not mesh.IsValid:
        return jsonify({"error": "Generated mesh is invalid"}), 400

    fd, path = tempfile.mkstemp(suffix=".3dm")
    os.close(fd)
    model = rio.File3dm()
    model.Objects.AddMesh(mesh)
    opts = rio.File3dmWriteOptions()
    opts.Version = 7
    model.Write(path, opts)
    with open(path, "rb") as f:
        buf = io.BytesIO(f.read())
    os.unlink(path)
    buf.seek(0)
    return send_file(buf, as_attachment=True, download_name="box.3dm",
                     mimetype="application/octet-stream")


@app.route("/frame", methods=["POST"])
@requires_rhino
def frame():
    try:
        data = request.get_json()
        members = frame_wall(
            start_x=float(data["start_x"]),
            start_y=float(data["start_y"]),
            end_x=float(data["end_x"]),
            end_y=float(data["end_y"]),
            height=float(data.get("height", 2400)),
            stud_spacing=float(data.get("stud_spacing", 600)),
            stud_width=float(data.get("stud_width", 45)),
            stud_depth=float(data.get("stud_depth", 90)),
        )

        # Save Breps to .3dm
        saved_path = _save_breps_3dm(members, "wall_frame.3dm")

        # Convert Breps → single Mesh → triangles for three.js
        mesh = _breps_to_mesh(members)
        all_verts, all_normals, all_tris = _mesh_to_triangles(mesh)

        return jsonify({
            "vertices": all_verts,
            "normals": all_normals,
            "faces": all_tris,
            "member_count": len(members),
            "file_saved": saved_path,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


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
        specs = _compute_geometry_specs(data)

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


@app.route("/solve-gh", methods=["POST"])
@requires_rhino
def solve_gh():
    try:
        data = request.get_json()
        start_x = float(data["start_x"])
        start_y = float(data["start_y"])
        end_x = float(data["end_x"])
        end_y = float(data["end_y"])
        height = float(data.get("height", 2400))
        stud_depth = float(data.get("stud_depth", 90))

        # Build a single wall box Brep for the GH definition
        dx = end_x - start_x
        dy = end_y - start_y
        wall_length = math.hypot(dx, dy)

        # Local axes: along wall, perpendicular, up
        x_vec = rg.Vector3d(dx / wall_length, dy / wall_length, 0)
        y_vec = rg.Vector3d(-dy / wall_length, dx / wall_length, 0)
        z_vec = rg.Vector3d(0, 0, 1)

        origin = rg.Point3d(start_x, start_y, 0)
        plane = rg.Plane(origin, x_vec, y_vec)
        box = rg.Box(plane, rg.Interval(0, wall_length),
                     rg.Interval(0, stud_depth),
                     rg.Interval(0, height))
        wall_brep = box.ToBrep()

        # Solve the GH definition with the wall box
        outputs = solve_definition("generator_3.0.gh", {"WallBreps": [wall_brep]})

        # Use MeshOut for display
        joined = rg.Mesh()
        for geom in outputs.get("MeshOut", []):
            if isinstance(geom, rg.Mesh):
                joined.Append(geom)
            elif getattr(geom, "GetType", lambda: None)() and geom.GetType().Name == "Mesh":
                joined.Append(geom)
        joined.FaceNormals.ComputeFaceNormals()
        joined.Normals.ComputeNormals()
        verts, normals, tris = _mesh_to_triangles(joined)

        return jsonify({
            "vertices": verts,
            "normals": normals,
            "faces": tris,
            "result_count": len(outputs.get("MeshOut", [])),
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


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
