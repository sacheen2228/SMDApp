#!/usr/bin/env python3
"""wav -> 48kHz OGG/OPUS for Telegram voice messages.

Piper outputs 22050 Hz wav; Opus only supports 8/12/16/24/48 kHz,
so we resample to 48 kHz and apply volume scaling.

Usage: voice-convert.py <in.wav> <out.ogg> [volume]
"""
import sys

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: voice-convert.py <in.wav> <out.ogg> [volume]", file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    vol = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0

    data, sr = sf.read(src, always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 48000:
        data = resample_poly(data, 48000, sr)
    data = np.clip(data * vol, -1.0, 1.0)
    sf.write(dst, data, 48000, format="OGG", subtype="OPUS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
