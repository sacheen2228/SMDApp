"""The TOTP generator — RFC 6238 known vectors (offline, no network)."""

import unittest

from _support import SERVICE_DIR  # noqa: F401  (sets sys.path)

import totp


# RFC 6238 Appendix B: the ASCII secret "12345678901234567890" in base32.
RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

# (unix timestamp, 6-digit code)
RFC_VECTORS = (
    (59, "287082"),
    (1111111109, "081804"),
    (1111111111, "050471"),
    (1234567890, "005924"),
    (2000000000, "279037"),
    (20000000000, "353130"),
)


class TestTotpVectors(unittest.TestCase):
    def test_rfc6238_known_vectors(self):
        for timestamp, expected in RFC_VECTORS:
            code = totp.generate_totp(RFC_SECRET, for_time=timestamp)
            self.assertEqual(
                code, expected,
                "TOTP mismatch at T=%s (expected %s, got %s)" % (timestamp, expected, code),
            )

    def test_eight_digit_variant(self):
        # The RFC's 8-digit codes are the same value, zero-padded to 8.
        eight = totp.generate_totp(RFC_SECRET, for_time=59, digits=8)
        self.assertEqual(eight, "94287082")

    def test_code_is_six_digits_and_numeric(self):
        code = totp.generate_totp(RFC_SECRET, for_time=1700000000)
        self.assertEqual(len(code), 6)
        self.assertTrue(code.isdigit())

    def test_code_changes_with_the_time_step(self):
        first = totp.generate_totp(RFC_SECRET, for_time=1000)
        second = totp.generate_totp(RFC_SECRET, for_time=1031)
        self.assertNotEqual(first, second)

    def test_stable_inside_the_30_second_window(self):
        # 1000 and 1019 both fall in the window [990, 1019] (counter 33).
        first = totp.generate_totp(RFC_SECRET, for_time=1000)
        second = totp.generate_totp(RFC_SECRET, for_time=1019)
        self.assertEqual(first, second)


class TestSecretHandling(unittest.TestCase):
    def test_padding_and_case_are_tolerated(self):
        padded = RFC_SECRET + "=" * ((-len(RFC_SECRET)) % 8)
        self.assertEqual(
            totp.generate_totp(padded, for_time=59),
            totp.generate_totp(RFC_SECRET.lower(), for_time=59),
        )

    def test_whitespace_is_ignored(self):
        self.assertEqual(
            totp.generate_totp(" %s\n" % RFC_SECRET, for_time=59),
            totp.generate_totp(RFC_SECRET, for_time=59),
        )

    def test_non_base32_secret_raises(self):
        with self.assertRaises(ValueError):
            totp.generate_totp("not-a-valid-secret!", for_time=59)

    def test_missing_secret_raises(self):
        with self.assertRaises(ValueError):
            totp.generate_totp("", for_time=59)
        with self.assertRaises(ValueError):
            totp.generate_totp(None, for_time=59)

    def test_verify_totp(self):
        code = totp.generate_totp(RFC_SECRET, for_time=1700000000)
        self.assertTrue(totp.verify_totp(RFC_SECRET, code, for_time=1700000000))
        self.assertTrue(totp.verify_totp(RFC_SECRET, code, for_time=1700000045, window=2))
        self.assertFalse(totp.verify_totp(RFC_SECRET, "000000", for_time=1700000000))
        self.assertFalse(totp.verify_totp(RFC_SECRET, "", for_time=1700000000))


class TestTotpModuleLayout(unittest.TestCase):
    def test_package_shim_reexports_the_same_implementation(self):
        # `moapi.totp` must be a shim over `moapi-service/totp.py` — one
        # implementation, no duplicated crypto.
        from moapi import totp as package_totp

        self.assertIs(package_totp.generate_totp, totp.generate_totp)


if __name__ == "__main__":
    unittest.main()
