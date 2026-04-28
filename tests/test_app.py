"""Integration tests for Flask endpoints.

Geometry specs are now built in JS (src/static/specs.js); the only Python
entry point is /solve-frame, which receives a spec bundle and runs GH.
"""
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


def test_solve_frame_accepts_spec_bundle():
    """End-to-end: a 4×3 m flat-roof box spec, posted to /solve-frame,
    builds Breps, runs Grasshopper, and returns mesh + stats."""
    sample_specs = {
        "walls": [
            {"kind": "box", "x": [195, 3805], "y": [0,    195],  "z": [0, 2400]},
            {"kind": "box", "x": [195, 3805], "y": [2805, 3000], "z": [0, 2400]},
            {"kind": "box", "x": [0,   195],  "y": [0,    3000], "z": [0, 2400]},
            {"kind": "box", "x": [3805, 4000], "y": [0,   3000], "z": [0, 2400]},
        ],
        "roof": [
            {"kind": "box", "x": [0, 4000], "y": [0, 3000], "z": [2400, 2695]},
        ],
        "doors": [],
        "windows": [],
        "material_factor": 3.1,
        "fab_factor": 1.0,
    }
    resp = _client().post("/solve-frame", json=sample_specs)
    assert resp.status_code == 200, resp.data.decode()
    data = resp.get_json()
    assert "vertices" in data and "faces" in data
    assert data["stats"]["member_count"] > 0
