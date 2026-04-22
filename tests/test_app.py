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


def test_generate_returns_3dm():
    resp = _client().post(
        "/generate",
        json={"width": 500, "depth": 500, "height": 2000},
    )
    assert resp.status_code == 200, resp.data.decode()
    assert resp.content_type == "application/octet-stream"
    # .3dm files start with "3D Geometry File Format"
    assert resp.data[:22] == b"3D Geometry File Forma"


def test_generate_different_sizes():
    client = _client()
    for w, d, h in [(1, 1, 1), (10000, 10000, 100000), (0.5, 0.5, 0.5)]:
        resp = client.post("/generate", json={"width": w, "depth": d, "height": h})
        assert resp.status_code == 200, f"Failed for {w}x{d}x{h}: {resp.data.decode()}"
        assert len(resp.data) > 100


# ── /frame endpoint ──

def test_frame_returns_mesh_json():
    resp = _client().post("/frame", json={
        "start_x": 0, "start_y": 0,
        "end_x": 3000, "end_y": 0,
        "height": 2400,
    })
    assert resp.status_code == 200, resp.data.decode()
    data = resp.get_json()
    assert "vertices" in data
    assert "faces" in data
    assert data["member_count"] >= 4
    assert len(data["vertices"]) > 0
    assert len(data["faces"]) > 0


def test_frame_saves_3dm_file():
    resp = _client().post("/frame", json={
        "start_x": 0, "start_y": 0,
        "end_x": 2000, "end_y": 0,
        "height": 2400,
    })
    data = resp.get_json()
    assert os.path.exists(data["file_saved"])
    assert data["file_saved"].endswith("wall_frame.3dm")


def test_frame_angled_wall():
    resp = _client().post("/frame", json={
        "start_x": 0, "start_y": 0,
        "end_x": 2000, "end_y": 2000,
        "height": 2400,
        "stud_spacing": 600,
    })
    assert resp.status_code == 200, resp.data.decode()
    data = resp.get_json()
    assert data["member_count"] >= 4


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
    assert set(specs.keys()) == {"walls", "roof", "doors", "windows", "dev_simple"}
    assert len(specs["walls"]) == 4  # four exterior walls
    assert len(specs["roof"]) == 1   # single flat box
    assert specs["roof"][0]["kind"] == "box"
    import json; json.dumps(specs)  # must be JSON-serializable


def test_compute_specs_gable_produces_pentagon_walls():
    from app import _compute_geometry_specs
    specs = _compute_geometry_specs(_sample_frame_request(
        roofType="gable", ridgeH=1500))
    extruded = [w for w in specs["walls"] if w["kind"] == "extruded"]
    assert len(extruded) == 2, "gable should have 2 pentagonal end walls"
    assert len(specs["roof"]) == 2  # two half-slabs


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
