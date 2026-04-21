"""Verify _build_roof_breps returns closed solid Breps with 6 planar faces."""
import os
RHINO_SYSTEM = r"C:\Program Files\Rhino 8\System"
os.environ["PATH"] = RHINO_SYSTEM + os.pathsep + os.environ.get("PATH", "")
import rhinoinside
rhinoinside.load(RHINO_SYSTEM, "net8.0")

from app import _build_roof_breps


def check(label, breps):
    print(f"\n[{label}]")
    print(f"  brep count: {len(breps)}")
    for i, b in enumerate(breps):
        faces = b.Faces.Count
        print(f"  brep[{i}]: IsSolid={b.IsSolid} IsValid={b.IsValid} faces={faces}")


check("flat unsloped 5000x4000",
      _build_roof_breps(0, 0, 5000, 4000, 2400, "flat"))

check("flat sloped (w>=d)",
      _build_roof_breps(0, 0, 5000, 4000, 2400, "flat", flat_slope=[0, 500]))

check("flat sloped (d>w)",
      _build_roof_breps(0, 0, 4000, 5000, 2400, "flat", flat_slope=[0, 500]))

check("gable (w>=d)",
      _build_roof_breps(0, 0, 5000, 4000, 2400, "gable", ridge_h=1400, t=150))

check("gable (d>w)",
      _build_roof_breps(0, 0, 4000, 5000, 2400, "gable", ridge_h=1750, t=150))
