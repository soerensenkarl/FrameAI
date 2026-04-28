"""Integration tests for Flask endpoints."""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir, "src"))

from app import app


def _client():
    app.config["TESTING"] = True
    return app.test_client()


def test_index_returns_html():
    resp = _client().get("/")
    assert resp.status_code == 200
    assert b"FrameAI" in resp.data


# ── pure-Python spec computation (runs with or without Rhino) ──

def _sample_frame_request(**overrides):
    base = {
        "x0": 0.0, "y0": 0.0, "x1": 4000.0, "y1": 3000.0,
        "height": 2400, "thickness": 195, "roofThickness": 295,
        "roofType": "flat",
        "flatSlopeH": [0, 0],
        "openings": [],
        "interiorWalls": [],
        "interiorThickness": 95,
    }
    base.update(overrides)
    return base


def test_compute_specs_flat_roof_bundle_shape():
    from app import _compute_geometry_specs
    specs = _compute_geometry_specs(_sample_frame_request())
    assert {"walls", "roof", "doors", "windows"}.issubset(specs.keys())
    assert len(specs["walls"]) == 4  # four exterior walls
    assert len(specs["roof"]) == 1   # single flat box
    assert specs["roof"][0]["kind"] == "box"
    import json; json.dumps(specs)  # must be JSON-serializable


def test_compute_specs_gable_produces_pentagon_walls():
    """Gable end walls ship as pentagons (rect + triangle to ridge); long
    walls are boxes. Both pentagons place their profile on the OUTER face and
    extrude INWARD — keeps the reference face consistent so GH frames both
    sides identically."""
    from app import _compute_geometry_specs
    specs = _compute_geometry_specs(_sample_frame_request(
        roofType="gable", ridgeH=1500))
    extruded = [w for w in specs["walls"] if w["kind"] == "extruded"]
    boxes = [w for w in specs["walls"] if w["kind"] == "box"]
    assert len(extruded) == 2, "two pentagonal gable walls"
    assert len(boxes) == 2, "two long box walls"
    # Both pentagons must extrude inward (extrusion vector points into the
    # building from each outer face). Sum of dir vectors should cancel.
    dx = sum(e["dir"][0] for e in extruded)
    dy = sum(e["dir"][1] for e in extruded)
    assert dx == 0 and dy == 0, f"gable extrusion dirs should cancel; got dx={dx}, dy={dy}"
    assert len(specs["roof"]) == 2  # two half-slabs


def test_compute_specs_gable_with_overhangs():
    """eaveOH / gableOH extend the gable slab outward past the wall footprint."""
    from app import _compute_geometry_specs
    base = _sample_frame_request(roofType="gable", ridgeH=1500)
    base["eaveOH"] = 500
    base["gableOH"] = 300
    specs = _compute_geometry_specs(base)
    expected_x_ref = base["x0"] - 300
    expected_dir_x = (base["x1"] - base["x0"]) + 2 * 300
    for r in specs["roof"]:
        assert r["profile"][0][0] == expected_x_ref
        assert r["dir"][0] == expected_dir_x


def test_compute_specs_flat_sloped_uses_planar_solid():
    from app import _compute_geometry_specs
    specs = _compute_geometry_specs(_sample_frame_request(
        flatSlopeH=[0, 800]))
    assert specs["roof"][0]["kind"] == "planar_solid"


def test_generate_frame_endpoint_end_to_end():
    resp = _client().post("/generate-frame", json=_sample_frame_request())
    assert resp.status_code == 200, resp.data.decode()
    data = resp.get_json()
    assert "vertices" in data and "faces" in data
    assert data["stats"]["member_count"] > 0


def test_solve_frame_accepts_spec_bundle():
    from app import _compute_geometry_specs
    specs = _compute_geometry_specs(_sample_frame_request())
    resp = _client().post("/solve-frame", json=specs)
    assert resp.status_code == 200, resp.data.decode()
    data = resp.get_json()
    assert "vertices" in data and data["stats"]["member_count"] > 0


# ── interior wall joint retractions ──

def test_iw_joint_t_into_long_wall_retracts_butting_end():
    """Short horizontal wall butting mid-span of a long vertical wall retracts by t/2."""
    from app import _compute_iw_joints
    walls = [
        {"x0": 5000, "y0": 1000, "x1": 5000, "y1": 7000},  # long vertical
        {"x0": 5000, "y0": 3000, "x1": 8000, "y1": 3000},  # horizontal butting in
    ]
    r = _compute_iw_joints(walls, iw_t=120)
    # Long wall: both ends free (inside footprint-less test world) → no retract.
    assert r[0] == [0, 0]
    # Short wall: side 0 hits long wall's mid-span → retract 60; side 1 free → 0.
    assert r[1][0] == 60
    assert r[1][1] == 0


def test_iw_joint_corner_longer_wins():
    """L-corner: shorter wall's end retracts, longer keeps full length."""
    from app import _compute_iw_joints
    walls = [
        {"x0": 0, "y0": 0, "x1": 10000, "y1": 0},  # long horizontal — winner
        {"x0": 0, "y0": 0, "x1": 0,      "y1": 2000},  # short vertical — loser
    ]
    r = _compute_iw_joints(walls, iw_t=200)
    assert r[0] == [0, 0]
    assert r[1][0] == 100  # shorter wall retracts at the shared corner


def test_iw_joint_end_on_exterior_face_no_retract():
    """End flush with an exterior inner face doesn't retract."""
    from app import _compute_iw_joints
    walls = [
        {"x0": 195, "y0": 1500, "x1": 5000, "y1": 1500},  # starts on west inner face
    ]
    r = _compute_iw_joints(walls, iw_t=120,
                            ix0=195, iy0=195, ix1=5000, iy1=3000)
    assert r[0][0] == 0  # flush with ext face → no retract at side 0


def test_iw_thickness_change_re_resolves_retraction():
    """Doubling iw_t doubles the retraction amount."""
    from app import _compute_iw_joints
    walls = [
        {"x0": 0, "y0": 0, "x1": 0, "y1": 5000},
        {"x0": 0, "y0": 2500, "x1": 3000, "y1": 2500},
    ]
    r_thin = _compute_iw_joints(walls, iw_t=100)
    r_thick = _compute_iw_joints(walls, iw_t=200)
    assert r_thin[1][0] == 50
    assert r_thick[1][0] == 100
