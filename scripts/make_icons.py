"""Generate the extension icons: dark rounded square + orange pulse line.

Pure-stdlib PNG writer (no Pillow dependency) so the icons can be
regenerated anywhere:  python scripts/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[1] / "extension" / "icons"
SIZES = (16, 32, 48, 128)

BG = (20, 22, 26, 255)        # #14161a
BG_EDGE = (42, 46, 54, 255)    # #2a2e36
PULSE = (249, 115, 22, 255)   # #f97316
RADIUS_RATIO = 0.22


def rounded_rect_alpha(x: float, y: float, size: int, radius: float) -> float:
    """Coverage of a pixel by a rounded square (anti-aliased edges)."""
    half = size / 2.0
    dx = abs(x + 0.5 - half) - (half - radius)
    dy = abs(y + 0.5 - half) - (half - radius)
    dx = max(dx, 0.0)
    dy = max(dy, 0.0)
    dist = (dx * dx + dy * dy) ** 0.5
    if dist <= radius - 0.7:
        return 1.0
    if dist >= radius + 0.7:
        return 0.0
    return (radius + 0.7 - dist) / 1.4


def pulse_value(t: float) -> float:
    """A stylised ECG trace over t in [0, 1]: flat, sharp spike, flat."""
    if t < 0.34:
        return 0.0
    if t < 0.44:
        return (t - 0.34) / 0.10 * 0.25
    if t < 0.50:
        return 0.25 - (t - 0.44) / 0.06 * 0.55
    if t < 0.56:
        return -0.30 + (t - 0.50) / 0.06 * 1.25
    if t < 0.64:
        return 0.95 - (t - 0.56) / 0.08 * 1.25
    if t < 0.72:
        return -0.30 + (t - 0.64) / 0.08 * 0.30
    return 0.0


def render(size: int) -> bytes:
    """RGBA pixel rows for one icon."""
    radius = size * RADIUS_RATIO
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            cover = rounded_rect_alpha(x, y, size, radius)
            if cover <= 0.0:
                row += bytes((0, 0, 0, 0))
                continue
            r, g, b, a = BG
            # Subtle border
            edge = rounded_rect_alpha(x, y, size, radius + 1.2)
            if edge < 1.0:
                r, g, b, a = BG_EDGE
            # Pulse line across the middle
            t = x / (size - 1)
            v = pulse_value(t)
            mid = size * 0.56
            thickness = max(1.0, size * 0.085)
            if abs((y + 0.5) - (mid - v * size * 0.22)) <= thickness / 2:
                r, g, b, a = PULSE
            row += bytes((r, g, b, int(a * cover)))
        rows.append(bytes(row))
    return b"".join(b"\x00" + r for r in rows)


def write_png(path: Path, size: int, raw: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        write_png(path, size, render(size))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
