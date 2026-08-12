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

DPI = 600                        # label printers are 203–600; 600 renders clean
MM = DPI / 25.4                  # pixels per mm

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
    scale = max(1, int(px(target_mm) / modules))
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=scale, border=4)
    buf.seek(0)
    img = Image.open(buf).convert("L")
    # Measured against the size it is PLACED at, not the size it was rendered
    # at — the caller resizes to target_mm, and reporting the pre-resize figure
    # overstated it.
    return img, target_mm / modules


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


def label_38x25(code, url):
    """Box sticker: QR left, brand and code stacked right."""
    W, H = px(38), px(25)
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)

    pad, gap = px(1.2), px(1.0)
    qr_mm = 19.0                      # 19 keeps modules at ~0.46mm — see main()
    qr, module_mm = qr_image(url, qr_mm)
    qr = qr.resize((px(qr_mm), px(qr_mm)), Image.NEAREST)
    im.paste(qr, (pad, (H - px(qr_mm)) // 2))

    x = pad + px(qr_mm) + gap
    col_w = W - x - pad               # what is actually left for text

    f_brand, _ = fit_font(d, BRAND, col_w, "DejaVuSans-Bold.ttf", 2.2)
    f_small, _ = fit_font(d, "SCAN TO VERIFY", col_w, "DejaVuSans.ttf", 1.5)

    # One line if it fits at a readable size; otherwise split at a group
    # boundary — never leaving a hyphen stranded at the start of a line.
    p = pretty(code)
    f_code, size = fit_font(d, p, col_w, "DejaVuSansMono-Bold.ttf", 2.3, min_mm=1.7)
    code_lines = [p]
    if d.textlength(p, font=f_code) > col_w:
        code_lines = [code[:5], code[5:]]
        f_code, size = fit_font(d, code_lines[0], col_w,
                                "DejaVuSansMono-Bold.ttf", 2.6, min_mm=1.7)

    # Stack the block and centre it vertically against the QR.
    lh_brand = f_brand.size * 1.25
    lh_small = f_small.size * 1.2
    lh_code = f_code.size * 1.2
    total = lh_brand + lh_small + px(0.8) + lh_code * len(code_lines)
    y = (H - total) / 2

    d.text((x, y), BRAND, font=f_brand, fill=0); y += lh_brand
    d.text((x, y), "SCAN TO VERIFY", font=f_small, fill=105); y += lh_small + px(0.8)
    for line in code_lines:
        d.text((x, y), line, font=f_code, fill=0); y += lh_code

    d.rectangle([0, 0, W - 1, H - 1], outline=200, width=1)   # cut guide
    return im, module_mm


def label_50x15(code, url):
    """Receipt strip: the code, large. No QR — see the note in main()."""
    W, H = px(50), px(15)
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)

    f_brand = font("DejaVuSans-Bold.ttf", 2.4)
    f_small = font("DejaVuSans.ttf", 1.7)
    f_code = font("DejaVuSansMono-Bold.ttf", 3.6)

    d.text((px(2.5), px(2.0)), BRAND, font=f_brand, fill=0)
    d.text((px(2.5), px(5.2)), "PRODUCT CODE", font=f_small, fill=110)
    d.text((px(2.5), px(8.0)), pretty(code), font=f_code, fill=0)

    d.rectangle([0, 0, W - 1, H - 1], outline=200, width=1)
    return im


def a4_sheet(labels, label_mm, cols_gap_mm=2.0):
    """Grid of 38x25 labels on A4, for cutting by hand."""
    W, H = px(210), px(297)
    sheet = Image.new("L", (W, H), 255)
    lw, lh = px(label_mm[0]), px(label_mm[1])
    gap = px(cols_gap_mm)
    margin = px(6)

    cols = (W - 2 * margin + gap) // (lw + gap)
    rows = (H - 2 * margin + gap) // (lh + gap)
    placed = 0
    for r in range(rows):
        for c in range(cols):
            if placed >= len(labels):
                break
            x = margin + c * (lw + gap)
            y = margin + r * (lh + gap)
            sheet.paste(labels[placed], (x, y))
            placed += 1
    return sheet, placed, cols, rows


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
    ap.add_argument("--dry-run", action="store_true",
                    help="render the PDFs but do not record the codes")
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
    # Astronomically unlikely at these sizes, but a duplicate code is exactly the
    # failure this whole thing exists to prevent, so it is checked rather than
    # assumed.
    assert len(set(codes)) == len(codes), "duplicate code generated"

    big, small, module_mm = [], [], None
    for c in codes:
        url = VERIFY_BASE + c
        im, module_mm = label_38x25(c, url)
        big.append(im)
        small.append(label_50x15(c, url))

    big[0].save(os.path.join(outdir, "labels-38x25.pdf"), save_all=True,
                append_images=big[1:], resolution=DPI)
    small[0].save(os.path.join(outdir, "labels-50x15.pdf"), save_all=True,
                  append_images=small[1:], resolution=DPI)
    sheet, placed, cols, rows = a4_sheet(big, (38, 25))
    sheet.save(os.path.join(outdir, "sheet-a4-38x25.pdf"), resolution=DPI)
    big[0].save(os.path.join(outdir, "preview-38x25.png"), dpi=(DPI, DPI))
    small[0].save(os.path.join(outdir, "preview-50x15.png"), dpi=(DPI, DPI))

    print(f"{a.count} codes -> {outdir}")
    print(f"  labels-38x25.pdf     one per page, {38}x{25}mm")
    print(f"  labels-50x15.pdf     one per page, {50}x{15}mm")
    print(f"  sheet-a4-38x25.pdf   {cols}x{rows} grid, {placed} of {a.count} placed")
    print(f"  QR module size       {module_mm:.2f}mm "
          f"({'OK' if module_mm >= 0.4 else 'TOO SMALL — phones will struggle'})")
    print(f"  URL                  {VERIFY_BASE}<code>  ({len(VERIFY_BASE)+CODE_LEN} chars)")

    if a.dry_run:
        print("\nDry run — nothing recorded. The codes above exist only in these PDFs.")
        return 0

    os.makedirs(a.out, exist_ok=True)
    with open(ledger, "a", encoding="utf-8") as f:
        for c in codes:
            f.write(json.dumps({"code": c, "url": VERIFY_BASE + c,
                                "batch": batch, "brand": BRAND,
                                "created_at": datetime.now(timezone.utc).isoformat()}) + "\n")
    total = sum(1 for _ in open(ledger, encoding="utf-8"))
    print(f"\nRecorded {a.count} codes in {ledger} ({total} total).")
    print("Back this file up. It is the only record of which codes are genuine,")
    print("and a verify page built later will import it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
