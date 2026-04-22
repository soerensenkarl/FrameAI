"""Walk the generator GH definition and dump all components / params with their
nicknames so we can find any overhang/offset knob.
"""
import os, sys
THIS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(THIS, os.pardir, "src"))

os.environ["PATH"] = r"C:\Program Files\Rhino 8\System" + os.pathsep + os.environ.get("PATH", "")
import rhinoinside
rhinoinside.load(r"C:\Program Files\Rhino 8\System", "net8.0")

import clr
clr.AddReference("Grasshopper")
import Rhino
import System
from Grasshopper.Kernel import GH_DocumentIO

_rdoc = Rhino.RhinoDoc.CreateHeadless(None)
_setter = _rdoc.GetType().GetMethod(
    "set_ActiveDoc",
    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public,
)
_setter.Invoke(None, System.Array[System.Object]([_rdoc]))

path = os.path.join(THIS, os.pardir, "definitions", "generator_3.0.gh")
io = GH_DocumentIO()
if not io.Open(path):
    raise RuntimeError("open failed")
doc = io.Document

for obj in doc.Objects:
    tn = obj.GetType().Name
    nick = getattr(obj, "NickName", "") or ""
    name = getattr(obj, "Name", "") or ""
    desc = getattr(obj, "Description", "") or ""
    # Number sliders carry a CurrentValue
    extra = ""
    try:
        if tn == "GH_NumberSlider":
            sv = obj.CurrentValue
            extra = f" value={sv}"
    except Exception:
        pass
    # Floating Param Number/Integer etc: try to read PersistentData first value
    try:
        pd = obj.GetType().GetProperty("PersistentData")
        if pd:
            tree = pd.GetValue(obj)
            if tree is not None and tree.DataCount > 0:
                branch = tree.get_Branch(tree.get_Path(0))
                if branch and branch.Count > 0:
                    v = branch[0]
                    val_prop = v.GetType().GetProperty("Value")
                    vv = val_prop.GetValue(v) if val_prop else v
                    extra += f" persistent={vv}"
    except Exception:
        pass
    print(f"{tn:30s} nick={nick!r:25s} name={name!r:40s}{extra}")
