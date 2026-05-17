#!/usr/bin/env python3
"""
Composite Penny-Pincher OG image (1200×630): pincher artwork + favicon-style logo +
hero typography anchored to the bottom.

Usage:
  python3 scripts/generate_og_image.py [--input PATH] [--output PATH]

Defaults read ~/Desktop/pincher.png and write public/og-image.png
"""

from __future__ import annotations

import argparse
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

# Homepage palette (see public/index.html)
GLYPH = (11, 15, 34)
SPARK = (224, 74, 20)
NAVY_SHADOW = (8, 22, 60)
WHITE = (255, 255, 255)

OG_W, OG_H = 1200, 630

FONT_SOURCES = {
    "ArchivoBlack-Regular.ttf": (
        "https://github.com/google/fonts/raw/main/ofl/archivoblack/ArchivoBlack-Regular.ttf"
    ),
    # Variable Inter (opsz + wght); render subtitle at wght≈500 like homepage Inter 500
    "Inter-Variable.ttf": (
        "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf"
    ),
}


def ensure_fonts(font_dir: Path) -> None:
    font_dir.mkdir(parents=True, exist_ok=True)
    for name, url in FONT_SOURCES.items():
        dest = font_dir / name
        if dest.exists() and dest.stat().st_size > 1000:
            continue
        print(f"Downloading font {name} …")
        urllib.request.urlretrieve(url, dest)


def draw_logo(size: int, *, bg_white: bool = False) -> Image.Image:
    """Raster favicon geometry (public/favicon.svg) at ``size``×``size``."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size / 36.0

    def rr(
        x: float,
        y: float,
        w: float,
        h: float,
        rx: float,
        fill: tuple[int, int, int, int],
    ) -> None:
        draw.rounded_rectangle(
            [x * s, y * s, (x + w) * s, (y + h) * s],
            radius=max(1.0, rx * s),
            fill=fill,
        )

    bg = (*WHITE, 255) if bg_white else (*GLYPH, 255)
    rr(0, 0, 36, 36, 4, bg)

    peach = (240, 207, 171, 255)
    orange = (224, 74, 20, 255)

    for x, y in [
        (2, 2),
        (10, 2),
        (27, 2),
        (18, 10),
        (2, 18),
        (18, 18),
        (27, 18),
        (10, 27),
        (18, 27),
    ]:
        rr(x, y, 7, 7, 1, peach)

    for x, y in [(18, 2), (10, 10), (10, 18), (2, 27), (27, 27)]:
        rr(x, y, 7, 7, 1, orange)

    return img


def add_bottom_gradient(base: Image.Image) -> Image.Image:
    """Darken toward the bottom for text legibility."""
    w, h = base.size
    grad = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = grad.load()
    for y in range(h):
        # Start fade around upper third; strongest at bottom edge
        t = max(0.0, min(1.0, (y - h * 0.28) / (h * 0.72)))
        alpha = int(t * 195)
        if alpha <= 0:
            continue
        for x in range(w):
            px[x, y] = (*GLYPH, alpha)
    out = base.convert("RGBA")
    return Image.alpha_composite(out, grad)


def load_inter_medium(fonts_dir: Path, size_px: int) -> ImageFont.FreeTypeFont:
    path = str(fonts_dir / "Inter-Variable.ttf")
    font = ImageFont.truetype(path, size_px)
    try:
        # Inter VF axis order from Pillow / FreeType: optical size, then weight
        opsz = float(max(14, min(32, size_px)))
        font.set_variation_by_axes([opsz, 500.0])
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    return font


def draw_text_layer(
    size: tuple[int, int],
    fonts_dir: Path,
    title: str,
    subtitle: str,
    logo: Image.Image,
) -> Image.Image:
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    title_font = ImageFont.truetype(str(fonts_dir / "ArchivoBlack-Regular.ttf"), 86)
    sub_px = 39
    sub_font = load_inter_medium(fonts_dir, sub_px)

    margin_x, margin_b = 52, 52
    gap = 28

    # Measure subtitle + title stacks
    sub_bbox = draw.textbbox((0, 0), subtitle, font=sub_font)
    title_bbox = draw.textbbox((0, 0), title, font=title_font)
    title_h = title_bbox[3] - title_bbox[1]
    sub_h = sub_bbox[3] - sub_bbox[1]
    sub_gap = 18
    text_block_h = title_h + sub_gap + sub_h

    logo_h = logo.size[1]
    block_h = max(logo_h, text_block_h)
    y0 = OG_H - margin_b - block_h
    logo_y = y0 + (block_h - logo_h) // 2

    lx = margin_x
    layer.paste(logo, (lx, logo_y), logo)

    text_x = lx + logo.size[0] + gap
    title_y = y0 + (block_h - text_block_h) // 2
    sub_y = title_y + title_h + sub_gap

    # Layered shadows (match .hero-display)
    ox_spark, oy_spark = 3, 3
    ox_navy, oy_navy = 6, 6
    navy_alpha = int(255 * 0.55)

    def draw_title_rgba(fill: tuple[int, int, int, int], offx: float, offy: float) -> None:
        draw.text((text_x + offx, title_y + offy), title, font=title_font, fill=fill)

    draw_title_rgba((*NAVY_SHADOW, navy_alpha), ox_navy, oy_navy)
    draw_title_rgba((*SPARK, 255), ox_spark, oy_spark)
    draw_title_rgba((*WHITE, 255), 0, 0)

    draw.text((text_x + 1, sub_y + 2), subtitle, font=sub_font, fill=(*GLYPH, 140))
    draw.text((text_x, sub_y), subtitle, font=sub_font, fill=(*WHITE, 255))

    return layer


def main() -> None:
    parser = argparse.ArgumentParser()
    default_in = Path.home() / "Desktop" / "pincher.png"
    parser.add_argument("--input", type=Path, default=default_in)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "public" / "og-image.png",
    )
    args = parser.parse_args()

    if not args.input.is_file():
        raise SystemExit(f"Missing input image: {args.input}")

    script_dir = Path(__file__).resolve().parent
    fonts_dir = script_dir / "og-fonts"
    ensure_fonts(fonts_dir)

    base = Image.open(args.input).convert("RGB")
    base = ImageOps.fit(base, (OG_W, OG_H), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    base = add_bottom_gradient(base)

    logo = draw_logo(112, bg_white=True)

    title = "PENNY-PINCHER"
    subtitle = "OSS personal finance CLI • npx penny-pincher"

    text_layer = draw_text_layer((OG_W, OG_H), fonts_dir, title, subtitle, logo)
    final = Image.alpha_composite(base, text_layer)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    final.convert("RGB").save(args.output, "PNG", optimize=True)
    print(f"Wrote {args.output} ({OG_W}×{OG_H})")


if __name__ == "__main__":
    main()
