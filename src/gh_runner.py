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


def solve_definition(gh_filename, inputs):
    """Load a .gh file, feed named Brep inputs, solve, return output geometry.

    The GH definition must use:
      - **Get Geometry** components (Params > Util) with matching NickNames
      - A **Context Bake** component (Params > Util) for output

    Parameters
    ----------
    gh_filename : str
        Filename inside the definitions/ folder (e.g. "generator_3.0.gh").
    inputs : dict[str, list[Rhino.Geometry.Brep]]
        Maps Get Geometry component NickNames to lists of Breps.
        e.g. {"WallBreps": [...], "DoorBreps": [...]}

    Returns
    -------
    dict[str, list[GeometryBase]]
        Geometry keyed by Context Bake NickName.
        e.g. {"MeshOut": [Mesh, ...], "BrepOut": [Brep, ...]}
    """
    path = os.path.join(DEFINITIONS_DIR, gh_filename)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"GH definition not found: {path}")

    io = GH_DocumentIO()
    if not io.Open(path):
        raise RuntimeError(f"Failed to open GH definition: {path}")

    doc = io.Document
    doc.Enabled = True

    # -- Find Get Geometry inputs and Context Bake outputs --
    input_params = {}  # NickName -> list of components
    bake_components = []
    for obj in doc.Objects:
        tn = obj.GetType().Name
        if tn == "GetGeometryParameter":
            input_params.setdefault(obj.NickName, []).append(obj)
        elif tn == "ContextBakeComponent":
            bake_components.append(obj)

    if not bake_components:
        raise RuntimeError("No Context Bake component found in the GH definition")

    # -- Set each named input via contextual API --
    for name, breps in inputs.items():
        params = input_params.get(name, [])
        for param in params:
            it = param.GetType()
            brep_list = System.Collections.ArrayList()
            for b in breps:
                brep_list.Add(GH_Brep(b))
            it.GetMethod("ClearContextualData").Invoke(param, None)
            it.GetMethod("AssignContextualData").Invoke(
                param, System.Array[System.Object]([brep_list])
            )

    # -- Solve --
    doc.NewSolution(True)

    # -- Read output from each Context Bake --
    # Key by the input parameter NickName (e.g. "MeshOut", "BrepOut")
    # rather than the component NickName (which defaults to "C-Bake").
    outputs = {}
    for bake in bake_components:
        bt = bake.GetType()

        # Determine the output key from the first input param's NickName
        key = bake.NickName
        try:
            params = bt.GetProperty("Params").GetValue(bake)
            inp = params.GetType().GetProperty("Input").GetValue(params)
            if inp.GetType().GetProperty("Count").GetValue(inp) > 0:
                key = inp[0].NickName or key
        except Exception:
            pass

        geom_iter = bt.GetMethod("GetContextualGeometry").Invoke(bake, None)
        if not geom_iter:
            continue
        geom_list = []
        for item in geom_iter:
            # Items come back as IGH_Goo; extract .Value via reflection
            val_prop = item.GetType().GetProperty("Value")
            val = val_prop.GetValue(item) if val_prop else item
            if val is not None:
                geom_list.append(val)
        if geom_list:
            outputs.setdefault(key, []).extend(geom_list)

    return outputs
