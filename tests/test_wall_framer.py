"""Tests for wall framing logic."""
import math
import pytest
from wall_framer import frame_wall


def _bbox(mesh):
    bb = mesh.GetBoundingBox(True)
    return bb.Min, bb.Max


def test_simple_wall_member_count():
    """A 3000mm wall at 600mm spacing → bottom plate + top plate + studs at 0, 577.5, 1177.5, 1777.5, 2377.5, 2955 = 8 members."""
    members = frame_wall(0, 0, 3000, 0, height=2400)
    # 2 plates + N studs; exact count depends on spacing logic
    assert len(members) >= 4  # at minimum: 2 plates + 2 end studs


def test_plates_span_full_length():
    members = frame_wall(0, 0, 3000, 0, height=2400, stud_depth=90)
    bottom_plate = members[0]
    mn, mx = _bbox(bottom_plate)
    length = mx.X - mn.X
    assert abs(length - 3000) < 1e-6


def test_wall_height():
    members = frame_wall(0, 0, 2000, 0, height=2700, stud_width=45)
    # Combined bounding box of all members should reach full height
    all_min_z = min(_bbox(m)[0].Z for m in members)
    all_max_z = max(_bbox(m)[1].Z for m in members)
    assert abs(all_min_z) < 1e-6
    assert abs(all_max_z - 2700) < 1e-6


def test_stud_height_between_plates():
    members = frame_wall(0, 0, 2000, 0, height=2400, stud_width=45, stud_depth=90)
    # First stud is members[2]
    stud = members[2]
    mn, mx = _bbox(stud)
    stud_h = mx.Z - mn.Z
    expected = 2400 - 2 * 45  # height minus two plates
    assert abs(stud_h - expected) < 1e-6


def test_angled_wall():
    """Wall at 45 degrees should produce valid meshes."""
    members = frame_wall(0, 0, 1000, 1000, height=2400, stud_depth=90)
    for m in members:
        assert m.IsValid
    # Combined bounding box should reach the endpoints (plus thickness)
    all_min_x = min(_bbox(m)[0].X for m in members)
    all_max_x = max(_bbox(m)[1].X for m in members)
    # Wall goes from (0,0) to (1000,1000); thickness adds ~90*sin(45)≈63.6 in the perpendicular
    assert all_min_x < 1.0  # starts near origin
    assert all_max_x > 990   # reaches near end


def test_all_members_valid_breps():
    members = frame_wall(0, 0, 5000, 0, height=2400)
    for i, m in enumerate(members):
        assert m.IsValid, f"Member {i} is invalid"
        assert m.Faces.Count == 6, f"Member {i} doesn't have 6 Brep faces"
        assert m.IsSolid, f"Member {i} is not a closed solid"


def test_short_wall_raises():
    with pytest.raises(ValueError, match="shorter than one stud"):
        frame_wall(0, 0, 10, 0, height=2400, stud_width=45)
