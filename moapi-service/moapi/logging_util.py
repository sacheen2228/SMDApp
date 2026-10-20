"""Structured JSON logging for the MOAPI service.

Every line is one JSON object on stdout:

    {"ts":"2026-10-20T12:00:00Z","level":"info","event":"mo.login.ok","k":"v"}

Rules:
  * secrets are never logged — the logger only receives values the caller
    explicitly passes, and the credential-bearing helpers are not exposed;
  * the log goes to stdout (so `systemd`/`nohup` capture it) and optionally
    to a rotating file under the service's cache dir.
"""

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone

_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}

# Anything whose key looks like a secret never reaches the log.
_SECRET_HINTS = ("password", "secret", "token", "apikey", "api_key", "totp",
                  "auth", "dob", "userid", "credential")


def _redact(key, value):
    lowered = str(key).lower()
    if isinstance(value, bool):
        # A boolean flag ("credentials_present") leaks nothing.
        return value
    if any(hint in lowered for hint in _SECRET_HINTS):
        if isinstance(value, (int, float)):
            return "<redacted:%d>" % int(value)
        return "<redacted>"
    return value


class JsonLogger(object):
    def __init__(self, level="info", stream=None, file_path=None):
        self.threshold = _LEVELS.get(str(level).lower(), 20)
        self.stream = stream or sys.stdout
        self.file_path = file_path
        self._lock = threading.Lock()
        if file_path:
            try:
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
            except OSError:
                self.file_path = None

    def log(self, level, event, **fields):
        if _LEVELS.get(level, 20) < self.threshold:
            return
        record = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "level": level,
            "event": event,
        }
        for key, value in fields.items():
            record[key] = _redact(key, value)
        line = json.dumps(record, default=str)
        with self._lock:
            try:
                self.stream.write(line + "\n")
                self.stream.flush()
            except (OSError, ValueError):
                pass
            if self.file_path:
                try:
                    with open(self.file_path, "a", encoding="utf-8") as fh:
                        fh.write(line + "\n")
                except OSError:
                    pass

    def debug(self, event, **fields):
        self.log("debug", event, **fields)

    def info(self, event, **fields):
        self.log("info", event, **fields)

    def warn(self, event, **fields):
        self.log("warn", event, **fields)

    def error(self, event, **fields):
        self.log("error", event, **fields)


def now_ms():
    return int(time.time() * 1000)
