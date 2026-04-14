"""Flask app – accepts box dimensions, returns a .3dm file."""
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

import Rhino.FileIO as rio

app = Flask(__name__, static_folder=os.path.join(os.path.dirname(__file__), "static"))


@app.route("/")
def index():
    return send_file(os.path.join(app.static_folder, "index.html"))


@app.route("/generate", methods=["POST"])
def generate():
    data = request.get_json()
    width = float(data["width"])
    depth = float(data["depth"])
    height = float(data["height"])

    mesh = generate_box(width, depth, height)
    if not mesh.IsValid:
        return jsonify({"error": "Generated mesh is invalid"}), 400

    # Write to temp file, read into memory, delete, then serve
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


if __name__ == "__main__":
    print("Server running at http://localhost:5000")
    app.run(debug=False, port=5000, threaded=False)
