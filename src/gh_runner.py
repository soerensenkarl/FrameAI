"""Run a Grasshopper definition headlessly via rhinoinside.

rhinoinside must already be loaded before importing this module.
"""
import os

import clr
import System
clr.AddReference("Grasshopper")

import Rhino
import Rhino.Geometry as rg
from Grasshopper.Kernel import GH_DocumentIO
from Grasshopper.Kernel.Types import GH_Brep

DEFINITIONS_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "definitions")

# Ensure a headless RhinoDoc is active (GH components like Contour need it)
_rdoc = Rhino.RhinoDoc.CreateHeadless(None)
_setter = _rdoc.GetType().GetMethod(
    "set_ActiveDoc",
    System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public,
)
_setter.Invoke(None, System.Array[System.Object]([_rdoc]))


def solve_definition(gh_filename, input_breps):
    """Load a .gh file, feed Breps in, solve, return output geometry.

    The GH definition must use:
      - A **Get Geometry** component (Params > Util) named "WallBreps" for input
      - A **Context Bake** component (Params > Util) for output

    Parameters
    ----------
    gh_filename : str
        Filename inside the definitions/ folder (e.g. "test_simple.gh").
    input_breps : list[Rhino.Geometry.Brep]
        Breps to set on the "WallBreps" Get Geometry input.

    Returns
    -------
    list[Rhino.Geometry.GeometryBase]
        Geometry from the Context Bake output.
    """
    path = os.path.join(DEFINITIONS_DIR, gh_filename)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"GH definition not found: {path}")

    io = GH_DocumentIO()
    if not io.Open(path):
        raise RuntimeError(f"Failed to open GH definition: {path}")

    doc = io.Document
    doc.Enabled = True

    # -- Find Get Geometry input and Context Bake output --
    input_param = None
    bake_component = None
    for obj in doc.Objects:
        tn = obj.GetType().Name
        if tn == "GetGeometryParameter" and obj.NickName == "WallBreps":
            input_param = obj
        elif tn == "ContextBakeComponent":
            bake_component = obj

    if input_param is None:
        raise RuntimeError(
            'No Get Geometry component named "WallBreps" found in the GH definition'
        )
    if bake_component is None:
        raise RuntimeError("No Context Bake component found in the GH definition")

    # -- Set input via contextual API --
    it = input_param.GetType()
    brep_list = System.Collections.ArrayList()
    for b in input_breps:
        brep_list.Add(GH_Brep(b))

    it.GetMethod("ClearContextualData").Invoke(input_param, None)
    it.GetMethod("AssignContextualData").Invoke(
        input_param, System.Array[System.Object]([brep_list])
    )

    # -- Solve --
    doc.NewSolution(True)

    # -- Read output from Context Bake --
    bt = bake_component.GetType()
    geom_iter = bt.GetMethod("GetContextualGeometry").Invoke(bake_component, None)

    results = []
    if geom_iter:
        for item in geom_iter:
            # Items come back as IGH_Goo; extract .Value via reflection
            val_prop = item.GetType().GetProperty("Value")
            val = val_prop.GetValue(item) if val_prop else item
            if val is not None:
                results.append(val)

    return results
