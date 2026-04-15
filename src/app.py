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

import Rhino.FileIO as rio
import Rhino.Geometry as rg

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "output")
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


def _save_breps_3dm(breps, filename):
    """Save a list of Breps to a .3dm file in OUTPUT_DIR. Returns path."""
    path = os.path.join(OUTPUT_DIR, filename)
    model = rio.File3dm()
    for b in breps:
        model.Objects.AddBrep(b)
    model.Write(path, rio.File3dmWriteOptions())
    return os.path.abspath(path)


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
    model.Write(path, rio.File3dmWriteOptions())
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
        import math
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
        results = solve_definition("generator_3.0.gh", [wall_brep])

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
