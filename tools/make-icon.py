from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"
S = 2048  # 4x supersample of the 512 viewBox


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def linear_gradient(size: int, start: str, end: str, diagonal: bool = True) -> Image.Image:
    a = np.array(hex_rgb(start), dtype=np.float32)
    b = np.array(hex_rgb(end), dtype=np.float32)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    if diagonal:
        t = (x + y) / (2 * (size - 1))
    else:
        t = y / (size - 1)
    t = t[..., None]
    rgb = (a * (1 - t) + b * t).clip(0, 255).astype(np.uint8)
    alpha = np.full((size, size, 1), 255, dtype=np.uint8)
    return Image.fromarray(np.concatenate([rgb, alpha], axis=2), "RGBA")


def mark_gradient(size: int) -> Image.Image:
    """Cyan at the lower-left, mint at the upper-right, with no transparent edges."""
    a = np.array(hex_rgb("#22D3EE"), dtype=np.float32)
    b = np.array(hex_rgb("#6EE7B7"), dtype=np.float32)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = (x + (size - 1 - y)) / (2 * (size - 1))
    t = t[..., None]
    rgb = (a * (1 - t) + b * t).clip(0, 255).astype(np.uint8)
    alpha = np.full((size, size, 1), 255, dtype=np.uint8)
    return Image.fromarray(np.concatenate([rgb, alpha], axis=2), "RGBA")


def radial_sheen(size: int) -> Image.Image:
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    cx, cy = 0.18 * size, 0.08 * size
    radius = 0.82 * size
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius
    alpha = (np.clip(1 - dist, 0, 1) ** 2.2 * 0.18 * 255).astype(np.uint8)
    rgb = np.zeros((size, size, 3), dtype=np.uint8)
    rgb[..., 0] = 125
    rgb[..., 1] = 211
    rgb[..., 2] = 252
    return Image.fromarray(np.concatenate([rgb, alpha[..., None]], axis=2), "RGBA")


def q_curve(p0, p1, p2, steps=28):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))
    return pts


def sample_color(image: Image.Image, x: float, y: float) -> tuple[int, int, int, int]:
    return image.getpixel((int(round(x)), int(round(y))))


def main() -> None:
    OUT.mkdir(exist_ok=True)
    scale = S / 512

    def p(x: float, y: float) -> tuple[float, float]:
        return (x * scale, y * scale)

    outer = rounded_mask(S, int(116 * scale))
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bg = linear_gradient(S, "#0B1526", "#13233D", diagonal=True)
    canvas.paste(bg, (0, 0), outer)
    canvas.alpha_composite(radial_sheen(S))

    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (8 * scale, 8 * scale, 504 * scale, 504 * scale),
        radius=116 * scale,
        outline=(38, 58, 87, 255),
        width=max(2, int(1.6 * scale)),
    )
    draw.rounded_rectangle(
        (23 * scale, 23 * scale, 489 * scale, 489 * scale),
        radius=101 * scale,
        outline=(27, 44, 70, 235),
        width=max(2, int(1.4 * scale)),
    )

    points = [p(134, 150), p(134, 325)]
    points += q_curve(p(134, 325), p(134, 345), p(154, 345))[1:]
    points += [p(224, 345), p(390, 160)]

    width = int(34 * scale)
    path_mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(path_mask)
    d.line(points, fill=255, width=width, joint="curve")
    r = width / 2
    for point in points:
        d.ellipse((point[0] - r, point[1] - r, point[0] + r, point[1] + r), fill=255)

    glow_mask = path_mask.filter(ImageFilter.GaussianBlur(14 * scale))
    glow = Image.new("RGBA", (S, S), (34, 211, 238, 0))
    glow.putalpha(glow_mask.point(lambda v: int(v * 0.55)))
    canvas.alpha_composite(glow)

    gradient = mark_gradient(S)
    mark_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mark_layer.paste(gradient, (0, 0), path_mask)
    canvas.alpha_composite(mark_layer)

    nodes = [
        (p(134, 150), sample_color(gradient, *p(134, 150))),
        (p(134, 325), sample_color(gradient, *p(134, 325))),
        (p(224, 345), sample_color(gradient, *p(224, 345))),
        (p(307, 252), sample_color(gradient, *p(307, 252))),
        (p(390, 160), (251, 191, 36, 255)),
    ]
    d = ImageDraw.Draw(canvas)
    for (cx, cy), color in nodes:
        r = 13 * scale if color == (251, 191, 36, 255) else 11.5 * scale
        ring = max(2, int(5 * scale))
        d.ellipse((cx - r - ring, cy - r - ring, cx + r + ring, cy + r + ring), fill=(11, 21, 38, 255))
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)

    # Very subtle outer sheen on the top edge.
    top = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(top)
    td.rounded_rectangle((8 * scale, 8 * scale, 504 * scale, 504 * scale), radius=116 * scale, outline=(125, 211, 252, 28), width=max(2, int(1.2 * scale)))
    canvas.alpha_composite(top)

    for px in (1024, 512, 128):
        resized = canvas.resize((px, px), Image.Resampling.LANCZOS)
        resized.save(OUT / f"icon-{px}.png", optimize=True)

    print("wrote", OUT / "icon-1024.png")
    print("wrote", OUT / "icon-512.png")
    print("wrote", OUT / "icon-128.png")


if __name__ == "__main__":
    main()
