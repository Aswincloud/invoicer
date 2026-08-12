#!/usr/bin/env python3
"""Serialised product stickers for 38x25mm and 50x15mm label stock.

    scripts/make-stickers.py 40            # 40 codes, both sizes, plus an A4 sheet
    scripts/make-stickers.py 40 --dry-run  # render, write no ledger

── What these do, and what they do not ──────────────────────────────────────

Each sticker carries a unique unguessable code. That makes FORGERY impossible:
a code is only valid if it is in the ledger, so nobody can invent one.

It does NOT make the sticker uncopyable. A QR is a printed picture; photograph
it, reprint it, and it scans identically. Nothing printable can prevent that.
What serialisation buys is that a copy is DETECTABLE — once a verify page
exists, a code scanned forty times from three cities is visibly not a first
owner's, which is the only defence that actually scales.

The physical half is a material, not software: destructible vinyl or
void-when-removed adhesive is what stops someone peeling a genuine sticker off
a real box and onto a fake one.

── The ledger is a credential ───────────────────────────────────────────────

codes.jsonl is what a verify page would check against. Anyone holding it can
print stickers that verify. It is written OUTSIDE the repository on purpose —
this repository is public — and the script refuses to write it inside a git
working tree.

── The QR points at a page that does not exist yet ──────────────────────────

By design: the URL is fixed now so that adding the verify route later makes
every already-printed sticker work, with no reprinting. Until that route
exists, scanning gives a 404 — so do not put these on customer boxes yet.
"""

import argparse
import io
import json
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone

from PIL import Image, ImageDraw, ImageFont
import segno

# Where a verify page will live. Fixed now so printed stickers keep working when
# it is built — changing it later means reprinting everything.
VERIFY_BASE = "https://invoicer.aswincloud.com/v/"
BRAND = "Aswin3DPrints"

# Crockford-style: no I, L, O or U. Removes the read-it-aloud and type-it-back
# confusions (1/I, 0/O) that matter for a code printed on a receipt.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LEN = 10                    # 32^10 ≈ 1.1e15

# The printer's OWN resolution, not a nicer round number. At 203.2dpi there are
# exactly 8 dots per millimetre, so every dimension here lands on a whole dot and
# nothing is resampled anywhere in the chain. Rendering at 600 and rasterising at
# 203.2 put the strip at 385 dots against a 384-dot head — one dot over, and the
# driver would have rescaled the QR to fit.
DPI = 203.2
MM = DPI / 25.4                  # exactly 8

FONT_DIR = "/usr/share/fonts/truetype/dejavu"


def px(mm):
    return int(round(mm * MM))


def font(name, size_mm):
    path = os.path.join(FONT_DIR, name)
    return ImageFont.truetype(path, px(size_mm))


def make_code():
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))


def pretty(code):
    """K7M2Q9XR4T -> K7M2-Q9XR-4T, so it can be read aloud and typed back."""
    return "-".join([code[0:4], code[4:8], code[8:]])


def qr_image(data, target_mm):
    """QR as a PIL image, plus the physical size of one module.

    The module size is returned because it is the number that decides whether a
    phone can read the thing: below ~0.4mm most cameras start failing at normal
    distance, and that is a property of the URL length, not of the label.
    """
    qr = segno.make(data, error="m")
    modules = qr.symbol_size(scale=1, border=4)[0]      # includes the quiet zone
    # A WHOLE number of dots per module, and no resize afterwards. A module
    # spread over 4.3 dots gets rounded unevenly across the symbol, and a
    # misshapen module is one a phone may fail to read.
    scale = max(1, int(px(target_mm) // modules))
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=scale, border=4)
    buf.seek(0)
    img = Image.open(buf).convert("L")
    return img, scale / MM


def fit_font(draw, text, max_w_px, ttf, start_mm, min_mm=1.1, step_mm=0.05):
    """Largest size at which `text` fits `max_w_px`, down to a floor.

    Measured, not estimated. The first version of this label guessed the sizes
    and printed "Aswin3DPrint" — the brand name silently cropped at the label
    edge, which is the one thing on a sticker that must never be wrong.
    """
    size = start_mm
    while size > min_mm:
        f = font(ttf, size)
        if draw.textlength(text, font=f) <= max_w_px:
            return f, size
        size -= step_mm
    return font(ttf, min_mm), min_mm


def label_38x25(url):
    """Box sticker: QR left, brand and "SCAN TO VERIFY" right.

    No printed code. The QR carries the identity, and twelve characters of
    serial took a third of a 38mm label to say something no customer types in.
    """
    W, H = px(38), px(25)
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)

    pad, gap = px(1.5), px(1.2)
    qr_mm = 21.0                      # as large as 25mm of height allows
    qr, module_mm = qr_image(url, qr_mm)      # already a whole number of dots
    im.paste(qr, (pad, (H - qr.size[1]) // 2))

    x = pad + qr.size[0] + gap
    col_w = W - x - pad

    # The brand splits over two lines so it can be set larger than a single
    # 13-character line would allow in the column that remains beside the QR.
    one_line = font("DejaVuSans-Bold.ttf", 1.9)
    brand_lines = [BRAND] if d.textlength(BRAND, font=one_line) <= col_w else ["Aswin", "3DPrints"]
    f_brand, _ = fit_font(d, max(brand_lines, key=len), col_w, "DejaVuSans-Bold.ttf", 2.6)
    f_small, _ = fit_font(d, "SCAN TO", col_w, "DejaVuSans.ttf", 1.7)

    lh_b = f_brand.size * 1.12
    lh_s = f_small.size * 1.18
    total = lh_b * len(brand_lines) + px(1.0) + lh_s * 2
    y = (H - total) / 2

    for line in brand_lines:
        d.text((x, y), line, font=f_brand, fill=0); y += lh_b
    y += px(1.0)
    d.text((x, y), "SCAN TO", font=f_small, fill=95); y += lh_s
    d.text((x, y), "VERIFY", font=f_small, fill=95)
    return im, module_mm


def strip(labels, label_mm, gap_mm, x_offset_mm, head_mm=48.0):
    """The labels laid out down a continuous roll, at the roll's own pitch.

    Full head width (48mm = 384 dots at 203.2dpi) so nothing is scaled at print
    time, and each label occupies exactly one PITCH: its own height plus the
    die-cut gap. The gap is printed as blank rows rather than fed by a command,
    for the same reason the receipt pads with rows — a feed command is optional
    in ESC/POS and this printer ignores at least one of them, whereas a blank
    row advances the paper by exactly 0.125mm.

    This printer has no gap sensor: it cannot find the labels, so the geometry
    has to be exact and the first label is aligned by hand.
    """
    lw, lh = label_mm
    pitch = lh + gap_mm
    W = px(head_mm)
    H = px(pitch) * len(labels)
    sheet = Image.new("L", (W, H), 255)
    for i, im in enumerate(labels):
        sheet.paste(im, (px(x_offset_mm), px(pitch) * i))
    return sheet, pitch


def inside_git_repo(path):
    try:
        subprocess.run(["git", "-C", os.path.dirname(path) or ".", "rev-parse",
                        "--is-inside-work-tree"], check=True,
                       capture_output=True, timeout=15)
        return True
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("count", type=int, nargs="?", default=20)
    ap.add_argument("--out", default=os.path.expanduser("~/stickers"))
    ap.add_argument("--gap", type=float, default=2.0,
                    help="die-cut gap between labels, mm (default 2)")
    ap.add_argument("--x-offset", type=float, default=0.0,
                    help="where the label starts across the 48mm head, mm")
    ap.add_argument("--dry-run", action="store_true",
                    help="render but do not record the codes")
    a = ap.parse_args()

    ledger = os.path.join(a.out, "codes.jsonl")
    if inside_git_repo(ledger):
        sys.exit(f"Refusing to write the ledger inside a git repository:\n  {ledger}\n"
                 "These codes are the credential a verify page checks. This "
                 "repository is public.")

    batch = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    outdir = os.path.join(a.out, f"batch-{batch}")
    os.makedirs(outdir, exist_ok=True)

    codes = [make_code() for _ in range(a.count)]
    assert len(set(codes)) == len(codes), "duplicate code generated"

    labels, module_mm = [], None
    for c in codes:
        im, module_mm = label_38x25(VERIFY_BASE + c)
        labels.append(im)

    roll, pitch = strip(labels, (38, 25), a.gap, a.x_offset)
    # PNG is the printable artifact, not PDF. Going through a PDF means
    # pdftoppm re-rasterises it, and its rounding turned an exact 864-row strip
    # into 865 — a 0.116% stretch that walked the fourth label 0.1mm down the
    # roll. Cumulative drift is the one error a gap-sensorless label print
    # cannot absorb. This bitmap is already at the head's resolution, so it is
    # sent exactly as built.
    roll_path = os.path.join(outdir, "labels-strip.png")
    roll.save(roll_path, dpi=(DPI, DPI))
    roll.save(os.path.join(outdir, "labels-strip.pdf"), resolution=DPI)  # to look at
    labels[0].save(os.path.join(outdir, "preview-label.png"), dpi=(DPI, DPI))

    print(f"{a.count} labels -> {outdir}")
    print(f"  labels-strip.png   {roll.size[0]} x {roll.size[1]} dots = "
          f"{roll.size[0]/MM:.2f} x {roll.size[1]/MM:.2f} mm")
    print(f"  pitch              {pitch:.1f}mm  (25mm label + {a.gap:.1f}mm gap)")
    print(f"  x offset           {a.x_offset:.1f}mm across the 48mm head")
    print(f"  QR module          {module_mm:.2f}mm "
          f"({'OK' if module_mm >= 0.4 else 'TOO SMALL'})")
    print(f"\n  print with:  ~/tejprint/print-labels.sh {roll_path}")

    if a.dry_run:
        print("\nDry run — nothing recorded.")
        return 0

    os.makedirs(a.out, exist_ok=True)
    with open(ledger, "a", encoding="utf-8") as f:
        for c in codes:
            f.write(json.dumps({"code": c, "url": VERIFY_BASE + c,
                                "batch": batch, "brand": BRAND,
                                "created_at": datetime.now(timezone.utc).isoformat()}) + "\n")
    total = sum(1 for _ in open(ledger, encoding="utf-8"))
    print(f"\nRecorded {a.count} codes in {ledger} ({total} total).")
    print("Back this file up — it is the only record of which codes are genuine.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
