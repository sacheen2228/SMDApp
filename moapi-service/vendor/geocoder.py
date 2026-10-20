"""Stub for the `geocoder` PyPI package — vendored because pip installs are not
available in this environment.

WHY THIS EXISTS
---------------
The upstream Motilal OpenAPI Python SDK (`MOFSLOPENAPI.py`, vendored next to
this file) does `import geocoder` at MODULE level, so the whole SDK fails to
import when the package is missing. The SDK only uses it in ONE place:

    def GetLatitudeLongitude():
        try:
            lst_latlng = [0, 0]            # <- hardcoded, geocoder NOT called
            if lst_latlng == None: ...
            return lst_latlng
        except Exception as e:
            ipaddress = geocoder.ip('106.193.137.95')   # <- unreachable
            lst_latlng = ipaddress.latlng
            ...

The `geocoder.ip(...)` call sits in the `except` branch of a function whose
body cannot raise (it only assigns a literal list), so it is DEAD CODE. The
import is what breaks, not the call.

The latitude/longitude headers are a device-fingerprint field for Motilal's
anti-fraud checks; the SDK's own hardcoded fallback for them is
`[19.0760, 72.8777]` (Mumbai). This stub therefore returns exactly that
value, so the header the SDK sends is byte-identical to what the upstream
SDK sends on its normal (non-exception) path.

This is a STUB, not a reimplementation: no IP is ever resolved, no network
call is made, and no location is looked up. See vendor/README.md.
"""

# The fixed, documented device-fingerprint coordinate. Identical to the
# upstream SDK's own hardcoded fallback (MOFSLOPENAPI.GetLatitudeLongitude).
LATITUDE = 19.0760
LONGITUDE = 72.8777


class _GeoResult(object):
    """Minimal stand-in for `geocoder`'s result object (only `.latlng` is used)."""

    latlng = (LATITUDE, LONGITUDE)
    address = "stub: fixed device-fingerprint coordinate"

    def __init__(self, address=None):
        if address is not None:
            self.address = address


def ip(address=None):
    """Return the fixed fingerprint result. Never touches the network."""
    return _GeoResult(address)


def geocode(query=None, **kwargs):
    """Not used by the SDK — present so an accidental import does not explode."""
    return _GeoResult(query)


def free_geoip(request=None, **kwargs):
    """Not used by the SDK — present so an accidental import does not explode."""
    return _GeoResult(request)
