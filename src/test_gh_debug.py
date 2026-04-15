"""Test GH definitions with wall breps — check inputs and outputs."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))

RHINO_SYSTEM = r"C:\Program Files\Rhino 8\System"
os.environ["PATH"] = RHINO_SYSTEM + os.pathsep + os.environ.get("PATH", "")

import rhinoinside
rhinoinside.load(RHINO_SYSTEM, "net8.0")

import Rhino.Geometry as rg
import Rhino.FileIO as rio

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Build 4 wall box breps (same as app.py generate-frame)
x0, y0, x1, y1 = 0, 0, 4000, 3000
h, t = 2400, 150
w = x1 - x0
d = y1 - y0

wall_specs = [
    (x0, y0,       w,         t),          # south
    (x0, y1 - t,   w,         t),          # north
    (x0, y0 + t,   t,         d - 2 * t),  # west
    (x1 - t, y0 + t, t,       d - 2 * t),  # east
]

print("=== Wall Breps ===")
wall_breps = []
for i, (ox, oy, sx, sy) in enumerate(wall_specs):
    box = rg.Box(rg.Plane.WorldXY,
                 rg.Interval(ox, ox + sx),
                 rg.Interval(oy, oy + sy),
                 rg.Interval(0, h))
    brep = box.ToBrep()
    wall_breps.append(brep)
    print(f"  Wall {i}: IsValid={brep.IsValid}, IsSolid={brep.IsSolid}, Faces={brep.Faces.Count}")

from gh_runner import solve_definition

# Test 1: test_simple.gh
print("\n=== Solve test_simple.gh (WallBreps only) ===")
outputs = solve_definition("test_simple.gh", {"WallBreps": wall_breps})
for name, geoms in outputs.items():
    print(f"  '{name}': {len(geoms)} items")
    for j, g in enumerate(geoms[:3]):
        tn = g.GetType().Name
        print(f"    [{j}] type={tn}")

# Test 2: generator_3.0.gh with only WallBreps
print("\n=== Solve generator_3.0.gh (WallBreps only) ===")
outputs2 = solve_definition("generator_3.0.gh", {"WallBreps": wall_breps})
for name, geoms in outputs2.items():
    print(f"  '{name}': {len(geoms)} items")
    for j, g in enumerate(geoms[:3]):
        tn = g.GetType().Name
        print(f"    [{j}] type={tn}")

# Save outputs to files
mesh_geoms = outputs2.get("MeshOut", [])
brep_geoms = outputs2.get("BrepOut", [])

if mesh_geoms:
    joined = rg.Mesh()
    for g in mesh_geoms:
        if g.GetType().Name == "Mesh":
            joined.Append(g)
    if joined.Vertices.Count > 0:
        joined.Normals.ComputeNormals()
        model = rio.File3dm()
        model.Objects.AddMesh(joined)
        opts = rio.File3dmWriteOptions()
        opts.Version = 7
        p = os.path.join(OUTPUT_DIR, "test_frame_mesh.3dm")
        model.Write(p, opts)
        print(f"\n  Saved mesh: {p} ({joined.Vertices.Count} verts, {joined.Faces.Count} faces)")

if brep_geoms:
    model = rio.File3dm()
    for g in brep_geoms:
        tn = g.GetType().Name
        if tn == "Brep":
            model.Objects.AddBrep(g)
        elif tn == "Extrusion":
            model.Objects.AddBrep(g.ToBrep())
    opts = rio.File3dmWriteOptions()
    opts.Version = 7
    p = os.path.join(OUTPUT_DIR, "test_frame_brep.3dm")
    model.Write(p, opts)
    print(f"  Saved breps: {p} ({len(brep_geoms)} objects)")

if not mesh_geoms and not brep_geoms:
    print("\n  WARNING: No MeshOut or BrepOut from generator_3.0.gh!")

print("\nDone.")
