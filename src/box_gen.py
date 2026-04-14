import Rhino.Geometry as rg


def generate_box(width, depth, height):
    """Create a RhinoCommon Mesh box with given dimensions, origin at World XY.

    Uses direct mesh construction instead of Brep.CreateFromBox so that
    no Rhino license is required at runtime.
    """
    w, d, h = float(width), float(depth), float(height)
    mesh = rg.Mesh()

    # 8 corner vertices
    mesh.Vertices.Add(0, 0, 0)  # 0
    mesh.Vertices.Add(w, 0, 0)  # 1
    mesh.Vertices.Add(w, d, 0)  # 2
    mesh.Vertices.Add(0, d, 0)  # 3
    mesh.Vertices.Add(0, 0, h)  # 4
    mesh.Vertices.Add(w, 0, h)  # 5
    mesh.Vertices.Add(w, d, h)  # 6
    mesh.Vertices.Add(0, d, h)  # 7

    # 6 quad faces (outward-facing normals via winding order)
    mesh.Faces.AddFace(0, 3, 2, 1)  # bottom (-Z)
    mesh.Faces.AddFace(4, 5, 6, 7)  # top    (+Z)
    mesh.Faces.AddFace(0, 1, 5, 4)  # front  (-Y)
    mesh.Faces.AddFace(2, 3, 7, 6)  # back   (+Y)
    mesh.Faces.AddFace(0, 4, 7, 3)  # left   (-X)
    mesh.Faces.AddFace(1, 2, 6, 5)  # right  (+X)

    mesh.Normals.ComputeNormals()
    mesh.Compact()
    return mesh
