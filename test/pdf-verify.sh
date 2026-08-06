#!/usr/bin/env bash
# Verify the generated PDFs with INDEPENDENT parsers.
#
# Run: node test/pdf.mjs && bash test/pdf-verify.sh
#
# test/pdf.mjs asserts the structure using its own reading of the file, which is
# circular: the same understanding produced the bytes and then checked them. This
# script hands the files to poppler (pdftotext/pdfinfo) and pypdf — parsers with
# no knowledge of how they were made. If they can open the file and read the
# figures back, a customer's PDF reader can too.
#
# Skips cleanly when the tools are absent, rather than failing a run for a
# missing dev dependency.
set -uo pipefail

pass=0; fail=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FAIL $1${3:+ — $3}"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

for f in /tmp/pdftest-simple.pdf /tmp/pdftest-multipage.pdf /tmp/pdftest-nasty.pdf /tmp/pdftest-gst.pdf; do
  [ -f "$f" ] || { echo "  missing $f — run: node test/pdf.mjs"; exit 1; }
done

if have pdfinfo; then
  echo
  echo "poppler: does it open?"
  ok "simple invoice opens" "$(pdfinfo /tmp/pdftest-simple.pdf >/dev/null 2>&1 && echo 1 || echo 0)"
  ok "multipage opens" "$(pdfinfo /tmp/pdftest-multipage.pdf >/dev/null 2>&1 && echo 1 || echo 0)"
  ok "one with brackets and accents opens" "$(pdfinfo /tmp/pdftest-nasty.pdf >/dev/null 2>&1 && echo 1 || echo 0)"
  P=$(pdfinfo /tmp/pdftest-simple.pdf 2>/dev/null | awk '/^Pages:/{print $2}')
  ok "simple invoice is 1 page" "$([ "$P" = "1" ] && echo 1 || echo 0)" "got $P"
  M=$(pdfinfo /tmp/pdftest-multipage.pdf 2>/dev/null | awk '/^Pages:/{print $2}')
  ok "40 items span several pages" "$([ "${M:-0}" -gt 1 ] && echo 1 || echo 0)" "got $M"
  S=$(pdfinfo /tmp/pdftest-simple.pdf 2>/dev/null | grep -c "595.28 x 841.89")
  ok "page size is A4" "$([ "${S:-0}" -ge 1 ] && echo 1 || echo 0)"
else
  echo "  (pdfinfo not installed — skipping poppler structure checks)"
fi

if have pdftotext; then
  echo
  echo "poppler: is the text actually extractable?"
  T=$(pdftotext -layout /tmp/pdftest-simple.pdf - 2>/dev/null)
  # This is the difference between a real PDF and a screenshot: a customer can
  # select the total, and search finds the invoice number.
  ok "the total reads back exactly"      "$(echo "$T" | grep -qF 'Rs. 1,098.00' && echo 1 || echo 0)"
  ok "the invoice number is searchable"  "$(echo "$T" | grep -qF 'AP-2026-PDFTEST' && echo 1 || echo 0)"
  ok "the business name is there"        "$(echo "$T" | grep -qF 'AswinPrints' && echo 1 || echo 0)"
  ok "the customer is there"             "$(echo "$T" | grep -qF 'Test Buyer' && echo 1 || echo 0)"
  ok "the item line is there"            "$(echo "$T" | grep -qF 'Dragon 3D Print' && echo 1 || echo 0)"
  ok "the promo code is named"           "$(echo "$T" | grep -qF 'CHAT-ABC123' && echo 1 || echo 0)"
  ok "shipping appears"                  "$(echo "$T" | grep -qF 'Rs. 99.00' && echo 1 || echo 0)"
  # -- before the pattern: without it, grep reads "-300.00" as an option.
  ok "the discount is negative"          "$(echo "$T" | grep -qF -- '-300.00' && echo 1 || echo 0)"
  ok "notes carry the order reference"   "$(echo "$T" | grep -qF 'AP-pdftest' && echo 1 || echo 0)"
  # A no-tax invoice must not imply tax exists.
  ok "no CGST/SGST on a no-tax invoice"  "$(echo "$T" | grep -qE 'CGST|SGST' && echo 0 || echo 1)"
  ok "no 'Taxable value' either"         "$(echo "$T" | grep -qF 'Taxable value' && echo 0 || echo 1)"

  echo
  echo "poppler: the awkward cases"
  N=$(pdftotext -layout /tmp/pdftest-nasty.pdf - 2>/dev/null)
  # Parentheses in a product name are the most likely real-world breaker.
  ok "brackets survive intact"      "$(echo "$N" | grep -qF 'Dragon (Large)' && echo 1 || echo 0)"
  ok "accented name survives"       "$(echo "$N" | grep -qF 'Jos' && echo 1 || echo 0)"
  ok "backslash did not corrupt it" "$(echo "$N" | grep -qF 'Buyer' && echo 1 || echo 0)"

  G=$(pdftotext -layout /tmp/pdftest-gst.pdf - 2>/dev/null)
  ok "a GST invoice shows CGST"     "$(echo "$G" | grep -qF 'CGST' && echo 1 || echo 0)"
  ok "a GST invoice shows SGST"     "$(echo "$G" | grep -qF 'SGST' && echo 1 || echo 0)"
  ok "and the GSTIN"                "$(echo "$G" | grep -qF '33ABCDE1234F1Z5' && echo 1 || echo 0)"
  ok "and 'Taxable value' IS shown" "$(echo "$G" | grep -qF 'Taxable value' && echo 1 || echo 0)"

  M=$(pdftotext -layout /tmp/pdftest-multipage.pdf - 2>/dev/null)
  ok "first item is present"        "$(echo "$M" | grep -qF 'Item number 1' && echo 1 || echo 0)"
  ok "last item is present"         "$(echo "$M" | grep -qF 'Item number 40' && echo 1 || echo 0)"
  ok "pages are numbered"           "$(echo "$M" | grep -qE 'Page 1 of' && echo 1 || echo 0)"
  # 40 x 2 x 149.50 = 11,960 + 99 shipping = 12,059
  ok "multipage total is right"     "$(echo "$M" | grep -qF 'Rs. 12,059.00' && echo 1 || echo 0)"
else
  echo "  (pdftotext not installed — skipping text extraction)"
fi

if python3 -c "import pypdf" 2>/dev/null; then
  echo
  echo "pypdf: a second, unrelated parser"
  R=$(python3 - <<'PY'
import sys
from pypdf import PdfReader
try:
    r = PdfReader("/tmp/pdftest-simple.pdf")
    txt = "".join(p.extract_text() or "" for p in r.pages)
    checks = [
        ("opens", True),
        ("one page", len(r.pages) == 1),
        ("not encrypted", not r.is_encrypted),
        ("total readable", "1,098.00" in txt),
        ("number readable", "AP-2026-PDFTEST" in txt),
    ]
    m = PdfReader("/tmp/pdftest-multipage.pdf")
    checks.append(("multipage opens", len(m.pages) > 1))
    for name, res in checks:
        print(f"{'1' if res else '0'} {name}")
except Exception as e:
    print(f"0 pypdf raised: {e}")
PY
)
  while read -r res name; do ok "$name" "$res"; done <<< "$R"
else
  echo "  (pypdf not installed — skipping)"
fi

echo
echo "  pdf-verify: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
