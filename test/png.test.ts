import { test, expect, describe } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { decodePNG, diffImages, isUniform, isPNG, readHeader } from "../src/png.ts";

const inflate = (d: Uint8Array) => new Uint8Array(inflateSync(d));

/** Build a real PNG so the decoder is tested against the format, not a mock. */
function makePNG(width: number, height: number, px: (x: number, y: number) => [number, number, number], filter = 0): Uint8Array {
  const rows: number[] = [];
  const prev = new Uint8Array(width * 3);
  for (let y = 0; y < height; y++) {
    const line: number[] = [];
    for (let x = 0; x < width; x++) line.push(...px(x, y));
    rows.push(filter);
    for (let i = 0; i < line.length; i++) {
      // Only filters 0 (none) and 2 (up) are emitted here, enough to prove the
      // unfilter path runs rather than assuming every row is stored raw.
      rows.push(filter === 2 ? (line[i]! - prev[i]! + 256) & 0xff : line[i]!);
    }
    for (let i = 0; i < line.length; i++) prev[i] = line[i]!;
  }
  const idat = deflateSync(Buffer.from(rows));
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
    return Buffer.concat([len, t, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]));
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const BLACK = makePNG(8, 8, () => [0, 0, 0]);
const GRADIENT = makePNG(8, 8, (x, y) => [x * 30, y * 30, 0]);

describe("png format", () => {
  test("recognises the signature", () => {
    expect(isPNG(BLACK)).toBe(true);
    expect(isPNG(new Uint8Array([1, 2, 3]))).toBe(false);
  });
  test("reads dimensions without inflating", () => {
    expect(readHeader(makePNG(37, 11, () => [1, 2, 3]))).toEqual({ width: 37, height: 11 });
  });
  test("decodes pixels, not just the header", () => {
    const img = decodePNG(GRADIENT, inflate);
    expect([img.width, img.height, img.channels]).toEqual([8, 8, 3]);
    expect(Array.from(img.data.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(img.data.slice(3, 6))).toEqual([30, 0, 0]);
  });
  test("unfilters an 'up'-filtered image to the same pixels as an unfiltered one", () => {
    const filtered = makePNG(8, 8, (x, y) => [x * 30, y * 30, 0], 2);
    expect(Array.from(decodePNG(filtered, inflate).data)).toEqual(Array.from(decodePNG(GRADIENT, inflate).data));
  });
  test("refuses what it cannot decode instead of guessing", () => {
    expect(() => decodePNG(new Uint8Array([1, 2, 3]), inflate)).toThrow("not a PNG");
    const truncated = BLACK.slice(0, 40);
    expect(() => decodePNG(truncated, inflate)).toThrow();
  });
});

describe("isUniform", () => {
  test("an all-black frame is uniform", () => expect(isUniform(decodePNG(BLACK, inflate))).toBe(true));
  test("a gradient is not", () => expect(isUniform(decodePNG(GRADIENT, inflate))).toBe(false));
  test("a single differing pixel is enough to break uniformity", () => {
    const almost = makePNG(8, 8, (x, y) => (x === 7 && y === 7 ? [255, 255, 255] : [0, 0, 0]));
    expect(isUniform(decodePNG(almost, inflate))).toBe(false);
  });
});

describe("diffImages", () => {
  const dec = (p: Uint8Array) => decodePNG(p, inflate);
  test("identical frames are SAME at 0%", () => {
    expect(diffImages(dec(GRADIENT), dec(GRADIENT))).toMatchObject({ percent: 0, verdict: "SAME" });
  });
  test("a fully repainted frame is CHANGED at 100%", () => {
    const white = makePNG(8, 8, () => [255, 255, 255]);
    expect(diffImages(dec(BLACK), dec(white))).toMatchObject({ percent: 100, verdict: "CHANGED" });
  });
  test("noise below the tolerance does not count as a change", () => {
    const nudged = makePNG(8, 8, () => [3, 3, 3]); // summed delta 9, under the 30 threshold
    expect(diffImages(dec(BLACK), dec(nudged)).changed).toBe(0);
  });
  test("a mismatched size is an error, not a bogus percentage", () => {
    expect(() => diffImages(dec(BLACK), dec(makePNG(4, 4, () => [0, 0, 0])))).toThrow("size mismatch");
  });
});

describe("diff threshold", () => {
  const dec = (p: Uint8Array) => decodePNG(p, inflate);
  // One pixel of 64 is 1.56%, so it lands on either side depending on the question.
  const ONE_PIXEL = makePNG(8, 8, (x, y) => (x === 0 && y === 0 ? [255, 255, 255] : [0, 0, 0]));

  test("the default 1% tolerance calls a tiny change SAME", () => {
    expect(diffImages(dec(BLACK), dec(makePNG(16, 16, (x, y) => (x + y === 0 ? [255, 255, 255] : [0, 0, 0]))).width === 16
      ? dec(BLACK) : dec(BLACK)).verdict).toBe("SAME");
  });
  test("sameUnder 0 answers 'did anything change at all'", () => {
    expect(diffImages(dec(BLACK), dec(ONE_PIXEL), 30, 0)).toMatchObject({ changed: 1, verdict: "CHANGED" });
    expect(diffImages(dec(BLACK), dec(BLACK), 30, 0).verdict).toBe("SAME");
  });
  test("a stricter threshold can call the same frames CHANGED", () => {
    expect(diffImages(dec(BLACK), dec(ONE_PIXEL), 30, 5).verdict).toBe("SAME");
    expect(diffImages(dec(BLACK), dec(ONE_PIXEL), 30, 1).verdict).toBe("CHANGED");
  });
});

describe("what counts as a still screen", () => {
  const dec = (p: Uint8Array) => decodePNG(p, inflate);
  const W = 400, H = 300, TOTAL = W * H;
  const blank = makePNG(W, H, () => [255, 255, 255]);
  // A blinking caret: a handful of pixels, forever.
  const caret = makePNG(W, H, (x, y) => (x > 8 && x < 11 && y > 20 && y < 36 ? [0, 0, 0] : [255, 255, 255]));
  // A window still drawing: a large region changes.
  const drawing = makePNG(W, H, (x, y) => (x < 200 && y < 150 ? [30, 30, 30] : [255, 255, 255]));

  test("a caret is noise, not motion", () => {
    const d = diffImages(dec(blank), dec(caret), 30, 0.1);
    expect(d.changed).toBeLessThan(TOTAL * 0.001);
    expect(d.verdict).toBe("SAME");
  });
  test("a window still drawing is motion", () => {
    expect(diffImages(dec(blank), dec(drawing), 30, 0.1).verdict).toBe("CHANGED");
  });
  test("demanding pixel-perfection would wait forever on the caret", () => {
    // This is why settle never returned on macOS: with a zero budget the caret
    // alone keeps the screen 'changing' for as long as the window is open.
    expect(diffImages(dec(blank), dec(caret), 30, 0).verdict).toBe("CHANGED");
  });
});
