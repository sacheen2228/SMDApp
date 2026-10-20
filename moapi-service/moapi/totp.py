"""Compatibility shim — the canonical TOTP lives in `moapi-service/totp.py`.

Kept so the existing `from . import totp` import inside `moapi/client.py`
keeps working while there is exactly ONE implementation of the code
generator in the service (no duplicated crypto).
"""

import os
import sys

_SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVICE_DIR not in sys.path:
    sys.path.insert(0, _SERVICE_DIR)

from totp import (  # noqa: E402,F401  (path set up above)
    DEFAULT_ALGORITHM,
    DEFAULT_DIGITS,
    DEFAULT_INTERVAL,
    generate_totp,
    normalise_secret,
    verify_totp,
)

__all__ = [
    "DEFAULT_ALGORITHM",
    "DEFAULT_DIGITS",
    "DEFAULT_INTERVAL",
    "generate_totp",
    "normalise_secret",
    "verify_totp",
]
