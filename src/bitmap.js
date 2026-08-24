// 1-bit bitmaps: PNG out, and the deflate both it and the PDF need.
//
// Extracted from qr.js when the signature arrived. Both are 1-bit images that
// have to reach a mail client as real pixels — a QR because vectors cannot be
// emailed, a signature because it is a raster to begin with — and the PDF
// writer needs the same deflate to embed a signature as an /ImageMask. Three
// callers, one implementation.
//
// Written by hand rather than pulled in as a dependency because a 1-bit image
// is the easiest possible PNG: greyscale, no palette, no transparency, and no
// compression to implement. Deflate has a "stored" mode that is a length
// followed by the bytes, which is all this uses. A few dozen KB on an invoice
// is not worth a compressor, and a compressor is a lot of surface to be wrong.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const adler32 = (bytes) => {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type, data) {
  const name = [...type].map((ch) => ch.charCodeAt(0));
  const body = Uint8Array.from([...name, ...data]);
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

/* Deflate with every block stored uncompressed: a BFINAL/BTYPE byte, LEN, ~LEN,
   then the bytes. Valid deflate, so anything that reads FlateDecode or a PNG
   IDAT accepts it. */
export function storedDeflate(raw) {
  const out = [0x78, 0x01];                 // zlib header, 0x7801 % 31 === 0
  const MAX = 65535;
  for (let off = 0; off < raw.length || off === 0; off += MAX) {
    const slice = raw.subarray(off, Math.min(off + MAX, raw.length));
    const last = off + MAX >= raw.length ? 1 : 0;
    out.push(last, slice.length & 255, (slice.length >>> 8) & 255,
             ~slice.length & 255, (~slice.length >>> 8) & 255);
    for (let i = 0; i < slice.length; i++) out.push(slice[i]);
    if (last) break;
  }
  out.push(...be32(adler32(raw)));
  return out;
}

export const bytesToBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

/* A base64 PNG, black ink on white.

   `isInk(x, y)` is asked for each source pixel; `scale` repeats each one into a
   square of that many pixels, and `margin` adds that many SOURCE pixels of
   white on every side. The margin is not cosmetic for a QR — a reader will fail
   to find a code that runs to the edge of the ink. */
export function png1bit(width, height, isInk, scale = 1, margin = 0) {
  if (!width || !height) return "";

  const w = (width + margin * 2) * scale;
  const h = (height + margin * 2) * scale;

  // One filter byte (0 = none) per row, then one grey byte per pixel.
  const raw = new Uint8Array(h * (w + 1));
  raw.fill(0xff);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      if (!isInk(sx, sy)) continue;
      const y0 = (sy + margin) * scale;
      const x0 = (sx + margin) * scale;
      for (let y = y0; y < y0 + scale; y++) {
        const base = y * (w + 1) + 1 + x0;
        for (let x = 0; x < scale; x++) raw[base + x] = 0;
      }
    }
  }

  const ihdr = [...be32(w), ...be32(h), 8, 0, 0, 0, 0];   // 8-bit greyscale
  return bytesToBase64(Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", storedDeflate(raw)),
    ...chunk("IEND", []),
  ]));
}
