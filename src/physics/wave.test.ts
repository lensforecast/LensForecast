import { describe, expect, it } from "vitest";
import { bandDiffractionMtf, COLOR_BANDS, defocusedOtf, diffractionCutoffFrequency, diffractionMtf, nyquistFrequency } from "./diffraction";
import { besselJ1 } from "./diffraction";
import { FULL_FRAME, pixelPitch, RESOLUTION_PRESETS } from "./sensor";
import { nm } from "./units";

const LAMBDA = nm(550);
const N = 5.6;

/**
 * Independent brute-force OTF: autocorrelation of the defocused unit pupil
 * P(x, y) = exp(i k W₀₂₀ (x² + y²)) evaluated on a 2D grid.
 */
function bruteForceOtf(s: number, w020Waves: number, samples = 600): number {
  const k = 2 * Math.PI * w020Waves;
  let re = 0;
  let count = 0;
  const step = 2 / samples;
  for (let i = 0; i < samples; i++) {
    const x = -1 + (i + 0.5) * step;
    for (let j = 0; j < samples; j++) {
      const y = -1 + (j + 0.5) * step;
      if (x * x + y * y <= 1) count++;
      const inA = (x + s) ** 2 + y * y <= 1;
      const inB = (x - s) ** 2 + y * y <= 1;
      if (inA && inB) {
        const phase = k * ((x + s) ** 2 - (x - s) ** 2);
        re += Math.cos(phase);
      }
    }
  }
  return re / count;
}

describe("defocused-pupil OTF (Hopkins)", () => {
  it("reduces to the diffraction MTF without defocus", () => {
    for (const s of [0.1, 0.4, 0.8]) {
      const f = s / (LAMBDA * N);
      expect(defocusedOtf(f, 0, LAMBDA, N)).toBeCloseTo(diffractionMtf(f, LAMBDA, N), 12);
    }
  });

  it("matches the analytic diffraction MTF through its own quadrature at tiny defocus", () => {
    const f = 0.3 / (LAMBDA * N);
    expect(defocusedOtf(f, 1e-12, LAMBDA, N)).toBeCloseTo(diffractionMtf(f, LAMBDA, N), 7);
  });

  it.each([
    [0.25, 0.3],
    [0.5, 0.2],
    [0.5, 0.3],
    [1, 0.1],
    [2, 0.15],
  ])("matches a brute-force pupil autocorrelation at W₀₂₀ = %f λ, s = %f", (w020, s) => {
    const blur = 8 * N * w020 * LAMBDA;
    const f = s / (LAMBDA * N);
    expect(defocusedOtf(f, blur, LAMBDA, N)).toBeCloseTo(bruteForceOtf(s, w020), 2);
  });

  it("approaches disk OTF × diffraction MTF at large defocus", () => {
    const blur = 80 * LAMBDA * N;
    for (const s of [0.002, 0.01, 0.03]) {
      const f = s / (LAMBDA * N);
      const x = Math.PI * blur * f;
      const product = ((2 * besselJ1(x)) / x) * diffractionMtf(f, LAMBDA, N);
      expect(Math.abs(defocusedOtf(f, blur, LAMBDA, N) - product)).toBeLessThan(0.02);
    }
  });

  it("differs strongly from the product near the depth-of-field limit (c = 4λN)", () => {
    const blur = 4 * LAMBDA * N;
    const f = 0.3 / (LAMBDA * N);
    const x = Math.PI * blur * f;
    const product = ((2 * besselJ1(x)) / x) * diffractionMtf(f, LAMBDA, N);
    expect(defocusedOtf(f, blur, LAMBDA, N) - product).toBeGreaterThan(0.15);
  });
});

describe("colour bands", () => {
  it("at f/16 the green band still carries no contrast at the 61 MP Nyquist frequency", () => {
    const nyquist61 = nyquistFrequency(pixelPitch(FULL_FRAME, RESOLUTION_PRESETS[2]!));
    expect(diffractionCutoffFrequency(COLOR_BANDS.green[0], 16)).toBeLessThan(nyquist61);
    expect(bandDiffractionMtf(nyquist61, COLOR_BANDS.green, 16)).toBe(0);
  });

  it("at f/16 the blue band passes a little contrast at the 61 MP Nyquist frequency", () => {
    const nyquist61 = nyquistFrequency(pixelPitch(FULL_FRAME, RESOLUTION_PRESETS[2]!));
    const blue = bandDiffractionMtf(nyquist61, COLOR_BANDS.blue, 16);
    expect(blue).toBeGreaterThan(0);
    expect(blue).toBeLessThan(0.02);
  });
});
