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

  // Levels, not one big jump. Shrinking straight to 1/8 was wrong in a way that
  // took a real frame to see: a patch at x=386 does not sit on the 8-pixel grid,
  // so its averaged blocks differ from the ones the search compares against, and
  // the true position scored worse than unrelated ones. Halving repeatedly keeps
  // every step's misalignment to a pixel or two, which the next refine absorbs.
  const levels: number[] = [];
  for (let f = 8; f >= 2; f = Math.floor(f / 2)) {
    if (Math.min(needle.width, needle.height) / f >= 8) levels.push(f);
  }

  let candidates: Array<{ x: number; y: number; diff: number }> | null = null;

  for (const f of levels) {
    const sh = downsample(hay, f), sn = downsample(needle, f);
    if (!candidates) {
      candidates = searchTop(sh, sn, 6, 0, 0, sh.width - sn.width, sh.height - sn.height)
        .map((c) => ({ ...c, x: c.x * f, y: c.y * f }));
      continue;
    }
    // Refine each candidate at this finer level, in its own neighbourhood.
    const pad = f * 3;
    const next: Array<{ x: number; y: number; diff: number }> = [];
    for (const c of candidates) {
      const hits = searchTop(sh, sn, 2,
        Math.max(0, Math.floor((c.x - pad) / f)), Math.max(0, Math.floor((c.y - pad) / f)),
        Math.min(sh.width - sn.width, Math.ceil((c.x + pad) / f)),
        Math.min(sh.height - sn.height, Math.ceil((c.y + pad) / f)));
      for (const h of hits) next.push({ ...h, x: h.x * f, y: h.y * f });
    }
    if (next.length) {
      next.sort((a, b) => a.diff - b.diff);
      candidates = next.slice(0, 6);
    }
  }

  // Full resolution, around whatever survived - or everywhere, for a needle too
  // small to have had a pyramid at all.
  let best: Match | null = null;
  const windows = candidates?.length
    ? candidates.map((c) => [
        Math.max(0, c.x - 6), Math.max(0, c.y - 6),
        Math.min(maxX, c.x + 6), Math.min(maxY, c.y + 6)] as const)
    : [[0, 0, maxX, maxY] as const];

  for (const [x0, y0, x1, y1] of windows) {
    const hit = searchTop(hay, needle, 1, x0, y0, x1, y1)[0];
    if (!hit) continue;
    const m = asMatch(hit, needle);
    if (!best || m.score > best.score) best = m;
    if (best.score >= 0.999) break;
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
