"""Flask app – wall framing via rhinoinside."""
import io
import os
import tempfile

# Ensure Rhino's native DLLs are findable
RHINO_SYSTEM = r"C:\Program Files\Rhino 8\System"
os.environ["PATH"] = RHINO_SYSTEM + os.pathsep + os.environ.get("PATH", "")

# rhinoinside must load before any Rhino imports
import rhinoinside
rhinoinside.load(RHINO_SYSTEM, "net8.0")

from flask import Flask, request, send_file, jsonify
from box_gen import generate_box
from wall_framer import frame_wall
from gh_runner import solve_definition

import System
import Rhino.FileIO as rio
import Rhino.Geometry as rg

import math

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "output")

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


def _build_opening_brep(x0, y0, x1, y1, t, wall_idx, pos_along, opening_type,
                         interior_walls=None, iw_t=None,
                         width=None, height=None, sill=None):
    """Create a box Brep representing a door or window opening in a wall.

    `width`/`height`/`sill` override the type defaults when the frontend
    supplies per-opening dimensions. `iw_t` is interior-wall thickness
    (falls back to `t` when not provided).
    """
    default_w = WINDOW_W if opening_type == "window" else DOOR_W
    default_h = WINDOW_H if opening_type == "window" else DOOR_H
    default_sill = WINDOW_SILL if opening_type == "window" else 0
    ow = float(width) if width is not None else default_w
    oh = float(height) if height is not None else default_h
    z_base = float(sill) if (opening_type == "window" and sill is not None) else default_sill
    i_t = float(iw_t) if iw_t is not None else t
    # Openings extrude 50 mm past each face of the host wall so the cutter
    # Brep reliably overshoots the wall on both sides (total +100 mm thicker).
    pad = 50.0

    if wall_idx == 0:  # south wall, along +X
        cx = x0 + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(cx - ow / 2, cx + ow / 2),
                     rg.Interval(y0 - pad, y0 + t + pad),
                     rg.Interval(z_base, z_base + oh))
    elif wall_idx == 1:  # north wall, along +X
        cx = x0 + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(cx - ow / 2, cx + ow / 2),
                     rg.Interval(y1 - t - pad, y1 + pad),
                     rg.Interval(z_base, z_base + oh))
    elif wall_idx == 2:  # west wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(x0 - pad, x0 + t + pad),
                     rg.Interval(cy - ow / 2, cy + ow / 2),
                     rg.Interval(z_base, z_base + oh))
    elif wall_idx == 3:  # east wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(x1 - t - pad, x1 + pad),
                     rg.Interval(cy - ow / 2, cy + ow / 2),
                     rg.Interval(z_base, z_base + oh))
    else:
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
            box = rg.Box(rg.Plane.WorldXY,
                         rg.Interval(cx - ow / 2, cx + ow / 2),
                         rg.Interval(iy0 - i_t / 2 - pad, iy0 + i_t / 2 + pad),
                         rg.Interval(z_base, z_base + oh))
        else:
            yMin = min(iy0, iy1)
            cy = yMin + pos_along
            box = rg.Box(rg.Plane.WorldXY,
                         rg.Interval(ix0 - i_t / 2 - pad, ix0 + i_t / 2 + pad),
                         rg.Interval(cy - ow / 2, cy + ow / 2),
                         rg.Interval(z_base, z_base + oh))
    return box.ToBrep()


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


def _build_roof_breps(x0, y0, x1, y1, h, roof_type, ridge_h=None, flat_slope=None, t=0, roof_t=295):
    """Create roof as closed-solid Brep(s) matching the frontend visualization.

    Each returned Brep has 6 planar faces so the Grasshopper definition can
    treat the roof as solid geometry.
    """
    w = x1 - x0
    d = y1 - y0
    overhang = 200
    if flat_slope is None:
        flat_slope = [0, 0]

    if roof_type == "gable":
        if ridge_h is None:
            ridge_h = min(w, d) * 0.35
        slab = roof_t
        breps = []
        if w >= d:
            # Ridge along X. No eaves: roof extent in Y is [y0, y1] (flush with
            # outer long-wall faces) and in X is [x0+t, x1-t] (inside of
            # pentagon gable walls). s lifts the whole roof so the bottom plane
            # passes through the inner-top corner of the long walls.
            mid_y = (y0 + y1) / 2
            half_span = d / 2
            s = slab - ridge_h * t / half_span
            eave_z = h + s
            ridge_z = h + ridge_h + s
            x_len = w - 2 * t
            ext = rg.Vector3d(x_len, 0, 0)
            x_ref = x0 + t
            south_profile = [
                rg.Point3d(x_ref, y0,    eave_z),
                rg.Point3d(x_ref, mid_y, ridge_z),
                rg.Point3d(x_ref, mid_y, ridge_z - slab),
                rg.Point3d(x_ref, y0,    eave_z - slab),
            ]
            north_profile = [
                rg.Point3d(x_ref, mid_y, ridge_z),
                rg.Point3d(x_ref, y1,    eave_z),
                rg.Point3d(x_ref, y1,    eave_z - slab),
                rg.Point3d(x_ref, mid_y, ridge_z - slab),
            ]
            for prof in (south_profile, north_profile):
                solid = _solid_from_profile(prof, ext)
                if solid:
                    breps.append(solid)
        else:
            # Ridge along Y. No eaves in X, inset by t in Y (pentagon inside).
            mid_x = (x0 + x1) / 2
            half_span = w / 2
            s = slab - ridge_h * t / half_span
            eave_z = h + s
            ridge_z = h + ridge_h + s
            y_len = d - 2 * t
            ext = rg.Vector3d(0, y_len, 0)
            y_ref = y0 + t
            west_profile = [
                rg.Point3d(x0,    y_ref, eave_z),
                rg.Point3d(mid_x, y_ref, ridge_z),
                rg.Point3d(mid_x, y_ref, ridge_z - slab),
                rg.Point3d(x0,    y_ref, eave_z - slab),
            ]
            east_profile = [
                rg.Point3d(mid_x, y_ref, ridge_z),
                rg.Point3d(x1,    y_ref, eave_z),
                rg.Point3d(x1,    y_ref, eave_z - slab),
                rg.Point3d(mid_x, y_ref, ridge_z - slab),
            ]
            for prof in (west_profile, east_profile):
                solid = _solid_from_profile(prof, ext)
                if solid:
                    breps.append(solid)
        return breps

    # Flat roof (possibly sloped)
    slab = roof_t
    f, b = flat_slope[0], flat_slope[1]
    if f == 0 and b == 0:
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(x0 - overhang, x1 + overhang),
                     rg.Interval(y0 - overhang, y1 + overhang),
                     rg.Interval(h, h + slab))
        return [box.ToBrep()]

    # Sloped flat roof: tilted slab. Slope is anchored at the wall footprint
    # (y0/y1 or x0/x1); overhang edges extrapolate outward so the roof bottom
    # meets the wall tops exactly. Cross-section is a parallelogram extruded
    # along the non-slope axis to get a closed 6-face solid.
    if w >= d:
        # Slope along Y.
        m = (b - f) / d
        f_oh = f - m * overhang
        b_oh = b + m * overhang
        profile = [
            rg.Point3d(x0 - overhang, y0 - overhang, h + f_oh),
            rg.Point3d(x0 - overhang, y0 - overhang, h + slab + f_oh),
            rg.Point3d(x0 - overhang, y1 + overhang, h + slab + b_oh),
            rg.Point3d(x0 - overhang, y1 + overhang, h + b_oh),
        ]
        ext = rg.Vector3d(w + 2 * overhang, 0, 0)
    else:
        # Slope along X.
        m = (b - f) / w
        f_oh = f - m * overhang
        b_oh = b + m * overhang
        profile = [
            rg.Point3d(x0 - overhang, y0 - overhang, h + f_oh),
            rg.Point3d(x0 - overhang, y0 - overhang, h + slab + f_oh),
            rg.Point3d(x1 + overhang, y0 - overhang, h + slab + b_oh),
            rg.Point3d(x1 + overhang, y0 - overhang, h + b_oh),
        ]
        ext = rg.Vector3d(0, d + 2 * overhang, 0)
    solid = _solid_from_profile(profile, ext)
    return [solid] if solid else []


# ── routes ──

@app.route("/")
def index():
    return send_file(os.path.join(app.static_folder, "index.html"))


@app.route("/generate", methods=["POST"])
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


@app.route("/generate-frame", methods=["POST"])
def generate_frame():
    try:
        data = request.get_json()
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

        # Wall layout must match frontend buildRoom (index.html):
        # perp walls (perpendicular to the ridge) own the corners and run full
        # length; parallel walls are inset by t on each end. This keeps gable
        # profiles and sloped-flat trapezoids attached to the corners.
        if ridge_along_x:
            # perp = W/E (full depth); long = S/N (inset)
            wall_specs = [
                (x0 + t, y0,       w - 2 * t, t),  # south
                (x0 + t, y1 - t,   w - 2 * t, t),  # north
                (x0,     y0,       t,         d),  # west
                (x1 - t, y0,       t,         d),  # east
            ]
        else:
            # perp = S/N (full width); long = W/E (inset)
            wall_specs = [
                (x0,     y0,       w,         t),          # south
                (x0,     y1 - t,   w,         t),          # north
                (x0,     y0 + t,   t,         d - 2 * t),  # west
                (x1 - t, y0 + t,   t,         d - 2 * t),  # east
            ]

        flat_slope = data.get("flatSlopeH", [0, 0])
        is_flat_sloped = roof_type == "flat" and (flat_slope[0] != 0 or flat_slope[1] != 0)

        # Gable geometry (shared by exterior gable walls AND iw-to-ridge interior walls)
        if roof_type == "gable":
            gbl_half_span = (d / 2) if ridge_along_x else (w / 2)
            gbl_eave_lift = roof_t - ridge_h * t / gbl_half_span
            gbl_h_eave = h + gbl_eave_lift
            gbl_h_apex = h + ridge_h + gbl_eave_lift
            gbl_center_x = (x0 + x1) / 2
            gbl_center_y = (y0 + y1) / 2
        else:
            gbl_half_span = gbl_eave_lift = gbl_h_eave = gbl_h_apex = 0
            gbl_center_x = gbl_center_y = 0

        wall_breps = []
        for i, (ox, oy, sx, sy) in enumerate(wall_specs):
            if sx <= 0 or sy <= 0:
                continue
            # Check if this is a gable-end wall
            is_gable_wall = roof_type == "gable" and (
                (ridge_along_x and i in (2, 3)) or
                (not ridge_along_x and i in (0, 1))
            )
            if is_gable_wall:
                # Pentagonal wall: rectangle + triangle up to ridge
                # Build pentagon profile as closed polyline, then extrude
                # Eave lift: raise the two sloped top edges by s = t * tan(slope) so the
                # long walls stay at h while the gable pentagon rises above them.
                half_span = gbl_half_span
                h_eave = gbl_h_eave
                h_apex = gbl_h_apex
                if ridge_along_x:
                    # Gable ends are west/east: profile in YZ, extruded along X
                    mid = sy / 2
                    pts = [
                        rg.Point3d(ox, oy, 0),
                        rg.Point3d(ox, oy + sy, 0),
                        rg.Point3d(ox, oy + sy, h_eave),
                        rg.Point3d(ox, oy + mid, h_apex),
                        rg.Point3d(ox, oy, h_eave),
                        rg.Point3d(ox, oy, 0),
                    ]
                    direction = rg.Vector3d(sx, 0, 0)
                else:
                    # Gable ends are south/north: profile in XZ, extruded along Y
                    mid = sx / 2
                    pts = [
                        rg.Point3d(ox, oy, 0),
                        rg.Point3d(ox + sx, oy, 0),
                        rg.Point3d(ox + sx, oy, h_eave),
                        rg.Point3d(ox + mid, oy, h_apex),
                        rg.Point3d(ox, oy, h_eave),
                        rg.Point3d(ox, oy, 0),
                    ]
                    direction = rg.Vector3d(0, sy, 0)
                curve = rg.PolylineCurve(System.Array[rg.Point3d](pts))
                srf = rg.Surface.CreateExtrusion(curve, direction)
                brep = srf.ToBrep()
                capped = brep.CapPlanarHoles(1.0)
                wall_breps.append(capped if capped else brep)
            elif is_flat_sloped:
                # Flat roof with slope — trapezoidal or taller box walls
                is_trap = (ridge_along_x and i in (2, 3)) or (not ridge_along_x and i in (0, 1))
                if is_trap:
                    # Trapezoidal wall: different heights at each end
                    if ridge_along_x:
                        # West/east walls run along Y: south end at flat_slope[0], north end at flat_slope[1]
                        h_start = h + flat_slope[0]  # at oy (south end)
                        h_end = h + flat_slope[1]    # at oy+sy (north end)
                        pts = [
                            rg.Point3d(ox, oy, 0),
                            rg.Point3d(ox, oy + sy, 0),
                            rg.Point3d(ox, oy + sy, h_end),
                            rg.Point3d(ox, oy, h_start),
                            rg.Point3d(ox, oy, 0),
                        ]
                        direction = rg.Vector3d(sx, 0, 0)
                    else:
                        # South/north walls run along X: west end at flat_slope[0], east end at flat_slope[1]
                        h_start = h + flat_slope[0]  # at ox (west end)
                        h_end = h + flat_slope[1]    # at ox+sx (east end)
                        pts = [
                            rg.Point3d(ox, oy, 0),
                            rg.Point3d(ox + sx, oy, 0),
                            rg.Point3d(ox + sx, oy, h_end),
                            rg.Point3d(ox, oy, h_start),
                            rg.Point3d(ox, oy, 0),
                        ]
                        direction = rg.Vector3d(0, sy, 0)
                    curve = rg.PolylineCurve(System.Array[rg.Point3d](pts))
                    srf = rg.Surface.CreateExtrusion(curve, direction)
                    brep = srf.ToBrep()
                    capped = brep.CapPlanarHoles(1.0)
                    wall_breps.append(capped if capped else brep)
                else:
                    # Constant-height wall at the roof edge height
                    if ridge_along_x:
                        wall_h = h + flat_slope[0] if i == 0 else h + flat_slope[1]
                    else:
                        wall_h = h + flat_slope[0] if i == 2 else h + flat_slope[1]
                    box = rg.Box(
                        rg.Plane.WorldXY,
                        rg.Interval(ox, ox + sx),
                        rg.Interval(oy, oy + sy),
                        rg.Interval(0, wall_h),
                    )
                    wall_breps.append(box.ToBrep())
            else:
                box = rg.Box(
                    rg.Plane.WorldXY,
                    rg.Interval(ox, ox + sx),
                    rg.Interval(oy, oy + sy),
                    rg.Interval(0, h),
                )
                wall_breps.append(box.ToBrep())

        # Build interior wall Breps (uses its own thickness, not exterior t)
        iw_t = float(data.get("interiorThickness", t))
        iw_to_ridge = bool(data.get("iwToRidge")) and roof_type == "gable"
        for iw in data.get("interiorWalls", []):
            ix0, iy0 = float(iw["x0"]), float(iw["y0"])
            ix1, iy1 = float(iw["x1"]), float(iw["y1"])
            is_horiz = abs(iy1 - iy0) < 1  # horizontal = same y
            if is_horiz:
                bx0 = min(ix0, ix1)
                bx1 = max(ix0, ix1)
                by0 = iy0 - iw_t / 2
                by1 = iy0 + iw_t / 2
            else:
                bx0 = ix0 - iw_t / 2
                bx1 = ix0 + iw_t / 2
                by0 = min(iy0, iy1)
                by1 = max(iy0, iy1)

            if iw_to_ridge:
                # Build pentagon/trapezoid profile that follows the gable underside,
                # then extrude by iw_t perpendicular to the wall length.
                def _underside(xw, yw):
                    if ridge_along_x:
                        dist = min(gbl_half_span, abs(yw - gbl_center_y))
                    else:
                        dist = min(gbl_half_span, abs(xw - gbl_center_x))
                    return gbl_h_eave + ridge_h * (1 - dist / gbl_half_span)

                if is_horiz:
                    y_wall = iy0
                    z_left = _underside(bx0, y_wall)
                    z_right = _underside(bx1, y_wall)
                    pts = [
                        rg.Point3d(bx0, by0, 0),
                        rg.Point3d(bx1, by0, 0),
                        rg.Point3d(bx1, by0, z_right),
                    ]
                    # Peak only if ridge is perpendicular to the wall and crosses it
                    if (not ridge_along_x) and bx0 + 1 < gbl_center_x < bx1 - 1:
                        pts.append(rg.Point3d(gbl_center_x, by0, gbl_h_apex))
                    pts.append(rg.Point3d(bx0, by0, z_left))
                    pts.append(rg.Point3d(bx0, by0, 0))
                    direction = rg.Vector3d(0, iw_t, 0)
                else:
                    x_wall = ix0
                    z_bot = _underside(x_wall, by0)
                    z_top = _underside(x_wall, by1)
                    pts = [
                        rg.Point3d(bx0, by0, 0),
                        rg.Point3d(bx0, by1, 0),
                        rg.Point3d(bx0, by1, z_top),
                    ]
                    if ridge_along_x and by0 + 1 < gbl_center_y < by1 - 1:
                        pts.append(rg.Point3d(bx0, gbl_center_y, gbl_h_apex))
                    pts.append(rg.Point3d(bx0, by0, z_bot))
                    pts.append(rg.Point3d(bx0, by0, 0))
                    direction = rg.Vector3d(iw_t, 0, 0)

                curve = rg.PolylineCurve(System.Array[rg.Point3d](pts))
                srf = rg.Surface.CreateExtrusion(curve, direction)
                brep = srf.ToBrep()
                capped = brep.CapPlanarHoles(1.0)
                wall_breps.append(capped if capped else brep)
            else:
                box = rg.Box(
                    rg.Plane.WorldXY,
                    rg.Interval(bx0, bx1),
                    rg.Interval(by0, by1),
                    rg.Interval(0, h),
                )
                wall_breps.append(box.ToBrep())

        # Build opening Breps from frontend placement data
        door_breps = []
        window_breps = []
        interior_walls = data.get("interiorWalls", [])
        for op in data.get("openings", []):
            brep = _build_opening_brep(
                x0, y0, x1, y1, t,
                int(op["wallIdx"]), float(op["posAlong"]), op["type"],
                interior_walls=interior_walls, iw_t=iw_t,
                width=op.get("width"), height=op.get("height"), sill=op.get("sill"),
            )
            if brep:
                (door_breps if op["type"] == "door" else window_breps).append(brep)

        # Build roof Breps
        roof_breps = _build_roof_breps(x0, y0, x1, y1, h,
                                       roof_type,
                                       ridge_h=ridge_h if roof_type == "gable" else None,
                                       flat_slope=flat_slope,
                                       t=t,
                                       roof_t=roof_t)

        gh_file = "test_simple.gh" if data.get("devSimple") else "generator_3.0.gh"
        outputs = solve_definition(gh_file, {
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
                    w_mm, d_mm = (int(round(float(x))) for x in sec_str.split("x"))
                except Exception:
                    w_mm, d_mm = 0, 0
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

        # Pricing in DKK: structural C24 timber ~3350 DKK/m³ + 35% fabrication
        timber_cost = total_volume_m3 * 3350
        price = timber_cost * 1.35

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
                "timber_cost": round(timber_cost, 2),
                "price": round(price, 2),
                "part_list": part_list,
            },
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/solve-gh", methods=["POST"])
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


if __name__ == "__main__":
    print("Server running at http://localhost:5000")
    app.run(debug=False, port=5000, threaded=False)
