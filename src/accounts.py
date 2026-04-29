"""User accounts + saved projects, backed by SQLite.

Single-file SQLite DB at <repo>/data/frameai.db. One connection per request
(thread-local). Passwords hashed with werkzeug. Sessions via Flask's signed
cookie — set FRAMEAI_SECRET_KEY in the environment for prod, falls back to a
dev-only secret otherwise.
"""
import json
import os
import sqlite3
import time
from functools import wraps

from flask import g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash


DATA_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "data")
DB_PATH = os.path.abspath(os.path.join(DATA_DIR, "frameai.db"))


def _db():
    conn = getattr(g, "_accounts_db", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g._accounts_db = conn
    return conn


def _mirror_project_to_disk(db, uid, project_name, project_data):
    """Best-effort mirror of a saved project into projects/<user>/<name>/.

    Writes design.json, frame.json (if data._frame is set), and copies the
    latest design.3dm / frame.3dm / frame_mesh.3dm from OUTPUT_DIR. Failure
    here must never break the SQLite save, so the whole thing is wrapped.
    """
    try:
        user_row = db.execute(
            "SELECT name FROM users WHERE id = ?", (uid,),
        ).fetchone()
        if not user_row:
            return
        from app import _resolve_project_dir, write_project_mirror
        project_dir = _resolve_project_dir({
            "user": user_row["name"], "name": project_name,
        })
        if not project_dir:
            return
        frame_payload = project_data.get("_frame") if isinstance(project_data, dict) else None
        write_project_mirror(project_dir, project_data, frame_payload)
    except Exception:
        pass


def init_app(app):
    """Create the DB file + schema, wire teardown, and register routes."""
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                name TEXT UNIQUE NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(user_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
        """)
        conn.commit()
    finally:
        conn.close()

    @app.teardown_appcontext
    def _close(_exc):
        c = g.pop("_accounts_db", None)
        if c is not None:
            c.close()

    _register_routes(app)


def _current_user():
    uid = session.get("uid")
    if not uid:
        return None
    row = _db().execute("SELECT id, name FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        session.clear()
        return None
    return row


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("uid"):
            return jsonify({"error": "not signed in"}), 401
        return fn(*args, **kwargs)
    return wrapper


def _register_routes(app):
    # ── auth ──
    @app.route("/api/auth/me", methods=["GET"])
    def auth_me():
        u = _current_user()
        if u is None:
            return jsonify({"user": None})
        return jsonify({"user": {"id": u["id"], "name": u["name"]}})

    @app.route("/api/auth/sign-in", methods=["POST"])
    def auth_sign_in():
        """Single endpoint: creates the user if the name is new, otherwise logs
        them in. Matches the user's "type name + pw, that's it" flow."""
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        pw = data.get("password") or ""
        if not name or not pw:
            return jsonify({"error": "name and password required"}), 400
        if len(name) > 60 or len(pw) > 200:
            return jsonify({"error": "name or password too long"}), 400

        db = _db()
        row = db.execute(
            "SELECT id, password_hash FROM users WHERE name = ?", (name,)
        ).fetchone()
        if row is None:
            cur = db.execute(
                "INSERT INTO users (name, password_hash, created_at) VALUES (?, ?, ?)",
                (name, generate_password_hash(pw), time.time()),
            )
            db.commit()
            uid = cur.lastrowid
            session.clear()
            session["uid"] = uid
            session.permanent = True
            return jsonify({"user": {"id": uid, "name": name}, "created": True})

        if not check_password_hash(row["password_hash"], pw):
            return jsonify({"error": "wrong password for that name"}), 401
        session.clear()
        session["uid"] = row["id"]
        session.permanent = True
        return jsonify({"user": {"id": row["id"], "name": name}, "created": False})

    @app.route("/api/auth/sign-out", methods=["POST"])
    def auth_sign_out():
        session.clear()
        return jsonify({"ok": True})

    # ── projects ──
    @app.route("/api/projects", methods=["GET"])
    @login_required
    def projects_list():
        uid = session["uid"]
        rows = _db().execute(
            "SELECT id, name, created_at, updated_at FROM projects "
            "WHERE user_id = ? ORDER BY updated_at DESC",
            (uid,),
        ).fetchall()
        return jsonify({"projects": [dict(r) for r in rows]})

    @app.route("/api/projects/<int:pid>", methods=["GET"])
    @login_required
    def projects_get(pid):
        uid = session["uid"]
        row = _db().execute(
            "SELECT id, name, data, created_at, updated_at FROM projects "
            "WHERE id = ? AND user_id = ?",
            (pid, uid),
        ).fetchone()
        if row is None:
            return jsonify({"error": "not found"}), 404
        try:
            data = json.loads(row["data"])
        except (TypeError, ValueError):
            data = None
        return jsonify({
            "project": {
                "id": row["id"],
                "name": row["name"],
                "data": data,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        })

    @app.route("/api/projects", methods=["POST"])
    @login_required
    def projects_create():
        uid = session["uid"]
        body = request.get_json(silent=True) or {}
        name = (body.get("name") or "").strip()
        data = body.get("data")
        if not name:
            return jsonify({"error": "name required"}), 400
        if data is None:
            return jsonify({"error": "data required"}), 400
        if len(name) > 120:
            return jsonify({"error": "name too long"}), 400
        try:
            data_json = json.dumps(data)
        except (TypeError, ValueError) as e:
            return jsonify({"error": f"data not JSON-serializable: {e}"}), 400

        now = time.time()
        db = _db()
        try:
            cur = db.execute(
                "INSERT INTO projects (user_id, name, data, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (uid, name, data_json, now, now),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "you already have a project with that name"}), 409
        _mirror_project_to_disk(db, uid, name, data)
        return jsonify({"project": {"id": cur.lastrowid, "name": name,
                                     "created_at": now, "updated_at": now}})

    @app.route("/api/projects/<int:pid>", methods=["PUT"])
    @login_required
    def projects_update(pid):
        uid = session["uid"]
        body = request.get_json(silent=True) or {}
        db = _db()
        row = db.execute(
            "SELECT id FROM projects WHERE id = ? AND user_id = ?", (pid, uid),
        ).fetchone()
        if row is None:
            return jsonify({"error": "not found"}), 404

        sets, args = [], []
        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                return jsonify({"error": "name required"}), 400
            if len(name) > 120:
                return jsonify({"error": "name too long"}), 400
            sets.append("name = ?")
            args.append(name)
        if "data" in body:
            try:
                data_json = json.dumps(body["data"])
            except (TypeError, ValueError) as e:
                return jsonify({"error": f"data not JSON-serializable: {e}"}), 400
            sets.append("data = ?")
            args.append(data_json)
        if not sets:
            return jsonify({"error": "nothing to update"}), 400
        sets.append("updated_at = ?")
        args.append(time.time())
        args.extend([pid, uid])
        try:
            db.execute(f"UPDATE projects SET {', '.join(sets)} WHERE id = ? AND user_id = ?", args)
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "you already have a project with that name"}), 409
        # Mirror to disk: re-read the post-update name + data so we capture both
        # rename-only and data-only updates.
        post = db.execute(
            "SELECT name, data FROM projects WHERE id = ? AND user_id = ?", (pid, uid),
        ).fetchone()
        if post is not None:
            try:
                post_data = json.loads(post["data"])
            except (TypeError, ValueError):
                post_data = None
            if post_data is not None:
                _mirror_project_to_disk(db, uid, post["name"], post_data)
        return jsonify({"ok": True, "updated_at": args[-3]})

    @app.route("/api/projects/<int:pid>", methods=["DELETE"])
    @login_required
    def projects_delete(pid):
        uid = session["uid"]
        db = _db()
        cur = db.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (pid, uid))
        db.commit()
        if cur.rowcount == 0:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})
