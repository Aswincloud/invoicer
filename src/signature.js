// The authorised signatory's signature, as stored and as rendered.
//
// Stored on the business as "<w>:<h>:<base64>" — a 1-bit mask, rows padded to
// byte boundaries, a set bit meaning ink. Not a PNG, and not by accident:
//
//   * The browser produces it. It already downscales the logo through a canvas,
//     so thresholding and packing there is a few lines, and it means the Worker
//     never has to decode a PNG — which would mean carrying a full inflater
//     purely to find out where the ink is.
//   * One bit per pixel is what a signature actually is. It also makes the
//     thermal receipt and the PDF agree exactly: both consume these same bits,
//     rather than each thresholding a greyscale image slightly differently.
//
// From here the three server-side surfaces are cheap: the PDF embeds the bits
// directly as an /ImageMask, and email re-encodes them with the PNG writer in
// bitmap.js.

import { png1bit } from "./bitmap.js";

// Bytes per row. Every row starts on a byte boundary, which is both how PDF
// image data is defined and what makes the packing loop simple.
export const signStride = (w) => (w + 7) >> 3;

/* Parse the stored value, or null.

   Strict about the length: a truncated value would otherwise draw a signature
   that fades into garbage halfway down, which on a signed document is worse
   than drawing nothing at all. */
export function parseSignature(stored) {
  const m = /^(\d{1,5}):(\d{1,5}):([A-Za-z0-9+/=]+)$/.exec(String(stored || "").trim());
  if (!m) return null;

  const w = Number(m[1]), h = Number(m[2]);
  if (!w || !h || w > 4000 || h > 4000) return null;

  let bin;
  try { bin = atob(m[3]); } catch { return null; }
  if (bin.length !== signStride(w) * h) return null;

  const bits = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bits[i] = bin.charCodeAt(i);
  return { w, h, bits };
}

/* Is this pixel ink? Bit 7 of each byte is the leftmost pixel — MSB first, the
   order PDF image data uses, so the PDF can hand these bytes over untouched. */
export const signInk = (sig, x, y) =>
  ((sig.bits[y * signStride(sig.w) + (x >> 3)] >> (7 - (x & 7))) & 1) === 1;

/* A base64 PNG for the emailed copy, which cannot take vectors or raw bits.
   Scale 1: the mask is already ~720px wide, which is plenty for an email. */
export function signPngBase64(stored, scale = 1) {
  const sig = parseSignature(stored);
  if (!sig) return "";
  return png1bit(sig.w, sig.h, (x, y) => signInk(sig, x, y), scale, 0);
}
