// XWD, the dump format `xwd` writes.
//
// It exists here so that a Linux screenshot costs one small package
// (x11-apps, which carries xwd) instead of imagemagick. The runner recon showed
// Xvfb already installed and imagemagick absent, so this is the difference
// between a screenshot that works out of the box and one that needs a download.
//
// Only what xwd actually emits for a root-window grab is supported: version 7,
// ZPixmap, 8 bits per channel, TrueColor. Anything else is refused by name.

import type { Image } from "./png.ts";

export type XwdHeader = {
  headerSize: number; version: number; format: number; depth: number;
  width: number; height: number; bitsPerPixel: number; bytesPerLine: number;
  byteOrder: number; redMask: number; greenMask: number; blueMask: number;
  ncolors: number;
};

const ZPIXMAP = 2;

/** Field offsets in the XWD v7 header, in 32-bit words, all big-endian. */
export function readXwdHeader(b: Uint8Array): XwdHeader {
  if (b.length < 100) throw new Error("not an XWD file: too short");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = (i: number) => dv.getUint32(i * 4);
  return {
    headerSize: w(0), version: w(1), format: w(2), depth: w(3),
    width: w(4), height: w(5),
    byteOrder: w(7), bitsPerPixel: w(11), bytesPerLine: w(12),
    redMask: w(14), greenMask: w(15), blueMask: w(16),
    ncolors: w(19),
  };
}

/** Where the low bit of a mask sits, and how wide the mask is. */
function shiftOf(mask: number): number {
  if (mask === 0) return 0;
  let s = 0;
  while (((mask >>> s) & 1) === 0) s++;
  return s;
}

/**
 * Decode an xwd dump into packed RGB samples.
 *
 * The channel order is taken from the masks rather than assumed: X servers
 * differ, and a BGRA frame read as RGBA is a screenshot with swapped colours
 * that still looks plausible enough to ship.
 */
export function decodeXWD(b: Uint8Array): Image {
  const h = readXwdHeader(b);
  if (h.version !== 7) throw new Error(`unsupported XWD version ${h.version} (only 7)`);
  if (h.format !== ZPIXMAP) throw new Error(`unsupported XWD format ${h.format} (only ZPixmap)`);
  if (h.bitsPerPixel !== 24 && h.bitsPerPixel !== 32) {
    throw new Error(`unsupported XWD depth: ${h.bitsPerPixel} bits per pixel`);
  }
  if (!h.width || !h.height) throw new Error("XWD header has no dimensions");

  // header, then the colormap (12 bytes per entry), then the pixels
  const start = h.headerSize + h.ncolors * 12;
  const need = start + h.bytesPerLine * h.height;
  if (b.length < need) throw new Error(`truncated XWD: ${b.length} of ${need} bytes`);

  const bytes = h.bitsPerPixel / 8;
  const [rs, gs, bs] = [shiftOf(h.redMask), shiftOf(h.greenMask), shiftOf(h.blueMask)];
  const out = new Uint8Array(h.width * h.height * 3);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  for (let y = 0; y < h.height; y++) {
    let p = start + y * h.bytesPerLine;
    for (let x = 0; x < h.width; x++, p += bytes) {
      // MSBFirst is byteOrder 1; xwd writes the pixel in the server's order.
      const px = bytes === 4
        ? (h.byteOrder === 1 ? dv.getUint32(p) : dv.getUint32(p, true))
        : (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16));
      const o = (y * h.width + x) * 3;
      out[o] = (px & h.redMask) >>> rs;
      out[o + 1] = (px & h.greenMask) >>> gs;
      out[o + 2] = (px & h.blueMask) >>> bs;
    }
  }
  return { width: h.width, height: h.height, channels: 3, data: out };
}
