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
    """Extract vertices and triangle indices from a Rhino Mesh."""
    verts = []
    for i in range(mesh.Vertices.Count):
        v = mesh.Vertices[i]
        verts.append([float(v.X), float(v.Y), float(v.Z)])
    tris = []
    for i in range(mesh.Faces.Count):
        f = mesh.Faces[i]
        tris.append([f.A, f.B, f.C])
        if f.IsQuad:
            tris.append([f.A, f.C, f.D])
    return verts, tris


def _breps_to_mesh(breps):
    """Convert a list of Breps into a single joined Mesh for the UI."""
    mp = rg.MeshingParameters.FastRenderMesh
    joined = rg.Mesh()
    for brep in breps:
        face_meshes = rg.Mesh.CreateFromBrep(brep, mp)
        if face_meshes:
            for fm in face_meshes:
                joined.Append(fm)
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


def _build_roof_breps(x0, y0, x1, y1, h, roof_type):
    """Create roof Brep(s) matching the frontend roof visualization."""
    w = x1 - x0
    d = y1 - y0
    overhang = 200

    if roof_type == "gable":
        ridge_h = min(w, d) * 0.35
        if w >= d:
            # Ridge along X, gable ends on east/west
            mid_y = (y0 + y1) / 2
            pts = [
                rg.Point3d(x0 - overhang, y0 - overhang, h),
                rg.Point3d(x0 - overhang, mid_y, h + ridge_h),
                rg.Point3d(x0 - overhang, y1 + overhang, h),
                rg.Point3d(x0 - overhang, y0 - overhang, h),
            ]
            direction = rg.Vector3d(w + 2 * overhang, 0, 0)
        else:
            # Ridge along Y, gable ends on north/south
            mid_x = (x0 + x1) / 2
            pts = [
                rg.Point3d(x0 - overhang, y0 - overhang, h),
                rg.Point3d(mid_x, y0 - overhang, h + ridge_h),
                rg.Point3d(x1 + overhang, y0 - overhang, h),
                rg.Point3d(x0 - overhang, y0 - overhang, h),
            ]
            direction = rg.Vector3d(0, d + 2 * overhang, 0)

        curve = rg.PolylineCurve(System.Array[rg.Point3d](pts))
        srf = rg.Surface.CreateExtrusion(curve, direction)
        brep = srf.ToBrep()
        capped = brep.CapPlanarHoles(1.0)
        return [capped if capped else brep]

    # Default: flat roof slab
    slab = 120
    box = rg.Box(rg.Plane.WorldXY,
                 rg.Interval(x0 - overhang, x1 + overhang),
                 rg.Interval(y0 - overhang, y1 + overhang),
                 rg.Interval(h, h + slab))
    return [box.ToBrep()]


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
        all_verts, all_tris = _mesh_to_triangles(mesh)

        return jsonify({
            "vertices": all_verts,
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

        wall_breps = []
        for ox, oy, sx, sy in wall_specs:
            if sx <= 0 or sy <= 0:
                continue
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
                                       data.get("roofType", "flat"))

        results = solve_definition("generator_3.0.gh", {
            "WallBreps": wall_breps,
            "DoorBreps": door_breps,
            "WindowBreps": window_breps,
            "RoofBreps": roof_breps,
        })

        # Convert output geometry to mesh triangles for three.js
        mp = rg.MeshingParameters.FastRenderMesh
        joined = rg.Mesh()
        breps_out = []
        for geom in results:
            brep = None
            if isinstance(geom, rg.Mesh):
                joined.Append(geom)
                continue
            elif isinstance(geom, rg.Brep):
                brep = geom
            elif isinstance(geom, rg.Extrusion):
                brep = geom.ToBrep()
            else:
                tn = geom.GetType().Name
                if tn == "Mesh":
                    joined.Append(geom)
                    continue
                elif tn in ("Extrusion", "Brep"):
                    brep = geom.ToBrep() if tn == "Extrusion" else geom
                elif hasattr(geom, "ToBrep"):
                    brep = geom.ToBrep()
            if brep:
                breps_out.append(brep)
                for fm in (rg.Mesh.CreateFromBrep(brep, mp) or []):
                    joined.Append(fm)

        # Save input boxes (walls + openings + roof) to .3dm
        all_input_breps = wall_breps + door_breps + window_breps + roof_breps
        input_saved = _save_breps_3dm(all_input_breps, "design.3dm")

        # Save frame to .3dm (Rhino 7)
        frame_saved = None
        if breps_out:
            frame_saved = _save_breps_3dm(breps_out, "frame.3dm")
        elif joined.Vertices.Count > 0:
            model = rio.File3dm()
            model.Objects.AddMesh(joined)
            frame_saved = _write_3dm(model, "frame.3dm")

        verts, tris = _mesh_to_triangles(joined)

        return jsonify({
            "vertices": verts,
            "faces": tris,
            "result_count": len(results),
            "design_saved": input_saved,
            "frame_saved": frame_saved,
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
        results = solve_definition("generator_3.0.gh", {"WallBreps": [wall_brep]})

        # Convert output geometry to mesh triangles for three.js
        mp = rg.MeshingParameters.FastRenderMesh
        joined = rg.Mesh()
        for geom in results:
            # Try converting to Brep first (works for Brep, Extrusion, Surface)
            brep = None
            if isinstance(geom, rg.Mesh):
                joined.Append(geom)
                continue
            elif isinstance(geom, rg.Brep):
                brep = geom
            elif isinstance(geom, rg.Extrusion):
                brep = geom.ToBrep()
            else:
                # Fallback: use .NET type name for pythonnet casting issues
                tn = geom.GetType().Name
                if tn == "Mesh":
                    joined.Append(geom)
                    continue
                elif tn == "Extrusion":
                    brep = geom.ToBrep()
                elif tn == "Brep":
                    brep = geom
                else:
                    # Last resort: try ToBrep if available
                    if hasattr(geom, "ToBrep"):
                        brep = geom.ToBrep()
            if brep:
                for fm in (rg.Mesh.CreateFromBrep(brep, mp) or []):
                    joined.Append(fm)

        verts, tris = _mesh_to_triangles(joined)

        return jsonify({
            "vertices": verts,
            "faces": tris,
            "result_count": len(results),
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    print("Server running at http://localhost:5000")
    app.run(debug=False, port=5000, threaded=False)
