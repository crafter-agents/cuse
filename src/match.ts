// Finding a thing on the screen.
//
// cuse can click a coordinate, but an agent does not have coordinates - it has
// a screenshot and an intention. This turns the first into the second: give it
// a picture of the button and it says where the button is.
//
// The naive search is width x height x needle-area, which on a 3024x1964 frame
// is billions of comparisons. So it runs coarse-to-fine: shrink both images,
// find the region there, then refine at full resolution inside a small window
// around that guess. Pure, so it is testable without a screen.

import type { Image } from "./png.ts";

export type Match = { x: number; y: number; score: number; centerX: number; centerY: number };

/** Average-pool by an integer factor. Averaging, not sampling, so a one-pixel
 *  feature does not vanish between levels. */
export function downsample(img: Image, factor: number): Image {
  if (factor <= 1) return img;
  const w = Math.max(1, Math.floor(img.width / factor));
  const h = Math.max(1, Math.floor(img.height / factor));
  const ch = img.channels;
  const out = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0, n = 0;
        for (let dy = 0; dy < factor; dy++) {
          const sy = y * factor + dy;
          if (sy >= img.height) break;
          for (let dx = 0; dx < factor; dx++) {
            const sx = x * factor + dx;
            if (sx >= img.width) break;
            sum += img.data[(sy * img.width + sx) * ch + c]!;
            n++;
          }
        }
        out[(y * w + x) * ch + c] = n ? Math.round(sum / n) : 0;
      }
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

/**
 * Mean absolute difference between the needle and the haystack at (ox, oy),
 * over the first three channels. Returns early once it cannot beat `cutoff`,
 * which is what makes the full-resolution pass affordable.
 */
function meanDiff(hay: Image, needle: Image, ox: number, oy: number, cutoff: number, step = 1): number {
  let total = 0, count = 0;
  const limit = cutoff * 3; // the running sum is over three channels per pixel
  for (let y = 0; y < needle.height; y += step) {
    for (let x = 0; x < needle.width; x += step) {
      const hi = ((oy + y) * hay.width + (ox + x)) * hay.channels;
      const ni = (y * needle.width + x) * needle.channels;
      total += Math.abs(hay.data[hi]! - needle.data[ni]!)
             + Math.abs(hay.data[hi + 1]! - needle.data[ni + 1]!)
             + Math.abs(hay.data[hi + 2]! - needle.data[ni + 2]!);
      count++;
      if (count > 64 && total / count > limit) return Infinity; // hopeless, stop
    }
  }
  return count ? total / count / 3 : Infinity;
}

/** The `keep` best positions in a region, worst-case exhaustive. */
function searchTop(hay: Image, needle: Image, keep: number,
                   x0: number, y0: number, x1: number, y1: number): Array<{ x: number; y: number; diff: number }> {
  const found: Array<{ x: number; y: number; diff: number }> = [];
  let worstKept = Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = meanDiff(hay, needle, x, y, worstKept);
      if (d === Infinity) continue;
      found.push({ x, y, diff: d });
      if (found.length > keep * 8) {
        found.sort((a, b) => a.diff - b.diff);
        found.length = keep;
        worstKept = found[found.length - 1]!.diff;
      }
    }
  }
  found.sort((a, b) => a.diff - b.diff);
  return found.slice(0, keep);
}

function asMatch(hit: { x: number; y: number; diff: number }, needle: Image): Match {
  return {
    x: hit.x, y: hit.y,
    score: Math.max(0, 1 - hit.diff / 255),
    centerX: hit.x + Math.floor(needle.width / 2),
    centerY: hit.y + Math.floor(needle.height / 2),
  };
}

/**
 * Where does `needle` sit inside `hay`?
 *
 * `minScore` is a similarity in 0..1, where 1 is pixel-identical. Below it the
 * answer is null rather than the least-bad guess: an agent clicking the
 * least-bad guess is worse than an agent told the button is not on screen.
 */
export function findTemplate(hay: Image, needle: Image, minScore = 0.9): Match | null {
  if (needle.width > hay.width || needle.height > hay.height) {
    throw new Error(`needle ${needle.width}x${needle.height} is larger than the frame ${hay.width}x${hay.height}`);
  }
  const maxX = hay.width - needle.width, maxY = hay.height - needle.height;
  // Shrink until the coarse search is cheap, but never past a usable needle.
  const factor = Math.max(1, Math.min(8, Math.floor(Math.min(needle.width, needle.height) / 4)));

  if (factor === 1) {
    const hit = searchTop(hay, needle, 1, 0, 0, maxX, maxY)[0];
    if (!hit) return null;
    const m = asMatch(hit, needle);
    return m.score >= minScore ? m : null;
  }

  const smallHay = downsample(hay, factor);
  const smallNeedle = downsample(needle, factor);
  // Several candidates, not one. Shrinking by 8 blurs a line of text into a
  // grey smear, and the best coarse position can be further from the truth
  // than a small refine window reaches - which is how a patch cut from a frame
  // failed to be found in that very frame.
  const coarse = searchTop(smallHay, smallNeedle, 5,
    0, 0, smallHay.width - smallNeedle.width, smallHay.height - smallNeedle.height);
  if (!coarse.length) return null;

  const pad = factor * 3;
  let best: Match | null = null;
  for (const c of coarse) {
    const cx = c.x * factor, cy = c.y * factor;
    const hit = searchTop(hay, needle, 1,
      Math.max(0, cx - pad), Math.max(0, cy - pad),
      Math.min(maxX, cx + pad), Math.min(maxY, cy + pad))[0];
    if (!hit) continue;
    const m = asMatch(hit, needle);
    if (!best || m.score > best.score) best = m;
    if (best.score >= 0.999) break; // an exact hit; nothing can beat it
  }
  return best && best.score >= minScore ? best : null;
}

/**
 * How much structure a patch has, as the mean absolute deviation of its pixels.
 *
 * A template with none - a blank stretch of text box, an empty panel - matches
 * a hundred equally blank places, and the winner among them is decided by
 * rounding. Observed: a patch of a white text box was located 65px from where
 * it was cut, with a perfect score. So cuse measures this and refuses, rather
 * than handing an agent a confident coordinate that is simply wrong.
 */
export function variance(img: Image): number {
  const { data, channels } = img;
  const pixels = Math.floor(data.length / channels);
  if (pixels === 0) return 0;
  let mean = 0;
  for (let p = 0; p < pixels; p++) {
    mean += (data[p * channels]! + data[p * channels + 1]! + data[p * channels + 2]!) / 3;
  }
  mean /= pixels;
  let dev = 0;
  for (let p = 0; p < pixels; p++) {
    const v = (data[p * channels]! + data[p * channels + 1]! + data[p * channels + 2]!) / 3;
    dev += Math.abs(v - mean);
  }
  return dev / pixels;
}

/** Below this a template is too plain to locate: the value is in grey levels,
 *  and a patch of flat colour scores 0 while a line of text scores tens. */
export const MIN_VARIANCE = 3;

/** Cut a rectangle out of an image - how a needle gets made from a screenshot. */
export function crop(img: Image, x: number, y: number, w: number, h: number): Image {
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height || w <= 0 || h <= 0) {
    throw new Error(`crop ${w}x${h} at ${x},${y} does not fit in ${img.width}x${img.height}`);
  }
  const ch = img.channels;
  const out = new Uint8Array(w * h * ch);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * ch;
    out.set(img.data.subarray(from, from + w * ch), row * w * ch);
  }
  return { width: w, height: h, channels: ch, data: out };
}
