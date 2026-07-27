import { test, expect, describe } from "bun:test";
import { findTemplate, crop, downsample, variance, MIN_VARIANCE } from "../src/match.ts";
import type { Image } from "../src/png.ts";

/** A synthetic screen with a distinctive mark at a known place. */
function screen(w: number, h: number, mark?: { x: number; y: number; size: number }): Image {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // a gentle gradient background, so the mark is not the only structure
      data[i] = (x * 3) % 200; data[i + 1] = (y * 2) % 200; data[i + 2] = 40;
    }
  }
  if (mark) {
    for (let y = mark.y; y < mark.y + mark.size; y++) {
      for (let x = mark.x; x < mark.x + mark.size; x++) {
        const i = (y * w + x) * 3;
        // a hard-edged red square: the "button"
        data[i] = 255; data[i + 1] = 16; data[i + 2] = 16;
      }
    }
  }
  return { width: w, height: h, channels: 3, data };
}

describe("crop", () => {
  test("cuts out exactly the rectangle asked for", () => {
    const c = crop(screen(20, 20, { x: 5, y: 5, size: 4 }), 5, 5, 4, 4);
    expect([c.width, c.height]).toEqual([4, 4]);
    expect(Array.from(c.data.slice(0, 3))).toEqual([255, 16, 16]);
  });
  test("refuses a rectangle that does not fit, rather than reading past the edge", () => {
    expect(() => crop(screen(10, 10), 8, 8, 5, 5)).toThrow("does not fit");
    expect(() => crop(screen(10, 10), 0, 0, 0, 4)).toThrow();
  });
});

describe("downsample", () => {
  test("averages rather than samples, so a thin feature survives", () => {
    const img: Image = { width: 2, height: 2, channels: 3, data: new Uint8Array([
      0, 0, 0,  100, 100, 100,
      0, 0, 0,  100, 100, 100]) };
    const small = downsample(img, 2);
    expect([small.width, small.height]).toEqual([1, 1]);
    expect(Array.from(small.data)).toEqual([50, 50, 50]);
  });
});

describe("findTemplate", () => {
  test("finds a mark and reports its centre, which is where a click goes", () => {
    const hay = screen(240, 180, { x: 100, y: 60, size: 20 });
    const needle = crop(hay, 100, 60, 20, 20);
    const m = findTemplate(hay, needle)!;
    expect(m).not.toBeNull();
    expect([m.x, m.y]).toEqual([100, 60]);
    expect([m.centerX, m.centerY]).toEqual([110, 70]);
    expect(m.score).toBeGreaterThan(0.99);
  });
  test("finds it at the edges too, not only comfortably inside", () => {
    for (const [x, y] of [[0, 0], [220, 160]]) {
      const hay = screen(240, 180, { x: x!, y: y!, size: 20 });
      const m = findTemplate(hay, crop(hay, x!, y!, 20, 20))!;
      expect([m.x, m.y]).toEqual([x, y]);
    }
  });
  test("says no rather than guessing when the thing is absent", () => {
    const hay = screen(240, 180);                       // no mark at all
    const needle = crop(screen(240, 180, { x: 40, y: 40, size: 20 }), 40, 40, 20, 20);
    expect(findTemplate(hay, needle)).toBeNull();
  });
  test("tolerates small noise, because a real screen is never identical", () => {
    const hay = screen(240, 180, { x: 90, y: 50, size: 24 });
    const needle = crop(hay, 90, 50, 24, 24);
    for (let i = 0; i < needle.data.length; i += 7) {
      needle.data[i] = Math.min(255, needle.data[i]! + 4);
    }
    const m = findTemplate(hay, needle, 0.95)!;
    expect([m.x, m.y]).toEqual([90, 50]);
  });
  test("a needle bigger than the frame is an error, not a null", () => {
    expect(() => findTemplate(screen(20, 20), screen(40, 40))).toThrow("larger than the frame");
  });
  test("the coarse-to-fine path lands on the exact pixel, not near it", () => {
    // Large frame: this is the path that actually runs on a real screenshot.
    const hay = screen(1280, 1024, { x: 803, y: 611, size: 40 });
    const m = findTemplate(hay, crop(hay, 803, 611, 40, 40))!;
    expect([m.x, m.y]).toEqual([803, 611]);
  });
});

describe("templates that cannot be located", () => {
  const flat = (v: number): Image => ({
    width: 40, height: 20, channels: 3, data: new Uint8Array(40 * 20 * 3).fill(v),
  });

  test("a patch of flat colour has no structure to match on", () => {
    expect(variance(flat(255))).toBe(0);
    expect(variance(flat(0))).toBe(0);
  });
  test("a patch with an edge in it does", () => {
    // Straddling the mark's boundary is what makes a patch locatable at all.
    const hay = screen(200, 120, { x: 40, y: 30, size: 30 });
    expect(variance(crop(hay, 25, 15, 40, 40))).toBeGreaterThan(MIN_VARIANCE);
  });
  test("the inside of a solid block is as unlocatable as blank paper", () => {
    const hay = screen(200, 120, { x: 40, y: 30, size: 30 });
    expect(variance(crop(hay, 42, 32, 20, 20))).toBeLessThan(MIN_VARIANCE);
  });
  test("the threshold separates the blank text box from a line of text", () => {
    // The white text box that was located 65px from where it was cut.
    const nearlyFlat = flat(255);
    nearlyFlat.data[0] = 250;
    expect(variance(nearlyFlat)).toBeLessThan(MIN_VARIANCE);
  });
});
