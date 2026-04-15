"""Diagnostic: inspect generator_3.0.gh components and solve output."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))

def p(msg):
    print(msg, flush=True)

RHINO_SYSTEM = r"C:\Program Files\Rhino 8\System"
os.environ["PATH"] = RHINO_SYSTEM + os.pathsep + os.environ.get("PATH", "")

import rhinoinside
rhinoinside.load(RHINO_SYSTEM, "net8.0")

import clr, System
clr.AddReference("Grasshopper")
import Rhino, Rhino.Geometry as rg
from Grasshopper.Kernel import GH_DocumentIO, GH_RuntimeMessageLevel
from Grasshopper.Kernel.Types import GH_Brep

DEFINITIONS_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "definitions")

# Headless doc
rdoc = Rhino.RhinoDoc.CreateHeadless(None)
setter = rdoc.GetType().GetMethod(
    "set_ActiveDoc",
    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public,
)
setter.Invoke(None, System.Array[System.Object]([rdoc]))
p("Headless doc active.")

# Load definition
path = os.path.join(DEFINITIONS_DIR, "generator_3.0.gh")
io_obj = GH_DocumentIO()
if not io_obj.Open(path):
    p("FAILED to open generator_3.0.gh")
    sys.exit(1)

doc = io_obj.Document
doc.Enabled = True

# List all components
p("\n=== All components in generator_3.0.gh ===")
input_params = {}
bake_components = []
for obj in doc.Objects:
    tn = obj.GetType().Name
    nn = obj.NickName
    p(f"  {tn}: \"{nn}\"")
    if tn == "GetGeometryParameter":
        input_params.setdefault(nn, []).append(obj)
    elif tn == "ContextBakeComponent":
        bake_components.append(obj)

p(f"\nInputs found: {list(input_params.keys())}")
p(f"Bake outputs found: {len(bake_components)}")

# Build wall breps
x0, y0, x1, y1 = 0, 0, 4000, 3000
h, t = 2400, 150
w, d = x1 - x0, y1 - y0
wall_specs = [
    (x0, y0, w, t),
    (x0, y1 - t, w, t),
    (x0, y0 + t, t, d - 2*t),
    (x1 - t, y0 + t, t, d - 2*t),
]
wall_breps = []
for ox, oy, sx, sy in wall_specs:
    box = rg.Box(rg.Plane.WorldXY,
                 rg.Interval(ox, ox+sx), rg.Interval(oy, oy+sy), rg.Interval(0, h))
    wall_breps.append(box.ToBrep())
p(f"\nBuilt {len(wall_breps)} wall breps")

# Set inputs
params = input_params.get("WallBreps", [])
p(f"Setting WallBreps on {len(params)} param(s)")
for param in params:
    it = param.GetType()
    brep_list = System.Collections.ArrayList()
    for b in wall_breps:
        brep_list.Add(GH_Brep(b))
    it.GetMethod("ClearContextualData").Invoke(param, None)
    it.GetMethod("AssignContextualData").Invoke(
        param, System.Array[System.Object]([brep_list])
    )

# Solve
p("\nSolving...")
doc.NewSolution(True)
p("Solve complete.")

# Check runtime messages on every component
p("\n=== Runtime messages ===")
for obj in doc.Objects:
    tn = obj.GetType().Name
    nn = obj.NickName
    for level in [GH_RuntimeMessageLevel.Error, GH_RuntimeMessageLevel.Warning]:
        try:
            msgs = obj.RuntimeMessages(level)
            if msgs and msgs.Count > 0:
                label = "ERROR" if level == GH_RuntimeMessageLevel.Error else "WARN"
                for m in msgs:
                    p(f"  {label} [{tn} \"{nn}\"]: {m}")
        except:
            pass

# Check bake outputs
p("\n=== Bake outputs ===")
for bake in bake_components:
    bt = bake.GetType()
    key = bake.NickName
    try:
        params_prop = bt.GetProperty("Params").GetValue(bake)
        inp = params_prop.GetType().GetProperty("Input").GetValue(params_prop)
        if inp.GetType().GetProperty("Count").GetValue(inp) > 0:
            key = inp[0].NickName or key
    except:
        pass
    geom_iter = bt.GetMethod("GetContextualGeometry").Invoke(bake, None)
    if geom_iter:
        items = list(geom_iter)
        p(f"  \"{key}\": {len(items)} items")
        for i, item in enumerate(items[:3]):
            val_prop = item.GetType().GetProperty("Value")
            val = val_prop.GetValue(item) if val_prop else item
            p(f"    [{i}] {val.GetType().Name if val else 'None'}")
    else:
        p(f"  \"{key}\": None (no geometry)")

p("\nDone.")
