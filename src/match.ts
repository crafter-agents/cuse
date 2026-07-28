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
 * Running sums of grey level and of its square, so any rectangle's mean and
 * standard deviation cost the same regardless of size. Without this, scoring
 * every position by correlation would re-sum the same pixels for every
 * candidate and the search would be too slow to use.
 */
type Sums = { w: number; h: number; s: Float64Array; sq: Float64Array };

function integral(img: Image): Sums {
  const { width: w, height: h, channels: ch, data } = img;
  const s = new Float64Array((w + 1) * (h + 1));
  const sq = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowS = 0, rowSq = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      rowS += v; rowSq += v * v;
      const k = (y + 1) * (w + 1) + (x + 1);
      s[k] = s[k - (w + 1)]! + rowS;
      sq[k] = sq[k - (w + 1)]! + rowSq;
    }
  }
  return { w, h, s, sq };
}

function rectStats(I: Sums, ox: number, oy: number, w: number, h: number) {
  const W = I.w + 1;
  const at = (a: Float64Array, x: number, y: number) => a[y * W + x]!;
  const n = w * h;
  const sum = at(I.s, ox + w, oy + h) - at(I.s, ox, oy + h) - at(I.s, ox + w, oy) + at(I.s, ox, oy);
  const sumSq = at(I.sq, ox + w, oy + h) - at(I.sq, ox, oy + h) - at(I.sq, ox + w, oy) + at(I.sq, ox, oy);
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

/**
 * The `keep` best positions in a region, scored by correlation.
 *
 * Scoring the search itself - not only its winner - is what makes a washed-out
 * or dimmed template findable: a mean pixel distance ranks the right position
 * below unrelated ones as soon as the exposure differs, and then no amount of
 * careful scoring at the end can recover it, because the right position was
 * never a candidate.
 */
function searchTop(hay: Image, needle: Image, keep: number,
                   x0: number, y0: number, x1: number, y1: number,
                   sums?: Sums, needleStats?: { mean: number; sd: number }):
                   Array<{ x: number; y: number; score: number }> {
  const I = sums ?? integral(hay);
  const ns = needleStats ?? stats(needle);
  const found: Array<{ x: number; y: number; score: number }> = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const score = correlationWith(hay, needle, x, y, I, ns);
      found.push({ x, y, score });
      if (found.length > keep * 8) {
        found.sort((a, b) => b.score - a.score);
        found.length = keep;
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found.slice(0, keep);
}

/** Mean and standard deviation of a patch's grey levels, computed once. */
function stats(img: Image, ox = 0, oy = 0, w = img.width, h = img.height, stride = img.width) {
  const ch = img.channels;
  let sum = 0, sumSq = 0;
  const n = w * h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((oy + y) * stride + (ox + x)) * ch;
      const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
      sum += v; sumSq += v * v;
    }
  }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

/**
 * Zero-mean normalised cross-correlation, in -1..1.
 *
 * The old score was a mean pixel distance, which conflates "these do not match"
 * with "these match but one is darker". A template captured at one brightness
 * and searched for at another - a different theme, a window that lost focus, a
 * display that dimmed - scored badly while being the right answer. Correlation
 * asks whether the two vary together, which is the question actually being
 * asked, and it is what makes the number comparable between screenshots.
 */
export function correlation(hay: Image, needle: Image, ox: number, oy: number,
                            needleStats?: { mean: number; sd: number }): number {
  return correlationWith(hay, needle, ox, oy, integral(hay), needleStats ?? stats(needle));
}

function correlationWith(hay: Image, needle: Image, ox: number, oy: number,
                         I: Sums, ns: { mean: number; sd: number }): number {
  const { width: w, height: h } = needle;
  const hs = rectStats(I, ox, oy, w, h);
  // A flat patch has no variation to correlate; refusing to score it is the
  // honest answer, and `find` rejects such templates before getting here.
  if (ns.sd < 1e-6 || hs.sd < 1e-6) return ns.sd < 1e-6 && hs.sd < 1e-6 ? 1 : 0;

  const hc = hay.channels, nc = needle.channels;
  let cov = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const hi = ((oy + y) * hay.width + (ox + x)) * hc;
      const ni = (y * w + x) * nc;
      const hv = (hay.data[hi]! + hay.data[hi + 1]! + hay.data[hi + 2]!) / 3;
      const nv = (needle.data[ni]! + needle.data[ni + 1]! + needle.data[ni + 2]!) / 3;
      cov += (hv - hs.mean) * (nv - ns.mean);
    }
  }
  return cov / (w * h) / (hs.sd * ns.sd);
}

function asMatch(hit: { x: number; y: number; score: number }, needle: Image): Match {
  return {
    x: hit.x, y: hit.y,
    score: Math.max(0, Math.min(1, hit.score)),
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
  const needleStats = stats(needle);

  // Nothing to correlate means nothing to find. A patch of flat colour matches
  // every other flat patch exactly, so the least-bad answer is arbitrary, and
  // handing an agent an arbitrary coordinate is the failure this tool is about.
  if (needleStats.sd < 1e-6) return null;

  const sums = integral(hay);

  // Levels, not one big jump. Shrinking straight to an eighth was wrong in a way
  // that took a real frame to see: a patch at x=386 does not sit on the 8-pixel
  // grid, so its averaged blocks differ from the ones the search compares
  // against, and the true position scored worse than unrelated ones. Halving
  // repeatedly keeps every step's misalignment to a pixel or two.
  // A level is only useful if what is left of the needle can still tell places
  // apart. Measured on a real frame: shrunk by 8, a 160x50 patch becomes 20x6
  // and the correct position ranks 350th; by 4 it ranks 2nd, by 2 it ranks 1st.
  // So a level needs both a usable smallest side and enough pixels overall.
  const levels: number[] = [];
  for (let f = 8; f >= 2; f = Math.floor(f / 2)) {
    const w = Math.floor(needle.width / f), h = Math.floor(needle.height / f);
    if (Math.min(w, h) >= 8 && w * h >= 100) levels.push(f);
  }

  if (levels.length === 0) {
    const hit = searchTop(hay, needle, 1, 0, 0, maxX, maxY, sums, needleStats)[0];
    if (!hit) return null;
    const m = asMatch(hit, needle);
    return m.score >= minScore ? m : null;
  }

  let candidates: Array<{ x: number; y: number; score: number }> | null = null;

  for (const f of levels) {
    const sh = downsample(hay, f), sn = downsample(needle, f);
    const si = integral(sh), sns = stats(sn);
    if (!candidates) {
      candidates = searchTop(sh, sn, 6, 0, 0, sh.width - sn.width, sh.height - sn.height, si, sns)
        .map((c) => ({ ...c, x: c.x * f, y: c.y * f }));
      continue;
    }
    // Refine each candidate at this finer level, in its own neighbourhood.
    const pad = f * 3;
    const next: Array<{ x: number; y: number; score: number }> = [];
    for (const c of candidates) {
      const hits = searchTop(sh, sn, 2,
        Math.max(0, Math.floor((c.x - pad) / f)), Math.max(0, Math.floor((c.y - pad) / f)),
        Math.min(sh.width - sn.width, Math.ceil((c.x + pad) / f)),
        Math.min(sh.height - sn.height, Math.ceil((c.y + pad) / f)), si, sns);
      for (const h of hits) next.push({ ...h, x: h.x * f, y: h.y * f });
    }
    if (next.length) {
      next.sort((a, b) => b.score - a.score);
      candidates = next.slice(0, 6);
    }
  }

  // Full resolution, around whatever survived.
  let best: Match | null = null;
  for (const c of candidates ?? []) {
    const hit = searchTop(hay, needle, 1,
      Math.max(0, c.x - 6), Math.max(0, c.y - 6),
      Math.min(maxX, c.x + 6), Math.min(maxY, c.y + 6), sums, needleStats)[0];
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
