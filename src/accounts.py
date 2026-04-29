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


def _user_folder_label(user_row):
    """Folder name for a user under projects/. Prefers display_name; falls
    back to the email's local-part when display_name is empty."""
    name = (user_row["display_name"] or "").strip() if user_row else ""
    if name:
        return name
    email = (user_row["email"] or "") if user_row else ""
    return email.split("@", 1)[0] if email else "user"


def _mirror_project_to_disk(db, uid, project_name, project_data):
    """Best-effort mirror of a saved project into projects/<display_name>/<name>/.

    Writes design.json, frame.json (if data._frame is set), and copies the
    latest design.3dm / frame.3dm / frame_mesh.3dm from OUTPUT_DIR. Failure
    here must never break the SQLite save, so the whole thing is wrapped.
    """
    try:
        user_row = db.execute(
            "SELECT email, display_name FROM users WHERE id = ?", (uid,),
        ).fetchone()
        if not user_row:
            return
        from app import _resolve_project_dir, write_project_mirror
        project_dir = _resolve_project_dir(_user_folder_label(user_row), project_name)
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
                email TEXT UNIQUE NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'saved',
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
    row = _db().execute(
        "SELECT id, email, display_name FROM users WHERE id = ?", (uid,),
    ).fetchone()
    if row is None:
        session.clear()
        return None
    return row


def _user_payload(row):
    """JSON-friendly representation of a user row for /api/auth responses."""
    return {
        "id": row["id"],
        "email": row["email"],
        "display_name": row["display_name"] or "",
        # Keep `name` filled for legacy frontend lookups that haven't switched
        # to email yet — falls back to email-local-part if no display name.
        "name": row["display_name"] or (row["email"].split("@", 1)[0] if row["email"] else ""),
    }


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
        return jsonify({"user": _user_payload(u)})

    @app.route("/api/auth/sign-in", methods=["POST"])
    def auth_sign_in():
        """Sign in with email + password, or create a new account if the email
        is unseen. Matches the "type email + pw, that's it" flow. The optional
        `display_name` is only used on new-account creation; existing accounts
        are not relabelled here (the quote-request endpoint owns that)."""
        data = request.get_json(silent=True) or {}
        email = (data.get("email") or "").strip().lower()
        pw = data.get("password") or ""
        display_name = (data.get("display_name") or "").strip()
        if not email or not pw:
            return jsonify({"error": "email and password required"}), 400
        if len(email) > 200 or len(pw) > 200 or len(display_name) > 120:
            return jsonify({"error": "email, password, or name too long"}), 400
        if "@" not in email or "." not in email.split("@", 1)[-1]:
            return jsonify({"error": "invalid email"}), 400

        db = _db()
        row = db.execute(
            "SELECT id, password_hash FROM users WHERE email = ?", (email,),
        ).fetchone()
        if row is None:
            cur = db.execute(
                "INSERT INTO users (email, password_hash, display_name, created_at) "
                "VALUES (?, ?, ?, ?)",
                (email, generate_password_hash(pw), display_name, time.time()),
            )
            db.commit()
            uid = cur.lastrowid
            session.clear()
            session["uid"] = uid
            session.permanent = True
            new_row = db.execute(
                "SELECT id, email, display_name FROM users WHERE id = ?", (uid,),
            ).fetchone()
            return jsonify({"user": _user_payload(new_row), "created": True})

        if not check_password_hash(row["password_hash"], pw):
            return jsonify({"error": "wrong password for that email"}), 401
        session.clear()
        session["uid"] = row["id"]
        session.permanent = True
        full = db.execute(
            "SELECT id, email, display_name FROM users WHERE id = ?", (row["id"],),
        ).fetchone()
        return jsonify({"user": _user_payload(full), "created": False})

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
            "SELECT id, name, kind, created_at, updated_at FROM projects "
            "WHERE user_id = ? ORDER BY updated_at DESC",
            (uid,),
        ).fetchall()
        return jsonify({"projects": [dict(r) for r in rows]})

    @app.route("/api/projects/<int:pid>", methods=["GET"])
    @login_required
    def projects_get(pid):
        uid = session["uid"]
        row = _db().execute(
            "SELECT id, name, kind, data, created_at, updated_at FROM projects "
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
                "kind": row["kind"],
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
                "INSERT INTO projects (user_id, name, kind, data, created_at, updated_at) "
                "VALUES (?, ?, 'saved', ?, ?, ?)",
                (uid, name, data_json, now, now),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "you already have a project with that name"}), 409
        _mirror_project_to_disk(db, uid, name, data)
        return jsonify({"project": {"id": cur.lastrowid, "name": name, "kind": "saved",
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

    # ── quote request ──
    @app.route("/api/quote-request", methods=["POST"])
    def quote_request():
        """Submit a quote request. Body:
          { full_name, email, password, phone, address, byggetilladelse,
            message, data }

        Logic: find user by email. If existing, password must match (we
        attach the quote to that account). If new, create the user using the
        supplied password + full_name. Stores a project of kind='quote' named
        after the address (suffixed _2/_3/... on collision with the same
        user's existing addresses). Sets the session and returns the project.
        """
        body = request.get_json(silent=True) or {}
        full_name = (body.get("full_name") or "").strip()
        email = (body.get("email") or "").strip().lower()
        pw = body.get("password") or ""
        phone = (body.get("phone") or "").strip()
        address = (body.get("address") or "").strip()
        byggetilladelse = (body.get("byggetilladelse") or "").strip()
        message = (body.get("message") or "").strip()
        data = body.get("data")

        if not full_name or not email or not pw or not address:
            return jsonify({"error": "full_name, email, password, and address are required"}), 400
        if "@" not in email or "." not in email.split("@", 1)[-1]:
            return jsonify({"error": "invalid email"}), 400
        if data is None:
            return jsonify({"error": "design data required"}), 400
        if byggetilladelse not in ("yes", "no", "waiting", ""):
            return jsonify({"error": "byggetilladelse must be yes/no/waiting"}), 400

        db = _db()
        existing = db.execute(
            "SELECT id, password_hash, display_name FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        if existing is not None:
            if not check_password_hash(existing["password_hash"], pw):
                return jsonify({"error": "this email already has an account — wrong password"}), 401
            uid = existing["id"]
            # Adopt the form's full name as the canonical display_name (the
            # user is telling us who they are right now).
            if full_name and full_name != (existing["display_name"] or ""):
                db.execute(
                    "UPDATE users SET display_name = ? WHERE id = ?",
                    (full_name, uid),
                )
                db.commit()
        else:
            cur = db.execute(
                "INSERT INTO users (email, password_hash, display_name, created_at) "
                "VALUES (?, ?, ?, ?)",
                (email, generate_password_hash(pw), full_name, time.time()),
            )
            db.commit()
            uid = cur.lastrowid

        # Resolve a unique project name = address (suffix _2/_3/... on collision).
        base_name = address[:120]
        candidate = base_name
        n = 2
        while db.execute(
            "SELECT 1 FROM projects WHERE user_id = ? AND name = ?",
            (uid, candidate),
        ).fetchone():
            candidate = f"{base_name}_{n}"
            n += 1
        project_name = candidate

        # Embed the quote info in data so it lives alongside the design.
        if not isinstance(data, dict):
            data = {"_raw": data}
        data["_quote"] = {
            "full_name": full_name,
            "email": email,
            "phone": phone,
            "address": address,
            "byggetilladelse": byggetilladelse,
            "message": message,
            "submitted_at": time.time(),
        }
        try:
            data_json = json.dumps(data)
        except (TypeError, ValueError) as e:
            return jsonify({"error": f"data not JSON-serializable: {e}"}), 400

        now = time.time()
        cur = db.execute(
            "INSERT INTO projects (user_id, name, kind, data, created_at, updated_at) "
            "VALUES (?, ?, 'quote', ?, ?, ?)",
            (uid, project_name, data_json, now, now),
        )
        db.commit()

        # Auto sign-in the (possibly new) user.
        session.clear()
        session["uid"] = uid
        session.permanent = True

        _mirror_project_to_disk(db, uid, project_name, data)

        user_row = db.execute(
            "SELECT id, email, display_name FROM users WHERE id = ?", (uid,),
        ).fetchone()
        return jsonify({
            "project": {
                "id": cur.lastrowid, "name": project_name, "kind": "quote",
                "created_at": now, "updated_at": now,
            },
            "user": _user_payload(user_row),
        })
