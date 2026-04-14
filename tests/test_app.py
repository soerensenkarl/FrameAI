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
