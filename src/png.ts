// A PNG decoder for exactly the PNGs the capture backends produce: 8-bit,
// non-interlaced, gray/RGB with or without alpha. Pure, so image reasoning
// (is this frame blank, how much of it changed) is unit-testable without a
// screen and without an image library on the machine.
//
// Anything outside that envelope is refused by name rather than mis-decoded.

export type Image = { width: number; height: number; channels: number; data: Uint8Array };

const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isPNG(b: Uint8Array): boolean {
  return b.length >= 8 && MAGIC.every((v, i) => b[i] === v);
}

/** width/height from the IHDR alone - cheap, no inflate. */
export function readHeader(b: Uint8Array): { width: number; height: number } | null {
  if (!isPNG(b) || b.length < 24) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo the per-scanline filters in place, returning tightly packed samples. */
function unfilter(raw: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const line = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const x = raw[pos + i]!;
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev ? prev[i]! : 0;
      const c = prev && i >= channels ? prev[i - channels]! : 0;
      switch (filter) {
        case 0: line[i] = x; break;
        case 1: line[i] = (x + a) & 0xff; break;
        case 2: line[i] = (x + b) & 0xff; break;
        case 3: line[i] = (x + ((a + b) >> 1)) & 0xff; break;
        case 4: line[i] = (x + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unsupported PNG row filter ${filter}`);
      }
    }
    pos += stride;
  }
  return out;
}

export function decodePNG(b: Uint8Array, inflate: (d: Uint8Array) => Uint8Array): Image {
  if (!isPNG(b)) throw new Error("not a PNG");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];

  while (pos + 8 <= b.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(b[pos + 4]!, b[pos + 5]!, b[pos + 6]!, b[pos + 7]!);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = b[pos + 16]!;
      colorType = b[pos + 17]!;
      interlace = b[pos + 20]!;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") break;
    pos += 12 + len; // len + type + body + crc
  }

  if (!width || !height) throw new Error("PNG has no IHDR");
  if (interlace !== 0) throw new Error("interlaced PNG is not supported (no capture backend emits one)");
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth} (only 8)`);
  if (colorType === 3) throw new Error("paletted PNG is not supported (no capture backend emits one)");
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  if (!idat.length) throw new Error("PNG has no IDAT");

  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of idat) { joined.set(c, o); o += c.length; }

  const raw = inflate(joined);
  const expected = height * (1 + width * channels);
  if (raw.length < expected) throw new Error(`truncated PNG: ${raw.length} of ${expected} bytes`);

  return { width, height, channels, data: unfilter(raw, width, height, channels) };
}

/** Is every pixel identical? The exact form of "the screen is blank". */
export function isUniform(img: Image): boolean {
  const { data, channels } = img;
  if (data.length < channels) return true;
  for (let i = channels; i < data.length; i++) {
    if (data[i] !== data[i % channels]) return false;
  }
  return true;
}

export type Diff = { changed: number; total: number; percent: number; verdict: "SAME" | "CHANGED" };

/**
 * Share of pixels that differ beyond a small per-channel tolerance, so JPEG-ish
 * noise and cursor antialiasing do not read as a change. Mirrors the v1 bash
 * behaviour (threshold 30 over summed channels, SAME under 1%).
 */
export function diffImages(a: Image, b: Image, threshold = 30): Diff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const total = a.width * a.height;
  let changed = 0;
  for (let p = 0; p < total; p++) {
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const ai = a.data[p * a.channels + (c % a.channels)]!;
      const bi = b.data[p * b.channels + (c % b.channels)]!;
      sum += Math.abs(ai - bi);
    }
    if (sum > threshold) changed++;
  }
  const percent = Math.round((10000 * changed) / total) / 100;
  return { changed, total, percent, verdict: percent < 1 ? "SAME" : "CHANGED" };
}
