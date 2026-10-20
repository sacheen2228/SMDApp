"""RFC 6238 TOTP — standard library only (no `pyotp` in this environment).

Motilal's OpenAPI accepts a 6-digit authenticator code on login:

    MOFSLOPENAPI.login(clientID, password, twoFA, f_totp=<code>, f_vendorinfo=...)

The `pyotp` package is not installed here (and no pip install is possible), so
the code is generated here with `hmac` + `hashlib` + `base64` + `struct`.

Parameters (the de-facto standard every authenticator app uses):
    SHA-1, 30-second step, 6 digits, 0-based counter = floor(unixtime / 30).

The secret is a base32 string (the usual `MOTILAL_TOTP_KEY` form). Whitespace
and missing padding are tolerated; a `=`-padded and an unpadded secret
produce the same code.

This module is the SINGLE implementation — `moapi/totp.py` re-exports it so
both `import totp` (from the service root) and `from moapi import totp` work.

Known vectors (RFC 6238 Appendix B, secret "12345678901234567890" in
base32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", SHA-1):

    T = 59      -> 287082
    T = 1111111109 -> 081804
    T = 1111111111 -> 050471
    T = 1234567890 -> 005924
    T = 2000000000 -> 279037
"""

import base64
import hashlib
import hmac
import struct
import time

DEFAULT_DIGITS = 6
DEFAULT_INTERVAL = 30
DEFAULT_ALGORITHM = "sha1"

_B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def normalise_secret(secret):
    """Return a base32 secret in the canonical (upper-case, padded) form.

    Raises ValueError when the secret contains characters outside the
    base32 alphabet — a wrong secret must fail loudly, never silently
    produce a plausible-looking wrong code.
    """
    if secret is None:
        raise ValueError("TOTP secret is missing")
    cleaned = "".join(str(secret).split()).replace("-", "").upper()
    if not cleaned:
        raise ValueError("TOTP secret is empty")
    for ch in cleaned:
        if ch not in _B32_ALPHABET and ch != "=":
            raise ValueError("TOTP secret has a non-base32 character")
    # Strip existing padding, then re-pad to a multiple of 8.
    cleaned = cleaned.rstrip("=")
    pad = (-len(cleaned)) % 8
    return cleaned + ("=" * pad)


def _decode_secret(secret):
    padded = normalise_secret(secret)
    try:
        return base64.b32decode(padded, casefold=True)
    except Exception as exc:  # pragma: no cover - defensive
        raise ValueError("TOTP secret is not valid base32: %s" % exc)


def generate_totp(secret, for_time=None, interval=DEFAULT_INTERVAL,
                  digits=DEFAULT_DIGITS, algorithm=DEFAULT_ALGORITHM):
    """Return the `digits`-long TOTP code for `secret` at `for_time`.

    `for_time` is a POSIX timestamp (default: now). Passing an explicit
    timestamp is what makes the RFC 6238 test vector reproducible.
    """
    key = _decode_secret(secret)
    counter = int((time.time() if for_time is None else for_time) // interval)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, getattr(hashlib, algorithm.lower())).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10 ** digits)).zfill(digits)


def verify_totp(secret, code, for_time=None, window=1,
                interval=DEFAULT_INTERVAL, digits=DEFAULT_DIGITS,
                algorithm=DEFAULT_ALGORITHM):
    """True when `code` is valid for `secret` within +/- `window` steps."""
    if not code:
        return False
    code = str(code).strip()
    base = int((time.time() if for_time is None else for_time) // interval)
    for drift in range(-window, window + 1):
        if hmac.compare_digest(
            generate_totp(secret, for_time=(base + drift) * interval,
                          interval=interval, digits=digits, algorithm=algorithm),
            code,
        ):
            return True
    return False
