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


def _build_opening_brep(x0, y0, x1, y1, t, wall_idx, pos_along, opening_type):
    """Create a box Brep representing a door or window opening in a wall."""
    ow = WINDOW_W if opening_type == "window" else DOOR_W
    oh = WINDOW_H if opening_type == "window" else DOOR_H
    z_base = WINDOW_SILL if opening_type == "window" else 0

    if wall_idx == 0:  # south wall, along +X
        cx = x0 + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(cx - ow / 2, cx + ow / 2),
                     rg.Interval(y0, y0 + t),
                     rg.Interval(z_base, z_base + oh))
    elif wall_idx == 1:  # north wall, along +X
        cx = x0 + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(cx - ow / 2, cx + ow / 2),
                     rg.Interval(y1 - t, y1),
                     rg.Interval(z_base, z_base + oh))
    elif wall_idx == 2:  # west wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(x0, x0 + t),
                     rg.Interval(cy - ow / 2, cy + ow / 2),
                     rg.Interval(z_base, z_base + oh))
    elif wall_idx == 3:  # east wall, along +Y (origin at y0+t)
        cy = y0 + t + pos_along
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(x1 - t, x1),
                     rg.Interval(cy - ow / 2, cy + ow / 2),
                     rg.Interval(z_base, z_base + oh))
    else:
        return None
    return box.ToBrep()


def _build_roof_breps(x0, y0, x1, y1, h, roof_type, ridge_h=None, flat_slope=None):
    """Create roof Brep(s) matching the frontend roof visualization."""
    w = x1 - x0
    d = y1 - y0
    overhang = 200
    if flat_slope is None:
        flat_slope = [0, 0]

    if roof_type == "gable":
        if ridge_h is None:
            ridge_h = min(w, d) * 0.35
        faces = []
        if w >= d:
            # Ridge along X; two faces: south slope, north slope
            mid_y = (y0 + y1) / 2
            faces.append([
                rg.Point3d(x0 - overhang, y0 - overhang, h),
                rg.Point3d(x1 + overhang, y0 - overhang, h),
                rg.Point3d(x1 + overhang, mid_y, h + ridge_h),
                rg.Point3d(x0 - overhang, mid_y, h + ridge_h),
            ])
            faces.append([
                rg.Point3d(x0 - overhang, mid_y, h + ridge_h),
                rg.Point3d(x1 + overhang, mid_y, h + ridge_h),
                rg.Point3d(x1 + overhang, y1 + overhang, h),
                rg.Point3d(x0 - overhang, y1 + overhang, h),
            ])
        else:
            # Ridge along Y; two faces: west slope, east slope
            mid_x = (x0 + x1) / 2
            faces.append([
                rg.Point3d(x0 - overhang, y0 - overhang, h),
                rg.Point3d(x0 - overhang, y1 + overhang, h),
                rg.Point3d(mid_x, y1 + overhang, h + ridge_h),
                rg.Point3d(mid_x, y0 - overhang, h + ridge_h),
            ])
            faces.append([
                rg.Point3d(mid_x, y0 - overhang, h + ridge_h),
                rg.Point3d(mid_x, y1 + overhang, h + ridge_h),
                rg.Point3d(x1 + overhang, y1 + overhang, h),
                rg.Point3d(x1 + overhang, y0 - overhang, h),
            ])
        breps = []
        for pts in faces:
            pts_closed = pts + [pts[0]]
            curve = rg.PolylineCurve(System.Array[rg.Point3d](pts_closed))
            brep = rg.Brep.CreatePlanarBreps(curve, 1.0)
            if brep and len(brep) > 0:
                breps.append(brep[0])
        return breps

    # Default: flat roof (possibly sloped)
    slab = 120
    f, b = flat_slope[0], flat_slope[1]
    if f == 0 and b == 0:
        box = rg.Box(rg.Plane.WorldXY,
                     rg.Interval(x0 - overhang, x1 + overhang),
                     rg.Interval(y0 - overhang, y1 + overhang),
                     rg.Interval(h, h + slab))
        return [box.ToBrep()]
    # Sloped single surface
    if w >= d:
        pts = [
            rg.Point3d(x0 - overhang, y0 - overhang, h + slab + f),
            rg.Point3d(x1 + overhang, y0 - overhang, h + slab + f),
            rg.Point3d(x1 + overhang, y1 + overhang, h + slab + b),
            rg.Point3d(x0 - overhang, y1 + overhang, h + slab + b),
        ]
    else:
        pts = [
            rg.Point3d(x0 - overhang, y0 - overhang, h + slab + f),
            rg.Point3d(x0 - overhang, y1 + overhang, h + slab + f),
            rg.Point3d(x1 + overhang, y1 + overhang, h + slab + b),
            rg.Point3d(x1 + overhang, y0 - overhang, h + slab + b),
        ]
    pts_closed = pts + [pts[0]]
    curve = rg.PolylineCurve(System.Array[rg.Point3d](pts_closed))
    brep = rg.Brep.CreatePlanarBreps(curve, 1.0)
    if brep and len(brep) > 0:
        return [brep[0]]
    return []


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

        # Build 4 wall box Breps matching the room layout
        # South/north run full width, west/east fill between them
        w = x1 - x0
        d = y1 - y0
        wall_specs = [
            # (origin_x, origin_y, length_x, length_y)  — all at z=0, height h
            (x0, y0,       w,         t),          # south
            (x0, y1 - t,   w,         t),          # north
            (x0, y0 + t,   t,         d - 2 * t),  # west
            (x1 - t, y0 + t, t,       d - 2 * t),  # east
        ]

        roof_type = data.get("roofType", "flat")
        default_ridge = min(w, d) * 0.35
        ridge_h = float(data.get("ridgeH", default_ridge)) if roof_type == "gable" else 0
        ridge_along_x = w >= d

        flat_slope = data.get("flatSlopeH", [0, 0])
        is_flat_sloped = roof_type == "flat" and (flat_slope[0] != 0 or flat_slope[1] != 0)

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
                if ridge_along_x:
                    # Gable ends are west/east: profile in YZ, extruded along X
                    mid = sy / 2
                    pts = [
                        rg.Point3d(ox, oy, 0),
                        rg.Point3d(ox, oy + sy, 0),
                        rg.Point3d(ox, oy + sy, h),
                        rg.Point3d(ox, oy + mid, h + ridge_h),
                        rg.Point3d(ox, oy, h),
                        rg.Point3d(ox, oy, 0),
                    ]
                    direction = rg.Vector3d(sx, 0, 0)
                else:
                    # Gable ends are south/north: profile in XZ, extruded along Y
                    mid = sx / 2
                    pts = [
                        rg.Point3d(ox, oy, 0),
                        rg.Point3d(ox + sx, oy, 0),
                        rg.Point3d(ox + sx, oy, h),
                        rg.Point3d(ox + mid, oy, h + ridge_h),
                        rg.Point3d(ox, oy, h),
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

        # Build opening Breps from frontend placement data
        door_breps = []
        window_breps = []
        for op in data.get("openings", []):
            brep = _build_opening_brep(
                x0, y0, x1, y1, t,
                int(op["wallIdx"]), float(op["posAlong"]), op["type"],
            )
            if brep:
                (door_breps if op["type"] == "door" else window_breps).append(brep)

        # Build roof Breps
        roof_breps = _build_roof_breps(x0, y0, x1, y1, h,
                                       roof_type,
                                       ridge_h=ridge_h if roof_type == "gable" else None,
                                       flat_slope=flat_slope)

        gh_file = "test_simple.gh" if data.get("devSimple") else "generator_3.0.gh"
        outputs = solve_definition(gh_file, {
            "WallBreps": wall_breps,
            "DoorBreps": door_breps,
            "WindowBreps": window_breps,
            "RoofBreps": roof_breps,
        })

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

        # Save all input breps (walls + openings + roof) to design.3dm
        all_input_breps = wall_breps + door_breps + window_breps + roof_breps
        input_saved = _save_breps_3dm(all_input_breps, "design.3dm")

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

        verts, normals, tris = _mesh_to_triangles(joined)

        # Compute frame statistics from Breps
        total_volume_mm3 = 0.0
        total_length_mm = 0.0
        member_count = len(breps_out)
        for b in breps_out:
            vol = rg.VolumeMassProperties.Compute(b)
            if vol:
                total_volume_mm3 += abs(vol.Volume)
            bb = b.GetBoundingBox(True)
            dims = sorted([
                bb.Max.X - bb.Min.X,
                bb.Max.Y - bb.Min.Y,
                bb.Max.Z - bb.Min.Z,
            ])
            total_length_mm += dims[2]  # longest axis = member length

        total_volume_m3 = total_volume_mm3 / 1e9
        total_length_m = total_length_mm / 1000
        weight_kg = total_volume_m3 * 500  # ~500 kg/m³ for structural timber
        floor_area_m2 = (x1 - x0) * (y1 - y0) / 1e6

        # Pricing: structural C24 timber ~€450/m³ + markup
        timber_cost = total_volume_m3 * 450
        markup = timber_cost * 0.35  # fabrication + handling
        price = timber_cost + markup

        return jsonify({
            "vertices": verts,
            "normals": normals,
            "faces": tris,
            "result_count": len(mesh_geoms),
            "design_saved": input_saved,
            "frame_brep_saved": frame_brep_saved,
            "frame_mesh_saved": frame_mesh_saved,
            "stats": {
                "member_count": member_count,
                "total_volume_m3": round(total_volume_m3, 3),
                "total_length_m": round(total_length_m, 1),
                "weight_kg": round(weight_kg, 1),
                "floor_area_m2": round(floor_area_m2, 1),
                "wall_height_m": round(h / 1000, 2),
                "timber_cost": round(timber_cost, 2),
                "price": round(price, 2),
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
