"""
Optional fix for networks that intercept TLS (corporate proxies/antivirus),
which can make Python reject certificates that browsers accept fine.

Call apply_ssl_fix() at the very top of run.py BEFORE importing yfinance
if you see SSLCertVerificationError on your machine.
"""
import os
import ssl

import certifi


def apply_ssl_fix():
    os.environ["SSL_CERT_FILE"] = certifi.where()
    os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

    def _default_context(purpose=ssl.Purpose.SERVER_AUTH, cafile=None, capath=None, cadata=None):
        return ssl.create_default_context(purpose, cafile=certifi.where())

    ssl._create_default_https_context = _default_context
    print("[ssl_fix] Applied certifi-based SSL certificate fix")


if __name__ == "__main__":
    apply_ssl_fix()
