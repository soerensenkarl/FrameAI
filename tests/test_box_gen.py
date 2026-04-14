from box_gen import generate_box


def test_mesh_is_valid():
    mesh = generate_box(10, 5, 3)
    assert mesh.IsValid


def test_bounding_box_dimensions():
    w, d, h = 12.5, 7.0, 4.25
    mesh = generate_box(w, d, h)
    bb = mesh.GetBoundingBox(True)
    assert abs(bb.Max.X - bb.Min.X - w) < 1e-10
    assert abs(bb.Max.Y - bb.Min.Y - d) < 1e-10
    assert abs(bb.Max.Z - bb.Min.Z - h) < 1e-10


def test_small_column():
    """500 x 500 x 2000 mm column."""
    mesh = generate_box(500, 500, 2000)
    assert mesh.IsValid
    bb = mesh.GetBoundingBox(True)
    assert abs(bb.Max.X - bb.Min.X - 500) < 1e-10
    assert abs(bb.Max.Y - bb.Min.Y - 500) < 1e-10
    assert abs(bb.Max.Z - bb.Min.Z - 2000) < 1e-10


def test_large_slab():
    """10000 x 10000 x 100000 mm slab."""
    mesh = generate_box(10000, 10000, 100000)
    assert mesh.IsValid
    bb = mesh.GetBoundingBox(True)
    assert abs(bb.Max.X - bb.Min.X - 10000) < 1e-10
    assert abs(bb.Max.Y - bb.Min.Y - 10000) < 1e-10
    assert abs(bb.Max.Z - bb.Min.Z - 100000) < 1e-10


def test_mesh_has_six_faces():
    mesh = generate_box(1, 1, 1)
    assert mesh.Faces.Count == 6


def test_mesh_has_eight_vertices():
    mesh = generate_box(1, 1, 1)
    assert mesh.Vertices.Count == 8
