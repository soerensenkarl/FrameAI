"""Best-effort admin notifications.

Always appends to data/notifications.log so events are visible without any
mail config. If SMTP env vars are set, also sends an email — sender failures
never propagate (logging is the floor, e-mail is the upgrade).

Env vars:
  FRAMEAI_ADMIN_EMAIL  → recipient (default: kjs@woodstock-robotics.com)
  FRAMEAI_SMTP_HOST    → SMTP server hostname (e.g. smtp.gmail.com)
  FRAMEAI_SMTP_PORT    → SMTP port (default: 587, STARTTLS)
  FRAMEAI_SMTP_USER    → username (typically the from address)
  FRAMEAI_SMTP_PASS    → password / app-specific token
  FRAMEAI_SMTP_FROM    → from header (default: SMTP_USER, falls back to frameai@localhost)
"""
import os
import smtplib
import time
from email.message import EmailMessage


_THIS_DIR = os.path.dirname(__file__)
DATA_DIR = os.path.abspath(os.path.join(_THIS_DIR, os.pardir, "data"))
LOG_PATH = os.path.join(DATA_DIR, "notifications.log")


def _admin_email():
    return os.environ.get("FRAMEAI_ADMIN_EMAIL") or "kjs@woodstock-robotics.com"


def notify(subject, body):
    """Log + (if configured) email an admin notification. Never raises."""
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"--- {stamp} ---\n[{subject}]\n{body}\n\n"
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(log_line)
    except Exception:
        pass

    host = os.environ.get("FRAMEAI_SMTP_HOST") or ""
    user = os.environ.get("FRAMEAI_SMTP_USER") or ""
    pw   = os.environ.get("FRAMEAI_SMTP_PASS") or ""
    if not (host and user and pw):
        return  # no SMTP configured — log-only mode

    try:
        port = int(os.environ.get("FRAMEAI_SMTP_PORT") or 587)
    except ValueError:
        port = 587
    sender = os.environ.get("FRAMEAI_SMTP_FROM") or user or "frameai@localhost"

    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = sender
        msg["To"] = _admin_email()
        msg.set_content(body)
        with smtplib.SMTP(host, port, timeout=10) as s:
            s.ehlo()
            s.starttls()
            s.login(user, pw)
            s.send_message(msg)
    except Exception:
        pass  # never block the request — log entry is the source of truth
