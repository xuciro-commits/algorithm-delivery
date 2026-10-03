#!/usr/bin/env python3
"""Generate the project's original, compact Radiance RGBE warehouse IBL panorama.

This is a deliberately authored HDR environment (soft daylight openings plus ceiling
LED strips), not a captured or third-party panorama. It is used for local PBR
reflections and diffuse image-based lighting; all geometry remains in Three.js.
"""

from __future__ import annotations

import math
from pathlib import Path

WIDTH = 512
HEIGHT = 256
OUT = Path(__file__).resolve().parents[1] / "src" / "assets" / "warehouse-studio.hdr"


def smoothstep(a: float, b: float, x: float) -> float:
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def rgb_for_pixel(x: int, y: int) -> tuple[float, float, float]:
    u = (x + 0.5) / WIDTH
    v = (y + 0.5) / HEIGHT
    lon = (u - 0.5) * math.tau
    lat = (0.5 - v) * math.pi

    # Muted cool industrial shell with warm bounce from the concrete floor.
    if lat > 0.28:
        ceiling = 0.32 + 0.11 * smoothstep(0.28, 1.45, lat)
        r, g, b = ceiling * 0.92, ceiling * 0.98, ceiling * 1.05
        # Dark roof girders create broad, non-uniform reflections on metal.
        girder = max(0.0, 1.0 - abs(math.sin(lon * 3.0)) / 0.045)
        r *= 1.0 - 0.58 * girder
        g *= 1.0 - 0.56 * girder
        b *= 1.0 - 0.48 * girder
    elif lat < -0.42:
        floor = 0.12 + 0.04 * math.cos(lon * 2.0)
        r, g, b = floor * 1.12, floor * 1.08, floor * 0.98
    else:
        wall = 0.18 + 0.035 * math.cos(lon * 2.0)
        r, g, b = wall * 0.86, wall * 0.98, wall * 1.12
        # Broad high windows / dock openings; feather the edges for softbox-like light.
        wall_y = smoothstep(-0.46, -0.32, lat) * (1.0 - smoothstep(0.35, 0.48, lat))
        for center in (0.13, 0.36, 0.66, 0.89):
            dx = abs(u - center)
            window_x = 1.0 - smoothstep(0.075, 0.10, dx)
            window = window_x * wall_y
            r += 2.1 * window
            g += 2.55 * window
            b += 3.0 * window

    # Ceiling LED panels: strong but broad high-dynamic-range sources.
    led_band = max(0.0, 1.0 - abs(lat - 0.83) / 0.075)
    for center in (0.18, 0.50, 0.82):
        dx = abs((u - center + 0.5) % 1.0 - 0.5)
        panel = (1.0 - smoothstep(0.10, 0.14, dx)) * led_band
        r += 5.0 * panel
        g += 5.5 * panel
        b += 6.3 * panel

    # A low warm dock beacon adds a subtle, useful amber kick to coated metal.
    beacon = math.exp(-((u - 0.02) ** 2 / 0.0015 + (lat + 0.10) ** 2 / 0.012))
    r += 1.6 * beacon
    g += 0.58 * beacon
    b += 0.12 * beacon
    return r, g, b


def to_rgbe(rgb: tuple[float, float, float]) -> bytes:
    r, g, b = rgb
    maximum = max(r, g, b)
    if maximum < 1.0e-32:
        return b"\x00\x00\x00\x00"
    mantissa, exponent = math.frexp(maximum)
    scale = mantissa * 256.0 / maximum
    return bytes((
        min(255, int(r * scale + 0.5)),
        min(255, int(g * scale + 0.5)),
        min(255, int(b * scale + 0.5)),
        max(0, min(255, exponent + 128)),
    ))


def encode_channel(values: list[int]) -> bytes:
    output = bytearray()
    i = 0
    n = len(values)
    while i < n:
        run = 1
        while i + run < n and values[i + run] == values[i] and run < 127:
            run += 1
        if run >= 4:
            output.extend((128 + run, values[i]))
            i += run
            continue

        start = i
        i += run
        while i < n and i - start < 128:
            look = 1
            while i + look < n and values[i + look] == values[i] and look < 127:
                look += 1
            if look >= 4:
                break
            i += min(look, 128 - (i - start))
        literal_count = i - start
        output.append(literal_count)
        output.extend(values[start:i])
    return bytes(output)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("wb") as file:
        file.write(
            b"#?RADIANCE\n"
            b"# Algorithm Delivery original procedural indoor warehouse IBL\n"
            b"# Authored locally for physically based material reflections\n"
            b"FORMAT=32-bit_rle_rgbe\n"
            b"EXPOSURE=1.0000000000000\n\n"
            + f"-Y {HEIGHT} +X {WIDTH}\n".encode("ascii")
        )
        for y in range(HEIGHT):
            rgbe = [to_rgbe(rgb_for_pixel(x, y)) for x in range(WIDTH)]
            file.write(bytes((2, 2, WIDTH >> 8, WIDTH & 0xFF)))
            for channel in range(4):
                file.write(encode_channel([pixel[channel] for pixel in rgbe]))
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes, {WIDTH}×{HEIGHT} RGBE)")


if __name__ == "__main__":
    main()
