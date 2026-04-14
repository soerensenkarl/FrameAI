"""Integration tests for the Flask /generate endpoint."""
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
