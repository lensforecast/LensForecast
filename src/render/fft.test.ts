import { describe, expect, it } from "vitest";
import { fft1d, fft2d, nextFftSize, nextPow2, spatialFrequency } from "./fft";
import { diskOtf, lineOtf, sincPi } from "./otf";
import { mulberry32 } from "../physics/random";

function naiveDft(re: number[], im: number[]): [number[], number[]] {
  const n = re.length;
  const outRe: number[] = [];
  const outIm: number[] = [];
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      sr += re[t]! * Math.cos(angle) - im[t]! * Math.sin(angle);
      si += re[t]! * Math.sin(angle) + im[t]! * Math.cos(angle);
    }
    outRe.push(sr);
    outIm.push(si);
  }
  return [outRe, outIm];
}

describe("FFT", () => {
  it.each([16, 3, 12, 48])("matches a naive DFT and inverts exactly (n = %i)", (n) => {
    const rng = mulberry32(3);
    const re = Array.from({ length: n }, rng);
    const im = Array.from({ length: n }, rng);
    const [expectedRe, expectedIm] = naiveDft(re, im);
    const fr = Float64Array.from(re);
    const fi = Float64Array.from(im);
    fft1d(fr, fi);
    for (let k = 0; k < n; k++) {
      expect(fr[k]).toBeCloseTo(expectedRe[k]!, 10);
      expect(fi[k]).toBeCloseTo(expectedIm[k]!, 10);
    }
    fft1d(fr, fi, true);
    for (let k = 0; k < n; k++) {
      expect(fr[k]).toBeCloseTo(re[k]!, 12);
      expect(fi[k]).toBeCloseTo(im[k]!, 12);
    }
  });

  it("restricts the row pass when asked, without changing the needed rows", () => {
    const rng = mulberry32(8);
    const w = 16;
    const h = 12;
    const full = new Float64Array(w * h);
    for (let i = 4 * w; i < 7 * w; i++) full[i] = rng();
    const reA = full.slice();
    const imA = new Float64Array(w * h);
    const reB = full.slice();
    const imB = new Float64Array(w * h);
    fft2d(reA, imA, w, h);
    fft2d(reB, imB, w, h, false, { first: 4, last: 6 });
    for (let i = 0; i < w * h; i++) expect(reB[i]).toBeCloseTo(reA[i]!, 12);
    fft2d(reA, imA, w, h, true);
    fft2d(reB, imB, w, h, true, { first: 2, last: 9 });
    for (let i = 2 * w; i < 10 * w; i++) expect(reB[i]).toBeCloseTo(reA[i]!, 12);
  });

  it("round-trips in 2D", () => {
    const rng = mulberry32(5);
    const w = 32;
    const h = 8;
    const original = Float64Array.from({ length: w * h }, rng);
    const re = original.slice();
    const im = new Float64Array(w * h);
    fft2d(re, im, w, h);
    fft2d(re, im, w, h, true);
    for (let i = 0; i < w * h; i++) {
      expect(re[i]).toBeCloseTo(original[i]!, 12);
      expect(im[i]).toBeCloseTo(0, 12);
    }
  });

  it("rejects unsupported sizes", () => {
    expect(() => fft1d(new Float64Array(10), new Float64Array(10))).toThrow(RangeError);
  });

  it("computes transform sizes and signed frequencies", () => {
    expect(nextPow2(1000)).toBe(1024);
    expect(nextPow2(1024)).toBe(1024);
    expect(nextFftSize(1330)).toBe(1536);
    expect(nextFftSize(700)).toBe(768);
    expect(nextFftSize(1000)).toBe(1024);
    expect(spatialFrequency(1, 8, 0.5)).toBe(0.25);
    expect(spatialFrequency(7, 8, 0.5)).toBe(-0.25);
  });
});

describe("analytic OTFs", () => {
  it("are 1 at zero frequency", () => {
    expect(diskOtf(1e-3, 0)).toBe(1);
    expect(lineOtf(1e-4, 0, 0, 0)).toBe(1);
    expect(sincPi(0)).toBe(1);
  });

  it("puts the first disk-OTF zero at 1.2197 / diameter", () => {
    const d = 2e-4;
    expect(diskOtf(d, 1.2196698912665045 / d)).toBeCloseTo(0, 7);
  });

  it("zeroes motion blur at one cycle per streak length", () => {
    expect(lineOtf(1e-4, 0, 1e4, 0)).toBeCloseTo(0, 12);
  });
});
