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

from notifications import notify as _notify


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


def _log_event(db, project_id, actor_user_id, kind, payload=None):
    """Append a row to project_events. Best-effort; never raises."""
    try:
        db.execute(
            "INSERT INTO project_events (project_id, actor_user_id, kind, payload, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (project_id, actor_user_id, kind,
             json.dumps(payload or {}), time.time()),
        )
        db.commit()
    except Exception:
        pass


def _split_data(raw_data):
    """Pull the optional `_quote` and `_frame` sub-objects out of a save body.

    Returns (design_dict, quote_dict_or_None, frame_dict_or_None). The
    returned design_dict is a shallow copy with `_quote` / `_frame` removed,
    so the project's `data` column stores design parameters only.
    """
    if not isinstance(raw_data, dict):
        return raw_data, None, None
    quote = raw_data.get("_quote")
    frame = raw_data.get("_frame")
    design = {k: v for k, v in raw_data.items() if k not in ("_quote", "_frame")}
    return design, (quote if isinstance(quote, dict) else None), (frame if isinstance(frame, dict) else None)


def _store_project_frame(db, project_id, frame_data):
    """Upsert the frame snapshot for a project. No-op when frame_data falsy."""
    if not frame_data:
        return
    try:
        db.execute(
            "INSERT INTO project_frames (project_id, frame_json, generated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(project_id) DO UPDATE SET frame_json = excluded.frame_json, "
            "generated_at = excluded.generated_at",
            (project_id, json.dumps(frame_data), time.time()),
        )
        db.commit()
    except Exception:
        pass


def _read_project_frame(db, project_id):
    """Return parsed frame_json for a project, or None."""
    row = db.execute(
        "SELECT frame_json FROM project_frames WHERE project_id = ?", (project_id,),
    ).fetchone()
    if row is None:
        return None
    try:
        return json.loads(row["frame_json"])
    except (TypeError, ValueError):
        return None


def _pin_version(db, project_id, label, actor_user_id):
    """Snapshot the current design + frame + quote into project_versions.
    Best-effort; never raises."""
    try:
        proj = db.execute(
            "SELECT data, quote_json FROM projects WHERE id = ?", (project_id,),
        ).fetchone()
        if proj is None:
            return
        frame_row = db.execute(
            "SELECT frame_json FROM project_frames WHERE project_id = ?", (project_id,),
        ).fetchone()
        db.execute(
            "INSERT INTO project_versions (project_id, label, design_json, frame_json, "
            "quote_json, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (project_id, label, proj["data"],
             frame_row["frame_json"] if frame_row else None,
             proj["quote_json"], time.time(), actor_user_id),
        )
        db.commit()
    except Exception:
        pass


def _user_folder_base(user_row):
    """Sanitized base folder name for a user. Display name first; if empty,
    fall back to the email's local-part. Always returns something."""
    from app import _safe_dirname
    name = (user_row["display_name"] or "").strip()
    if not name:
        email = user_row["email"] or ""
        name = email.split("@", 1)[0]
    return _safe_dirname(name) or "user"


def _project_folder_base(project_row):
    """Sanitized base folder name for a project (the address/title)."""
    from app import _safe_dirname
    return _safe_dirname(project_row["name"] or "") or "untitled"


def user_folder_label(db, user_row):
    """Human-readable folder name for projects/<this>/. Suffixes _2/_3/...
    when other earlier-created users would resolve to the same base name.
    Order is by user_id ascending so the earliest user gets the bare name."""
    target = _user_folder_base(user_row)
    rank = 0
    for r in db.execute(
        "SELECT id, display_name, email FROM users WHERE id < ? ORDER BY id ASC",
        (user_row["id"],),
    ):
        if _user_folder_base(r) == target:
            rank += 1
    return target if rank == 0 else f"{target}_{rank + 1}"


def project_folder_label(db, project_row):
    """Human-readable folder name for projects/<user>/<this>/. Suffixed when
    the same owner has earlier projects that resolve to the same base name."""
    target = _project_folder_base(project_row)
    rank = 0
    for r in db.execute(
        "SELECT id, name FROM projects WHERE user_id = ? AND id < ? ORDER BY id ASC",
        (project_row["user_id"], project_row["id"]),
    ):
        # Build a tiny pseudo-row so _project_folder_base can read .name
        if _project_folder_base({"name": r["name"]}) == target:
            rank += 1
    return target if rank == 0 else f"{target}_{rank + 1}"


def _sweep_orphan_project_folders(db_path):
    """Walk projects/, reconcile each folder against the current DB state.

    Idempotent. Best-effort — never raises (a corrupt meta.json or a
    permission error on one folder doesn't stop the rest of the sweep).

    Pass 1 — every project subfolder identifies itself via its meta.json's
             `id`. If the project is in the DB, move it to its canonical
             location (renames after display_name / project name changes).
             Stale rows or collisions go into projects/_archive/<ts>/.
    Pass 2 — every top-level folder identifies itself via its user.json's
             `id`. Rename to canonical, or archive if the user is gone or
             the target folder is already taken (we don't merge user.json
             across users — risk of clobbering).
    Pass 3 — remove empty top-level folders left over after the moves.
    """
    import shutil
    import time as _time

    try:
        from app import PROJECTS_DIR
    except Exception:
        return
    if not os.path.isdir(PROJECTS_DIR):
        return

    # Snapshot the DB into in-memory maps so all canonical-name resolution
    # uses the same stable view. Sweep runs at startup so there's no
    # concurrent writer.
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        users_by_id = {r["id"]: dict(r) for r in conn.execute(
            "SELECT id, email, display_name FROM users"
        )}
        projects_by_id = {r["id"]: dict(r) for r in conn.execute(
            "SELECT id, user_id, name FROM projects"
        )}
    except Exception:
        conn.close()
        return
    conn.close()

    # Canonical user folder per user_id.
    canonical_uf = {}
    ordered_users = sorted(users_by_id.values(), key=lambda u: u["id"])
    for i, u in enumerate(ordered_users):
        base = _user_folder_base(u)
        rank = sum(1 for prev in ordered_users[:i] if _user_folder_base(prev) == base)
        canonical_uf[u["id"]] = base if rank == 0 else f"{base}_{rank + 1}"

    # Canonical project folder per project_id (collision per owning user).
    canonical_pf = {}
    by_owner = {}
    for p in projects_by_id.values():
        by_owner.setdefault(p["user_id"], []).append(p)
    for uid, plist in by_owner.items():
        plist.sort(key=lambda p: p["id"])
        for i, p in enumerate(plist):
            base = _project_folder_base(p)
            rank = sum(1 for prev in plist[:i] if _project_folder_base(prev) == base)
            canonical_pf[p["id"]] = base if rank == 0 else f"{base}_{rank + 1}"

    archive_root = os.path.join(PROJECTS_DIR, "_archive")
    archive_session = [None]  # late-init on first use, single shared timestamp

    def _archive(path):
        try:
            if archive_session[0] is None:
                archive_session[0] = os.path.join(
                    archive_root, _time.strftime("%Y%m%d-%H%M%S"))
                os.makedirs(archive_session[0], exist_ok=True)
            rel = os.path.relpath(path, PROJECTS_DIR)
            dst = os.path.join(archive_session[0], rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            # If dst already exists (e.g. several sweeps in same second), suffix.
            if os.path.exists(dst):
                base, n = dst, 2
                while os.path.exists(f"{base}__{n}"):
                    n += 1
                dst = f"{base}__{n}"
            shutil.move(path, dst)
        except Exception:
            pass

    def _move(src, dst):
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
        except Exception:
            pass

    def _same_path(a, b):
        return (os.path.normcase(os.path.normpath(a))
                == os.path.normcase(os.path.normpath(b)))

    def _is_skipped(name):
        # Reserved housekeeping folders + per-output stuff.
        return name.startswith("_") or name.startswith(".")

    # ── Pass 1: project sub-folders ───────────────────────────────
    for top in list(os.listdir(PROJECTS_DIR)):
        if _is_skipped(top):
            continue
        top_path = os.path.join(PROJECTS_DIR, top)
        if not os.path.isdir(top_path):
            continue
        for sub in list(os.listdir(top_path)):
            sub_path = os.path.join(top_path, sub)
            if not os.path.isdir(sub_path):
                continue
            meta_path = os.path.join(sub_path, "meta.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                continue
            pid = meta.get("id")
            project = projects_by_id.get(pid)
            if project is None:
                _archive(sub_path)
                continue
            target_uf = canonical_uf.get(project["user_id"])
            target_pf = canonical_pf.get(pid)
            if not target_uf or not target_pf:
                continue
            target_path = os.path.join(PROJECTS_DIR, target_uf, target_pf)
            if _same_path(sub_path, target_path):
                continue
            if os.path.exists(target_path):
                _archive(sub_path)
            else:
                _move(sub_path, target_path)

    # ── Pass 2: top-level (user) folders ──────────────────────────
    for top in list(os.listdir(PROJECTS_DIR)):
        if _is_skipped(top):
            continue
        top_path = os.path.join(PROJECTS_DIR, top)
        if not os.path.isdir(top_path):
            continue
        user_json = os.path.join(top_path, "user.json")
        if not os.path.isfile(user_json):
            continue
        try:
            with open(user_json, encoding="utf-8") as f:
                u_meta = json.load(f)
        except Exception:
            continue
        uid = u_meta.get("id")
        if uid not in users_by_id:
            _archive(top_path)
            continue
        target_uf = canonical_uf.get(uid)
        if not target_uf:
            continue
        target_top = os.path.join(PROJECTS_DIR, target_uf)
        if _same_path(top_path, target_top):
            continue
        if os.path.isdir(target_top):
            # The target may exist purely because Pass 1 just moved a project
            # subfolder there — in that case it has no user.json yet and we
            # should fill it in. Only archive when there's a foreign user.json
            # already at the target (i.e., a real clobber risk).
            target_uj = os.path.join(target_top, "user.json")
            target_uid = None
            target_has_uj = os.path.isfile(target_uj)
            if target_has_uj:
                try:
                    with open(target_uj, encoding="utf-8") as f:
                        target_uid = json.load(f).get("id")
                except Exception:
                    target_uid = -1  # unreadable → treat as foreign
            if not target_has_uj or target_uid == uid:
                # Move our user.json into the target (overwrites only when
                # it's the same user — same-id is just a refresh).
                try:
                    if target_has_uj:
                        os.remove(target_uj)
                    shutil.move(user_json, target_uj)
                except Exception:
                    pass
                # Old folder should now be empty.
                try:
                    if os.path.isdir(top_path) and not os.listdir(top_path):
                        os.rmdir(top_path)
                except Exception:
                    pass
            else:
                _archive(top_path)
        else:
            try:
                os.makedirs(os.path.dirname(target_top), exist_ok=True)
                os.rename(top_path, target_top)
            except Exception:
                pass

    # ── Pass 3: drop empty top-level folders ──────────────────────
    for top in list(os.listdir(PROJECTS_DIR)):
        if _is_skipped(top):
            continue
        top_path = os.path.join(PROJECTS_DIR, top)
        if not os.path.isdir(top_path):
            continue
        try:
            if not os.listdir(top_path):
                os.rmdir(top_path)
        except Exception:
            pass


def _mirror_project_to_disk(db, uid, pid, project_name, design_data, quote_data=None):
    """Best-effort mirror of a saved project into
    projects/<client_name>/<address>/.

    Writes meta.json + design.json + quote.json + user.json + .3dm files.
    Folder names are derived from display_name and project name (with
    `_2`/`_3` collision suffixes). The .3dm files are copied from the
    per-project scratch under OUTPUT_DIR. Failure never blocks the SQLite save.
    """
    try:
        user_row = db.execute(
            "SELECT id, email, display_name, created_at FROM users WHERE id = ?", (uid,),
        ).fetchone()
        if not user_row:
            return
        proj_row = db.execute(
            "SELECT id, user_id, name, status, created_at, updated_at FROM projects WHERE id = ?", (pid,),
        ).fetchone()
        if not proj_row:
            return
        from app import _resolve_project_dir, write_project_mirror, project_scratch_dir
        u_label = user_folder_label(db, user_row)
        p_label = project_folder_label(db, proj_row)
        project_dir = _resolve_project_dir(u_label, p_label)
        if not project_dir:
            return
        meta = {
            "id": proj_row["id"],
            "name": proj_row["name"],
            "status": proj_row["status"],
            "owner": {
                "id": user_row["id"],
                "email": user_row["email"],
                "display_name": user_row["display_name"] or "",
            },
            "created_at": proj_row["created_at"],
            "updated_at": proj_row["updated_at"],
        }
        user_info = {
            "id": user_row["id"],
            "email": user_row["email"],
            "display_name": user_row["display_name"] or "",
            "created_at": user_row["created_at"],
        }
        scratch = project_scratch_dir(pid)
        write_project_mirror(
            project_dir, design_data,
            quote_data=quote_data, meta=meta, user_info=user_info,
            scratch_dir=scratch,
        )
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
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                data TEXT NOT NULL,
                quote_json TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(user_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS project_events (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_project ON project_events(project_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS project_frames (
                project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                frame_json TEXT NOT NULL,
                generated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS project_versions (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                label TEXT NOT NULL,
                design_json TEXT NOT NULL,
                frame_json TEXT,
                quote_json TEXT,
                created_at REAL NOT NULL,
                created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_versions_project ON project_versions(project_id, created_at DESC);
        """)
        conn.commit()
    finally:
        conn.close()

    # Reconcile the projects/ folder layout with the DB. Renames stale
    # folders into their canonical (display_name + project name) home and
    # archives anything that no longer corresponds to a live row. Runs
    # once at startup; never raises.
    try:
        _sweep_orphan_project_folders(DB_PATH)
    except Exception:
        pass

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
        "SELECT id, email, display_name, is_admin FROM users WHERE id = ?", (uid,),
    ).fetchone()
    if row is None:
        session.clear()
        return None
    return row


def _user_payload(row):
    """JSON-friendly representation of a user row for /api/auth responses."""
    is_admin = False
    try:
        is_admin = bool(row["is_admin"]) if "is_admin" in row.keys() else False
    except (IndexError, KeyError):
        is_admin = False
    return {
        "id": row["id"],
        "email": row["email"],
        "display_name": row["display_name"] or "",
        # Keep `name` filled for legacy frontend lookups that haven't switched
        # to email yet — falls back to email-local-part if no display name.
        "name": row["display_name"] or (row["email"].split("@", 1)[0] if row["email"] else ""),
        "is_admin": is_admin,
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
                "SELECT id, email, display_name, is_admin FROM users WHERE id = ?", (uid,),
            ).fetchone()
            _notify(
                f"[FrameAI] New signup: {email}",
                f"A new user just created an account.\n\n"
                f"Email: {email}\n"
                f"Display name: {display_name or '(not set)'}\n",
            )
            return jsonify({"user": _user_payload(new_row), "created": True})

        if not check_password_hash(row["password_hash"], pw):
            return jsonify({"error": "wrong password for that email"}), 401
        session.clear()
        session["uid"] = row["id"]
        session.permanent = True
        full = db.execute(
            "SELECT id, email, display_name, is_admin FROM users WHERE id = ?", (row["id"],),
        ).fetchone()
        return jsonify({"user": _user_payload(full), "created": False})

    @app.route("/api/auth/sign-out", methods=["POST"])
    def auth_sign_out():
        session.clear()
        return jsonify({"ok": True})

    @app.route("/api/auth/me", methods=["PATCH"])
    @login_required
    def auth_update_me():
        """Update the signed-in user's profile. Body keys (any subset):
          - display_name : new full name
          - email        : new email (must be unique)
          - password     : new password (requires current_password)
          - current_password : verify the existing password (required for
                               email or password changes)

        On display_name / email change we also rename the per-user folder
        under projects/ so the disk mirror stays aligned.
        """
        body = request.get_json(silent=True) or {}
        uid = session["uid"]
        db = _db()
        row = db.execute(
            "SELECT id, email, password_hash, display_name, is_admin FROM users WHERE id = ?",
            (uid,),
        ).fetchone()
        if row is None:
            session.clear()
            return jsonify({"error": "user gone"}), 404

        new_display = body.get("display_name", None)
        new_email   = body.get("email", None)
        new_pw      = body.get("password", None)
        cur_pw      = body.get("current_password", "") or ""

        # Anything that touches credentials needs the existing password.
        if (new_email is not None and new_email.strip().lower() != row["email"]) \
           or (new_pw is not None and new_pw != ""):
            if not check_password_hash(row["password_hash"], cur_pw):
                return jsonify({"error": "current password is wrong"}), 401

        sets, args = [], []

        if new_display is not None:
            d = new_display.strip()
            if len(d) > 120:
                return jsonify({"error": "display name too long"}), 400
            sets.append("display_name = ?")
            args.append(d)

        if new_email is not None:
            e = new_email.strip().lower()
            if e and e != row["email"]:
                if "@" not in e or "." not in e.split("@", 1)[-1]:
                    return jsonify({"error": "invalid email"}), 400
                if len(e) > 200:
                    return jsonify({"error": "email too long"}), 400
                sets.append("email = ?")
                args.append(e)

        if new_pw:
            if len(new_pw) > 200:
                return jsonify({"error": "password too long"}), 400
            sets.append("password_hash = ?")
            args.append(generate_password_hash(new_pw))

        if not sets:
            return jsonify({"ok": True, "user": _user_payload(row)})

        args.append(uid)
        try:
            db.execute(
                f"UPDATE users SET {', '.join(sets)} WHERE id = ?",
                args,
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "that email is already taken"}), 409

        # Disk folders are now keyed by user_id (immutable) so there's no
        # rename to do here — display_name and email changes don't touch
        # the projects/<uid>/ tree.
        post = db.execute(
            "SELECT id, email, display_name, is_admin FROM users WHERE id = ?", (uid,),
        ).fetchone()
        return jsonify({"ok": True, "user": _user_payload(post)})

    # ── projects ──
    @app.route("/api/projects", methods=["GET"])
    @login_required
    def projects_list():
        uid = session["uid"]
        rows = _db().execute(
            "SELECT id, name, status, created_at, updated_at FROM projects "
            "WHERE user_id = ? ORDER BY updated_at DESC",
            (uid,),
        ).fetchall()
        return jsonify({"projects": [dict(r) for r in rows]})

    @app.route("/api/projects/<int:pid>", methods=["GET"])
    @login_required
    def projects_get(pid):
        uid = session["uid"]
        db = _db()
        # Admins can view any project; everyone else only their own.
        me = db.execute(
            "SELECT is_admin FROM users WHERE id = ?", (uid,),
        ).fetchone()
        cols = ("p.id, p.user_id, p.name, p.status, p.data, p.quote_json, "
                "p.created_at, p.updated_at, "
                "u.email AS owner_email, u.display_name AS owner_display_name")
        if me and me["is_admin"]:
            row = db.execute(
                f"SELECT {cols} FROM projects p LEFT JOIN users u ON u.id = p.user_id "
                "WHERE p.id = ?",
                (pid,),
            ).fetchone()
        else:
            row = db.execute(
                f"SELECT {cols} FROM projects p LEFT JOIN users u ON u.id = p.user_id "
                "WHERE p.id = ? AND p.user_id = ?",
                (pid, uid),
            ).fetchone()
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
        has_frame_row = db.execute(
            "SELECT 1 FROM project_frames WHERE project_id = ?", (pid,),
        ).fetchone()
        return jsonify({
            "project": {
                "id": row["id"],
                "user_id": row["user_id"],
                "name": row["name"],
                "status": row["status"],
                "data": data,
                "quote": quote,
                "has_frame": bool(has_frame_row),
                "owner_email": row["owner_email"],
                "owner_display_name": row["owner_display_name"] or "",
                "viewer_is_admin": bool(me and me["is_admin"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        })

    @app.route("/api/projects/<int:pid>/frame", methods=["GET"])
    @login_required
    def projects_get_frame(pid):
        """Return the cached frame mesh JSON for a project. Heavy payload —
        loaded only when the editor or dashboard needs to render the frame."""
        uid = session["uid"]
        db = _db()
        me = db.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
        is_admin = bool(me and me["is_admin"])
        proj = db.execute(
            "SELECT user_id FROM projects WHERE id = ?", (pid,),
        ).fetchone()
        if proj is None:
            return jsonify({"error": "not found"}), 404
        if not is_admin and proj["user_id"] != uid:
            return jsonify({"error": "forbidden"}), 403
        frame = _read_project_frame(db, pid)
        return jsonify({"frame": frame})

    @app.route("/api/projects/<int:pid>/versions", methods=["GET"])
    @login_required
    def projects_list_versions(pid):
        """List pinned design versions for a project (metadata only)."""
        uid = session["uid"]
        db = _db()
        me = db.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
        is_admin = bool(me and me["is_admin"])
        proj = db.execute("SELECT user_id FROM projects WHERE id = ?", (pid,)).fetchone()
        if proj is None:
            return jsonify({"error": "not found"}), 404
        if not is_admin and proj["user_id"] != uid:
            return jsonify({"error": "forbidden"}), 403
        rows = db.execute(
            "SELECT v.id, v.label, v.created_at, "
            "       u.email AS actor_email, u.display_name AS actor_display_name "
            "FROM project_versions v LEFT JOIN users u ON u.id = v.created_by_user_id "
            "WHERE v.project_id = ? ORDER BY v.created_at DESC",
            (pid,),
        ).fetchall()
        return jsonify({"versions": [
            {
                "id": r["id"], "label": r["label"], "created_at": r["created_at"],
                "actor_email": r["actor_email"],
                "actor_display_name": r["actor_display_name"] or "",
            } for r in rows
        ]})

    @app.route("/api/projects/<int:pid>/versions/<int:vid>", methods=["GET"])
    @login_required
    def projects_get_version(pid, vid):
        uid = session["uid"]
        db = _db()
        me = db.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
        is_admin = bool(me and me["is_admin"])
        proj = db.execute("SELECT user_id FROM projects WHERE id = ?", (pid,)).fetchone()
        if proj is None:
            return jsonify({"error": "not found"}), 404
        if not is_admin and proj["user_id"] != uid:
            return jsonify({"error": "forbidden"}), 403
        row = db.execute(
            "SELECT id, label, design_json, frame_json, quote_json, created_at "
            "FROM project_versions WHERE id = ? AND project_id = ?",
            (vid, pid),
        ).fetchone()
        if row is None:
            return jsonify({"error": "not found"}), 404
        def _try_json(s):
            try: return json.loads(s) if s else None
            except (TypeError, ValueError): return None
        return jsonify({
            "version": {
                "id": row["id"],
                "label": row["label"],
                "design": _try_json(row["design_json"]),
                "frame": _try_json(row["frame_json"]),
                "quote": _try_json(row["quote_json"]),
                "created_at": row["created_at"],
            }
        })

    @app.route("/api/projects/<int:pid>/events", methods=["GET"])
    @login_required
    def projects_events(pid):
        uid = session["uid"]
        db = _db()
        me = db.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
        is_admin = bool(me and me["is_admin"])
        proj = db.execute(
            "SELECT user_id FROM projects WHERE id = ?", (pid,),
        ).fetchone()
        if proj is None:
            return jsonify({"error": "not found"}), 404
        if not is_admin and proj["user_id"] != uid:
            return jsonify({"error": "forbidden"}), 403
        rows = db.execute(
            "SELECT e.id, e.kind, e.payload, e.created_at, "
            "       u.email AS actor_email, u.display_name AS actor_display_name "
            "FROM project_events e LEFT JOIN users u ON u.id = e.actor_user_id "
            "WHERE e.project_id = ? ORDER BY e.created_at DESC",
            (pid,),
        ).fetchall()
        events = []
        for r in rows:
            try:
                payload = json.loads(r["payload"])
            except (TypeError, ValueError):
                payload = {}
            events.append({
                "id": r["id"],
                "kind": r["kind"],
                "payload": payload,
                "created_at": r["created_at"],
                "actor_email": r["actor_email"],
                "actor_display_name": r["actor_display_name"] or "",
            })
        return jsonify({"events": events})

    @app.route("/api/projects/<int:pid>/status", methods=["PATCH"])
    @login_required
    def projects_set_status(pid):
        """Admin-only: move a project through its lifecycle."""
        uid = session["uid"]
        db = _db()
        me = db.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
        if not (me and me["is_admin"]):
            return jsonify({"error": "admin only"}), 403
        body = request.get_json(silent=True) or {}
        new_status = (body.get("status") or "").strip()
        VALID = {"draft", "requested", "reviewed", "quoted", "contracted",
                 "in_production", "delivered", "installed", "archived", "declined"}
        if new_status not in VALID:
            return jsonify({"error": "invalid status"}), 400
        proj = db.execute(
            "SELECT id, status FROM projects WHERE id = ?", (pid,),
        ).fetchone()
        if proj is None:
            return jsonify({"error": "not found"}), 404
        if proj["status"] == new_status:
            return jsonify({"ok": True, "status": new_status})
        db.execute(
            "UPDATE projects SET status = ?, updated_at = ? WHERE id = ?",
            (new_status, time.time(), pid),
        )
        db.commit()
        _log_event(db, pid, uid, "status_changed",
                   {"from": proj["status"], "to": new_status})
        # Pin a snapshot at every lifecycle transition so we always have an
        # "as-of-this-stage" record (as-quoted, as-contracted, ...).
        _pin_version(db, pid, f"as-{new_status}", uid)
        return jsonify({"ok": True, "status": new_status})

    @app.route("/api/projects/<int:pid>/versions", methods=["POST"])
    @login_required
    def projects_pin_version(pid):
        """Manual version pin. Accepts an optional `label` in the body."""
        uid = session["uid"]
        db = _db()
        me = db.execute("SELECT is_admin FROM users WHERE id = ?", (uid,)).fetchone()
        is_admin = bool(me and me["is_admin"])
        proj = db.execute("SELECT user_id FROM projects WHERE id = ?", (pid,)).fetchone()
        if proj is None:
            return jsonify({"error": "not found"}), 404
        if not is_admin and proj["user_id"] != uid:
            return jsonify({"error": "forbidden"}), 403
        body = request.get_json(silent=True) or {}
        label = (body.get("label") or "manual").strip()[:120] or "manual"
        _pin_version(db, pid, label, uid)
        return jsonify({"ok": True})

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

        # Split the incoming blob: design parameters → data column,
        # _quote → quote_json column, _frame → project_frames table.
        design, quote, frame = _split_data(data)
        try:
            design_json = json.dumps(design)
            quote_json = json.dumps(quote) if quote else None
        except (TypeError, ValueError) as e:
            return jsonify({"error": f"data not JSON-serializable: {e}"}), 400

        now = time.time()
        db = _db()
        try:
            cur = db.execute(
                "INSERT INTO projects (user_id, name, status, data, quote_json, "
                "created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)",
                (uid, name, design_json, quote_json, now, now),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "you already have a project with that name"}), 409
        pid = cur.lastrowid
        _store_project_frame(db, pid, frame)
        # First-save promotion: anonymous generates land in output/_draft/;
        # move them into the new project's scratch before the mirror runs.
        try:
            from app import promote_draft_to_project
            promote_draft_to_project(pid)
        except Exception:
            pass
        _log_event(db, pid, uid, "created", {"status": "draft", "name": name})
        _mirror_project_to_disk(db, uid, pid, name, design, quote)
        u = db.execute("SELECT email, display_name FROM users WHERE id = ?", (uid,)).fetchone()
        _notify(
            f"[FrameAI] Project saved: {name}",
            f"Project: {name}\n"
            f"Saved by: {(u['display_name'] if u and u['display_name'] else '(no name)')} "
            f"<{(u['email'] if u else '?')}>\n",
        )
        return jsonify({"project": {"id": pid, "name": name, "status": "draft",
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
        new_frame = None
        new_quote = None
        new_quote_set = False
        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                return jsonify({"error": "name required"}), 400
            if len(name) > 120:
                return jsonify({"error": "name too long"}), 400
            sets.append("name = ?")
            args.append(name)
        if "data" in body:
            design, quote, frame = _split_data(body["data"])
            try:
                design_json = json.dumps(design)
            except (TypeError, ValueError) as e:
                return jsonify({"error": f"data not JSON-serializable: {e}"}), 400
            sets.append("data = ?")
            args.append(design_json)
            new_frame = frame
            if quote is not None:
                new_quote = quote
                new_quote_set = True
        if new_quote_set:
            try:
                sets.append("quote_json = ?")
                args.append(json.dumps(new_quote) if new_quote else None)
            except (TypeError, ValueError) as e:
                return jsonify({"error": f"quote not JSON-serializable: {e}"}), 400
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
        if new_frame:
            _store_project_frame(db, pid, new_frame)
        # Mirror to disk: re-read the post-update name + data so we capture
        # rename-only updates too.
        post = db.execute(
            "SELECT name, data, quote_json FROM projects WHERE id = ? AND user_id = ?", (pid, uid),
        ).fetchone()
        if post is not None:
            try:
                post_data = json.loads(post["data"])
            except (TypeError, ValueError):
                post_data = None
            try:
                post_quote = json.loads(post["quote_json"]) if post["quote_json"] else None
            except (TypeError, ValueError):
                post_quote = None
            if post_data is not None:
                _mirror_project_to_disk(db, uid, pid, post["name"], post_data, post_quote)
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

        # Already-signed-in users bypass the password requirement entirely;
        # the session itself is the auth proof. The form's email/name still
        # land in the quote record (so we know what they typed), but the
        # project attaches to the session's user.
        session_uid = session.get("uid")

        # Loose validation: full_name, email and address are the only things
        # we hard-require. Password is only needed to mint a new account.
        missing = []
        if not full_name: missing.append("full_name")
        if not email:     missing.append("email")
        if not address:   missing.append("address")
        if missing:
            return jsonify({"error": "missing: " + ", ".join(missing)}), 400
        if "@" not in email or "." not in email.split("@", 1)[-1]:
            return jsonify({"error": "invalid email"}), 400
        if data is None:
            return jsonify({"error": "design data required"}), 400
        if byggetilladelse not in ("yes", "no", "waiting", ""):
            return jsonify({"error": "byggetilladelse must be yes/no/waiting"}), 400

        db = _db()
        if session_uid is not None:
            # Trust the session: project attaches to the signed-in user.
            uid = session_uid
            row = db.execute(
                "SELECT display_name FROM users WHERE id = ?", (uid,),
            ).fetchone()
            if full_name and row and full_name != (row["display_name"] or ""):
                db.execute(
                    "UPDATE users SET display_name = ? WHERE id = ?",
                    (full_name, uid),
                )
                db.commit()
        else:
            existing = db.execute(
                "SELECT id, password_hash, display_name FROM users WHERE email = ?",
                (email,),
            ).fetchone()
            if existing is not None:
                if not pw:
                    return jsonify({"error": "this email already has an account — sign in or enter the password"}), 401
                if not check_password_hash(existing["password_hash"], pw):
                    return jsonify({"error": "this email already has an account — wrong password"}), 401
                uid = existing["id"]
                if full_name and full_name != (existing["display_name"] or ""):
                    db.execute(
                        "UPDATE users SET display_name = ? WHERE id = ?",
                        (full_name, uid),
                    )
                    db.commit()
            else:
                if not pw:
                    return jsonify({"error": "choose a password to create your account"}), 400
                cur = db.execute(
                    "INSERT INTO users (email, password_hash, display_name, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    (email, generate_password_hash(pw), full_name, time.time()),
                )
                db.commit()
                uid = cur.lastrowid
                _notify(
                    f"[FrameAI] New signup: {email}",
                    f"A new user just created an account via the quote form.\n\n"
                    f"Email: {email}\n"
                    f"Display name: {full_name}\n",
                )

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

        # Pull design / frame out of the incoming blob; persist the quote
        # info in its own column.
        design, _existing_quote, frame = _split_data(data if isinstance(data, dict) else {})
        quote_obj = {
            "full_name": full_name,
            "email": email,
            "phone": phone,
            "address": address,
            "byggetilladelse": byggetilladelse,
            "message": message,
            "submitted_at": time.time(),
        }
        try:
            design_json = json.dumps(design)
            quote_json = json.dumps(quote_obj)
        except (TypeError, ValueError) as e:
            return jsonify({"error": f"data not JSON-serializable: {e}"}), 400

        now = time.time()
        cur = db.execute(
            "INSERT INTO projects (user_id, name, status, data, quote_json, "
            "created_at, updated_at) VALUES (?, ?, 'requested', ?, ?, ?, ?)",
            (uid, project_name, design_json, quote_json, now, now),
        )
        db.commit()
        pid = cur.lastrowid
        _store_project_frame(db, pid, frame)
        # First-save promotion (see projects_create for context): pull
        # anonymous-generate .3dm files from output/_draft/ into this
        # project's scratch so the mirror can copy them on this very save.
        try:
            from app import promote_draft_to_project
            promote_draft_to_project(pid)
        except Exception:
            pass
        _log_event(db, pid, uid, "created", {"status": "requested", "name": project_name})
        _log_event(db, pid, uid, "quote_submitted", {
            "address": address, "byggetilladelse": byggetilladelse,
        })

        # Auto sign-in the (possibly new) user.
        session.clear()
        session["uid"] = uid
        session.permanent = True

        _mirror_project_to_disk(db, uid, pid, project_name, design, quote_obj)

        user_row = db.execute(
            "SELECT id, email, display_name, is_admin FROM users WHERE id = ?", (uid,),
        ).fetchone()
        bygge_label = {"yes": "Yes", "no": "No", "waiting": "Waiting for answer", "": "(not specified)"}.get(byggetilladelse, byggetilladelse)
        _notify(
            f"[FrameAI] Quote request: {address}",
            "A new quote request just came in.\n\n"
            f"Full name: {full_name}\n"
            f"Email: {email}\n"
            f"Phone: {phone or '(not given)'}\n"
            f"Address: {address}\n"
            f"Byggetilladelse: {bygge_label}\n"
            f"Message:\n{message or '(none)'}\n\n"
            f"Project saved as: {project_name}\n",
        )
        return jsonify({
            "project": {
                "id": cur.lastrowid, "name": project_name, "status": "requested",
                "created_at": now, "updated_at": now,
            },
            "user": _user_payload(user_row),
        })
