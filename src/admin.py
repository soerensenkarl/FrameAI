"""Admin dashboard — read-only overview of all users and projects.

Architecturally isolated from the FrameAI generator/UI:
  - Owns its own routes (`/admin`, `/api/admin/*`).
  - Imports only `_db` from accounts and `PROJECTS_DIR` from app.
  - Serves its own static page (admin.html / admin.js / admin.css).

The admin user is bootstrapped on app startup so the credentials in
ADMIN_BOOTSTRAP are always usable.
"""
import json
import os
import sqlite3
import time

from flask import jsonify, send_from_directory, session
from werkzeug.security import generate_password_hash


ADMIN_BOOTSTRAP = {
    "email": "kjs@woodstock-robotics.com",
    "password": "woodstock2026",
    "display_name": "Admin",
}


def _bootstrap_admin(db_path):
    """First-run only: create the admin user if missing. If it already exists
    we just make sure is_admin=1 (in case the column was reset somehow) but
    leave the password alone — the admin can change it from the Account
    modal like any other user, and we don't want a server restart to clobber
    it back to the bootstrap value."""
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id, is_admin FROM users WHERE email = ?",
            (ADMIN_BOOTSTRAP["email"],),
        ).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO users (email, password_hash, display_name, is_admin, created_at) "
                "VALUES (?, ?, ?, 1, ?)",
                (ADMIN_BOOTSTRAP["email"],
                 generate_password_hash(ADMIN_BOOTSTRAP["password"]),
                 ADMIN_BOOTSTRAP["display_name"],
                 time.time()),
            )
        elif not row["is_admin"]:
            conn.execute("UPDATE users SET is_admin = 1 WHERE id = ?", (row["id"],))
        conn.commit()
    finally:
        conn.close()


def init_app(app):
    """Bootstrap the admin user, register admin routes."""
    from accounts import _db, DB_PATH

    _bootstrap_admin(DB_PATH)
    _register_routes(app, _db)


def _admin_required(_db_fn):
    """Returns a decorator that 401s non-admins."""
    from functools import wraps

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            uid = session.get("uid")
            if not uid:
                return jsonify({"error": "not signed in"}), 401
            row = _db_fn().execute(
                "SELECT is_admin FROM users WHERE id = ?", (uid,),
            ).fetchone()
            if not row or not row["is_admin"]:
                return jsonify({"error": "admin only"}), 403
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def _register_routes(app, _db_fn):
    admin_required = _admin_required(_db_fn)

    @app.route("/dashboard")
    @app.route("/admin")  # legacy alias — keep until existing bookmarks have moved.
    def dashboard_page():
        # Static SPA. Auth enforced client-side + via /api/admin/* gates.
        static_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "static")
        )
        return send_from_directory(static_dir, "admin.html")

    @app.route("/api/admin/overview", methods=["GET"])
    @admin_required
    def admin_overview():
        """All users + per-user project counts, sorted by latest activity."""
        db = _db_fn()
        rows = db.execute("""
            SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at,
                   COUNT(p.id) AS project_count,
                   SUM(CASE WHEN p.status = 'requested' THEN 1 ELSE 0 END) AS quote_count,
                   SUM(CASE WHEN p.status = 'draft' THEN 1 ELSE 0 END) AS saved_count,
                   MAX(p.updated_at) AS last_activity
            FROM users u
            LEFT JOIN projects p ON p.user_id = u.id
            GROUP BY u.id
            ORDER BY COALESCE(MAX(p.updated_at), u.created_at) DESC
        """).fetchall()
        users = []
        for r in rows:
            users.append({
                "id": r["id"],
                "email": r["email"],
                "display_name": r["display_name"] or "",
                "is_admin": bool(r["is_admin"]),
                "created_at": r["created_at"],
                "project_count": r["project_count"] or 0,
                "quote_count": r["quote_count"] or 0,
                "saved_count": r["saved_count"] or 0,
                "last_activity": r["last_activity"],
            })
        return jsonify({"users": users})

    @app.route("/api/admin/projects", methods=["GET"])
    @admin_required
    def admin_projects():
        """All projects across all users — id, owner, status, name, timestamps,
        plus a small design `summary` (W/D/H/roof) extracted from `data`.
        Optional `?user_id=N` filter."""
        from flask import request as _req
        db = _db_fn()
        user_filter = _req.args.get("user_id")
        sql = """
            SELECT p.id, p.user_id, p.name, p.status, p.data, p.quote_json,
                   p.created_at, p.updated_at,
                   u.email AS owner_email, u.display_name AS owner_display_name,
                   (SELECT 1 FROM project_frames f WHERE f.project_id = p.id) AS has_frame
            FROM projects p
            LEFT JOIN users u ON u.id = p.user_id
        """
        params = ()
        if user_filter:
            try:
                params = (int(user_filter),)
                sql += " WHERE p.user_id = ?"
            except ValueError:
                pass
        sql += " ORDER BY p.updated_at DESC"
        rows = db.execute(sql, params).fetchall()
        out = []
        for r in rows:
            try:
                data = json.loads(r["data"]) if r["data"] else {}
            except (TypeError, ValueError):
                data = {}
            try:
                quote = json.loads(r["quote_json"]) if r["quote_json"] else None
            except (TypeError, ValueError):
                quote = None
            out.append({
                "id": r["id"],
                "user_id": r["user_id"],
                "name": r["name"],
                "status": r["status"],
                "owner_email": r["owner_email"],
                "owner_display_name": r["owner_display_name"] or "",
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "address": (quote or {}).get("address") or r["name"],
                "has_frame": bool(r["has_frame"]),
                "summary": {
                    "width":  data.get("inW"),
                    "depth":  data.get("inD"),
                    "height": data.get("inH"),
                    "roof":   data.get("roofType") or "none",
                },
            })
        return jsonify({"projects": out})

    @app.route("/api/admin/projects/<int:pid>", methods=["DELETE"])
    @admin_required
    def admin_delete_project(pid):
        """Hard delete a project across the platform. Cascades clear
        project_events / project_frames / project_versions; the disk mirror
        at projects/<user_id>/<project_id>/ is removed best-effort."""
        db = _db_fn()
        proj = db.execute(
            "SELECT id, user_id, name FROM projects WHERE id = ?", (pid,),
        ).fetchone()
        if proj is None:
            return jsonify({"error": "not found"}), 404
        db.execute("DELETE FROM projects WHERE id = ?", (pid,))
        db.commit()
        try:
            from app import PROJECTS_DIR
            import shutil
            disk = os.path.join(PROJECTS_DIR, str(proj["user_id"]), str(pid))
            if os.path.isdir(disk):
                shutil.rmtree(disk)
        except Exception:
            pass  # disk cleanup is best-effort; DB row is gone either way.
        return jsonify({"ok": True})

    @app.route("/api/admin/projects/<int:pid>", methods=["GET"])
    @admin_required
    def admin_project_detail(pid):
        """Full project detail — including quote info — across any user."""
        db = _db_fn()
        row = db.execute("""
            SELECT p.id, p.user_id, p.name, p.status, p.data, p.quote_json,
                   p.created_at, p.updated_at,
                   u.email AS owner_email, u.display_name AS owner_display_name
            FROM projects p
            LEFT JOIN users u ON u.id = p.user_id
            WHERE p.id = ?
        """, (pid,)).fetchone()
        if row is None:
            return jsonify({"error": "not found"}), 404
        try:
            data = json.loads(row["data"])
        except (TypeError, ValueError):
            data = None
        try:
            quote = json.loads(row["quote_json"]) if row["quote_json"] else None
        except (TypeError, ValueError):
            quote = None
        has_frame = bool(db.execute(
            "SELECT 1 FROM project_frames WHERE project_id = ?", (pid,),
        ).fetchone())
        # On-disk path keyed by user_id/project_id (immutable).
        from app import PROJECTS_DIR
        disk_path = os.path.join(PROJECTS_DIR, str(row["user_id"]), str(row["id"]))
        return jsonify({
            "project": {
                "id": row["id"],
                "user_id": row["user_id"],
                "owner_email": row["owner_email"],
                "owner_display_name": row["owner_display_name"] or "",
                "name": row["name"],
                "status": row["status"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "data": data,
                "quote": quote,
                "has_frame": has_frame,
                "disk_path": os.path.abspath(disk_path),
            }
        })
