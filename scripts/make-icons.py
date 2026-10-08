"""Generates the clock icons in assets/ (no image libraries needed).

Run: python3 scripts/make-icons.py
"""
import math, struct, zlib, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "app" / "icons"


def png(path, size, pixel):
    rows = b""
    for y in range(size):
        rows += b"\0" + b"".join(bytes(pixel(x + 0.5, y + 0.5, size)) for x in range(size))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def clock(fg, bg=None):
    def pixel(x, y, size):
        s = size / 16.0
        cx = cy = size / 2
        r = math.hypot(x - cx, y - cy)
        hand = min(seg_dist(x, y, cx, cy, cx, cy - 4.6 * s), seg_dist(x, y, cx, cy, cx + 3.2 * s, cy + 1.2 * s))
        outer = 7.4 * s
        if bg is not None:  # filled disc with light hands
            if r > outer:
                return (0, 0, 0, 0)
            a = min(1, outer - r + 0.5)
            if hand < 0.85 * s:
                return (*fg, int(255 * a))
            return (*bg, int(255 * a))
        ring = abs(r - 6.4 * s) < 1.0 * s
        if ring or hand < 0.85 * s:
            return (*fg, 255)
        return (0, 0, 0, 0)
    return pixel


def maskable(fg, bg):
    """Full-bleed background with the clock inside the 80% safe zone."""
    inner = clock(fg, None)
    def pixel(x, y, size):
        scale = 0.62
        off = size * (1 - scale) / 2
        px = inner((x - off) / scale, (y - off) / scale, size) if off <= x < size - off and off <= y < size - off else (0, 0, 0, 0)
        return px if px[3] else (*bg, 255)
    return pixel


OUT.mkdir(parents=True, exist_ok=True)
BLUE, WHITE = (37, 99, 235), (255, 255, 255)
png(OUT / "icon-192.png", 192, clock(WHITE, BLUE))
png(OUT / "icon-512.png", 512, clock(WHITE, BLUE))
png(OUT / "icon-maskable-512.png", 512, maskable(WHITE, BLUE))
