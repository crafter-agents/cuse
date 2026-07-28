import { test, expect, describe } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { decodeXWD, readXwdHeader } from "../src/xwd.ts";
import { decodePNG, encodePNG, isUniform } from "../src/png.ts";

const deflate = (d: Uint8Array) => new Uint8Array(deflateSync(d));
const inflate = (d: Uint8Array) => new Uint8Array(inflateSync(d));

/** A real XWD v7 ZPixmap dump, built to the format rather than mocked. */
function makeXWD(width: number, height: number, px: (x: number, y: number) => [number, number, number], opts: {
  bpp?: number; byteOrder?: number; masks?: [number, number, number];
} = {}): Uint8Array {
  const bpp = opts.bpp ?? 32;
  const [rm, gm, bm] = opts.masks ?? [0xff0000, 0x00ff00, 0x0000ff];
  const headerSize = 100;
  const bytes = bpp / 8;
  const bytesPerLine = width * bytes;
  const out = new Uint8Array(headerSize + bytesPerLine * height);
  const dv = new DataView(out.buffer);
  const w = (i: number, v: number) => dv.setUint32(i * 4, v);
  w(0, headerSize); w(1, 7); w(2, 2); w(3, 24);
  w(4, width); w(5, height);
  w(7, opts.byteOrder ?? 1);
  w(11, bpp); w(12, bytesPerLine);
  w(14, rm); w(15, gm); w(16, bm);
  w(19, 0); // no colormap entries
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      const shift = (m: number) => { let s = 0; while (((m >>> s) & 1) === 0) s++; return s; };
      const v = ((r << shift(rm)) | (g << shift(gm)) | (b << shift(bm))) >>> 0;
      const p = headerSize + y * bytesPerLine + x * bytes;
      if (bytes === 4) dv.setUint32(p, v, (opts.byteOrder ?? 1) !== 1);
      else { out[p] = v & 0xff; out[p + 1] = (v >>> 8) & 0xff; out[p + 2] = (v >>> 16) & 0xff; }
    }
  }
  return out;
}

describe("xwd header", () => {
  test("reads the fields xwd actually writes", () => {
    const h = readXwdHeader(makeXWD(1280, 1024, () => [0, 0, 0]));
    // These are the values the runner's own dump began with: v7, ZPixmap, depth 24.
    expect([h.version, h.format, h.depth]).toEqual([7, 2, 24]);
    expect([h.width, h.height]).toEqual([1280, 1024]);
  });
  test("refuses a file that is not one", () => {
    expect(() => readXwdHeader(new Uint8Array(10))).toThrow("not an XWD file");
  });
});

describe("xwd decode", () => {
  test("recovers the pixels that were written", () => {
    const img = decodeXWD(makeXWD(4, 2, (x, y) => [x * 10, y * 20, 30]));
    expect([img.width, img.height, img.channels]).toEqual([4, 2, 3]);
    expect(Array.from(img.data.slice(0, 3))).toEqual([0, 0, 30]);
    expect(Array.from(img.data.slice(3, 6))).toEqual([10, 0, 30]);
  });
  test("channel order comes from the masks, not from a guess", () => {
    // A BGR server: read as RGB this would silently swap red and blue.
    const bgr = makeXWD(1, 1, () => [200, 100, 50], { masks: [0x0000ff, 0x00ff00, 0xff0000] });
    expect(Array.from(decodeXWD(bgr).data)).toEqual([200, 100, 50]);
  });
  test("handles both byte orders", () => {
    const lsb = makeXWD(2, 2, () => [1, 2, 3], { byteOrder: 0 });
    expect(Array.from(decodeXWD(lsb).data.slice(0, 3))).toEqual([1, 2, 3]);
  });
  test("24-bit packing works as well as 32", () => {
    expect(Array.from(decodeXWD(makeXWD(2, 1, () => [9, 8, 7], { bpp: 24 })).data.slice(0, 3))).toEqual([9, 8, 7]);
  });
  test("refuses what it cannot decode rather than producing wrong colours", () => {
    const bad = makeXWD(2, 2, () => [0, 0, 0]);
    new DataView(bad.buffer).setUint32(1 * 4, 6); // version 6
    expect(() => decodeXWD(bad)).toThrow("unsupported XWD version");
    const truncated = makeXWD(8, 8, () => [0, 0, 0]).slice(0, 120);
    expect(() => decodeXWD(truncated)).toThrow("truncated");
  });
});

describe("xwd to png, the whole capture path", () => {
  test("a dump becomes a PNG with the same pixels", () => {
    const dump = makeXWD(8, 4, (x, y) => [x * 30, y * 60, 128]);
    const png = encodePNG(decodeXWD(dump), deflate);
    const back = decodePNG(png, inflate);
    expect([back.width, back.height, back.channels]).toEqual([8, 4, 3]);
    expect(Array.from(back.data)).toEqual(Array.from(decodeXWD(dump).data));
  });
  test("a blank display round-trips as a blank frame, which is what warns", () => {
    const png = encodePNG(decodeXWD(makeXWD(16, 16, () => [0, 0, 0])), deflate);
    expect(isUniform(decodePNG(png, inflate))).toBe(true);
  });
  test("the encoder writes a real PNG signature and IHDR", () => {
    const png = encodePNG({ width: 2, height: 2, channels: 3, data: new Uint8Array(12) }, deflate);
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(String.fromCharCode(...png.slice(12, 16))).toBe("IHDR");
  });
});
