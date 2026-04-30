"""Run a Grasshopper definition headlessly via rhinoinside.

rhinoinside must already be loaded before importing this module.
"""
import os

import clr
import System
clr.AddReference("Grasshopper")

# [DEBUG] Append-only log for diagnosing window-frame duplication.
_DEBUG_LOG = os.path.join(
    os.path.dirname(__file__), os.pardir, "output", "_debug_solve.log"
)


def _dbg(msg):
    try:
        os.makedirs(os.path.dirname(_DEBUG_LOG), exist_ok=True)
        with open(_DEBUG_LOG, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass

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


def _get_reflected_property(obj, name):
    prop = obj.GetType().GetProperty(name)
    if prop is None:
        return None
    try:
        return prop.GetValue(obj)
    except Exception:
        return None


def _set_reflected_property(obj, name, value):
    prop = obj.GetType().GetProperty(name)
    if prop is None or not prop.CanWrite:
        return False
    try:
        prop.SetValue(obj, value)
        return True
    except Exception:
        return False


def _disable_context_geometry_pipelines(doc):
    """Disable legacy layer Geometry Pipelines that duplicate API inputs.

    The definition is solved from contextual Get Geometry inputs in this app.
    If layer pipelines for Walls/Doors/Windows/Roof remain live, Grasshopper
    can also pull stale geometry from the active Rhino document and merge it
    with the request payload. Windows showed this as duplicated frame members.
    """
    context_layers = {"Walls", "Doors", "Windows", "Roof"}
    disabled = []
    for obj in doc.Objects:
        name = getattr(obj, "Name", "") or ""
        type_name = obj.GetType().Name
        if name != "Geometry Pipeline" and "Pipeline" not in type_name:
            continue
        layer = _get_reflected_property(obj, "LayerFilter")
        if str(layer) not in context_layers:
            continue
        disabled_obj = _set_reflected_property(obj, "Enabled", False)
        if not disabled_obj:
            disabled_obj = _set_reflected_property(obj, "Locked", True)
        if disabled_obj:
            disabled.append(str(layer))
    if disabled:
        _dbg("[gh_runner] Disabled context Geometry Pipeline layer(s): "
             + ", ".join(sorted(disabled)))


def solve_definition(gh_filename, inputs, data_nicknames=None):
    """Load a .gh file, feed named Brep inputs, solve, return outputs.

    The GH definition must use:
      - **Get Geometry** components (Params > Util) with matching NickNames for inputs
      - **Context Bake** components (Params > Util) for geometry outputs
      - Optional: any `IGH_Param` (Param Text/Integer/Number) whose NickName is
        listed in ``data_nicknames`` — their solved values are harvested as
        flat Python lists.

    Parameters
    ----------
    gh_filename : str
    inputs : dict[str, list[Rhino.Geometry.Brep]]
    data_nicknames : iterable[str] or None
        NickNames of floating params whose VolatileData should be returned.

    Returns
    -------
    dict[str, list]
        Geometry keyed by Context Bake NickName, plus flat value lists keyed
        by each requested data-output NickName.
    """
    path = os.path.join(DEFINITIONS_DIR, gh_filename)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"GH definition not found: {path}")

    io = GH_DocumentIO()
    if not io.Open(path):
        raise RuntimeError(f"Failed to open GH definition: {path}")

    doc = io.Document
    doc.Enabled = True
    _disable_context_geometry_pipelines(doc)

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

    # [DEBUG] Inventory: count Get-Geometry inputs per NickName + bake count.
    _dbg(f"[gh_runner] Bake components: {len(bake_components)}")
    for nm, plist in input_params.items():
        _dbg(f"[gh_runner] Get Geometry '{nm}': {len(plist)} component(s)")

    # -- Set each named input via contextual API --
    for name, breps in inputs.items():
        params = input_params.get(name, [])
        # [DEBUG] How many breps are we feeding into each named input?
        _dbg(f"[gh_runner] Feeding '{name}': {len(breps)} brep(s) into "
             f"{len(params)} matching input(s)")
        for param in params:
            it = param.GetType()

            # [DEBUG] Reflection-based probe — pythonnet doesn't surface
            # IGH_Param's inherited members through getattr, so we walk the
            # type explicitly and read the integer counts that matter.
            def _probe(label):
                for prop_name in ("PersistentDataCount", "VolatileDataCount",
                                  "DataCount", "SourceCount"):
                    p = it.GetProperty(prop_name)
                    if p is not None:
                        try:
                            v = p.GetValue(param)
                            _dbg(f"          [{label}] {name}.{prop_name} = {v}")
                        except Exception as e:
                            _dbg(f"          [{label}] {name}.{prop_name} read failed: {e}")
                pd_prop = it.GetProperty("PersistentData")
                if pd_prop is not None:
                    try:
                        pd = pd_prop.GetValue(param)
                        if pd is not None:
                            pdt = pd.GetType()
                            dc = pdt.GetProperty("DataCount").GetValue(pd)
                            pc = pdt.GetProperty("PathCount").GetValue(pd)
                            _dbg(f"          [{label}] {name}.PersistentData "
                                 f"DataCount={dc} PathCount={pc}")
                    except Exception as e:
                        _dbg(f"          [{label}] PersistentData read failed: {e}")
                src_prop = it.GetProperty("Sources")
                if src_prop is not None:
                    try:
                        srcs = src_prop.GetValue(param)
                        cnt = srcs.GetType().GetProperty("Count").GetValue(srcs)
                        _dbg(f"          [{label}] {name}.Sources count = {cnt}")
                    except Exception as e:
                        _dbg(f"          [{label}] Sources read failed: {e}")

            _probe("pre-clear")
            brep_list = System.Collections.ArrayList()
            for b in breps:
                brep_list.Add(GH_Brep(b))
            it.GetMethod("ClearContextualData").Invoke(param, None)
            _probe("post-clear")
            it.GetMethod("AssignContextualData").Invoke(
                param, System.Array[System.Object]([brep_list])
            )
            _probe("post-assign")

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
        # [DEBUG] How many items did this C-Bake hand back, and how many
        # are duplicate object references vs distinct instances?
        unique_ids = {id(g) for g in geom_list}
        _dbg(f"[gh_runner] C-Bake (key='{key}'): "
             f"{len(geom_list)} item(s), {len(unique_ids)} unique by id()")
        if geom_list:
            outputs.setdefault(key, []).extend(geom_list)

    # -- Read any floating Param outputs whose NickName is in data_nicknames --
    # Interface-inherited properties (IGH_Param.VolatileData, IGH_Goo.Value) aren't
    # exposed through pythonnet's hasattr/getattr on the concrete class, so we
    # reach them via reflection — same pattern as Context Bake above.
    if data_nicknames:
        wanted = set(data_nicknames)
        for obj in doc.Objects:
            nick = getattr(obj, "NickName", None) or ""
            if nick not in wanted:
                continue
            ot = obj.GetType()
            vd_prop = ot.GetProperty("VolatileData")
            if not vd_prop:
                continue
            tree = vd_prop.GetValue(obj)
            if tree is None:
                continue
            vals = []
            try:
                path_count = tree.PathCount
                for i in range(path_count):
                    branch = tree.get_Branch(tree.get_Path(i))
                    if branch is None:
                        continue
                    for goo in branch:
                        if goo is None:
                            continue
                        gp = goo.GetType().GetProperty("Value")
                        v = gp.GetValue(goo) if gp else goo
                        if v is not None:
                            vals.append(v)
            except Exception:
                continue
            outputs[nick] = vals

    return outputs
