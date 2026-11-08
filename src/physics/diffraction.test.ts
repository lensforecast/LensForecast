import { describe, expect, it } from "vitest";
import {
  airyDiskDiameter,
  airyFwhm,
  airyIntensity,
  besselJ1,
  diffractionCutoffFrequency,
  diffractionMtf,
  nyquistFrequency,
  pixelApertureMtf,
} from "./diffraction";
import { FULL_FRAME, pixelPitch, RESOLUTION_PRESETS } from "./sensor";
import { nm, toUm } from "./units";

const GREEN = nm(550);
const [res24, , , res61] = RESOLUTION_PRESETS as [
  (typeof RESOLUTION_PRESETS)[number],
  (typeof RESOLUTION_PRESETS)[number],
  (typeof RESOLUTION_PRESETS)[number],
  (typeof RESOLUTION_PRESETS)[number],
];

describe("Bessel J1", () => {
  it.each([
    [1, 0.4400505857],
    [2.5, 0.4970941025],
    [10, 0.0434727462],
    [-1, -0.4400505857],
  ])("J1(%f) ≈ %f", (x, expected) => {
    expect(besselJ1(x)).toBeCloseTo(expected, 7);
  });

  it("has its first zero at 3.8317", () => {
    expect(besselJ1(3.8317059702)).toBeCloseTo(0, 7);
  });
});

describe("Airy pattern", () => {
  it("has a 21.5 µm first-ring diameter at f/16, 550 nm", () => {
    expect(toUm(airyDiskDiameter(GREEN, 16))).toBeCloseTo(21.47, 2);
  });

  it("is dark at the first ring and half-maximum at FWHM / 2", () => {
    expect(airyIntensity(airyDiskDiameter(GREEN, 8) / 2, GREEN, 8)).toBeCloseTo(0, 6);
    expect(airyIntensity(airyFwhm(GREEN, 8) / 2, GREEN, 8)).toBeCloseTo(0.5, 4);
  });

  it("peaks at 1 on axis", () => {
    expect(airyIntensity(0, GREEN, 4)).toBe(1);
  });
});

describe("diffraction MTF", () => {
  it("is 1 at zero frequency and 0 at cutoff", () => {
    expect(diffractionMtf(0, GREEN, 8)).toBe(1);
    expect(diffractionMtf(diffractionCutoffFrequency(GREEN, 8), GREEN, 8)).toBe(0);
  });

  it("decreases monotonically", () => {
    const fc = diffractionCutoffFrequency(GREEN, 5.6);
    let previous = 1;
    for (let i = 1; i <= 20; i++) {
      const value = diffractionMtf((fc * i) / 20, GREEN, 5.6);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  it("at f/16, removes all contrast at the 61 MP Nyquist frequency", () => {
    const nyquist61 = nyquistFrequency(pixelPitch(FULL_FRAME, res61));
    expect(nyquist61).toBeGreaterThan(diffractionCutoffFrequency(GREEN, 16));
    expect(diffractionMtf(nyquist61, GREEN, 16)).toBe(0);
  });

  it("at f/16, still passes some contrast at the 24 MP Nyquist frequency", () => {
    const nyquist24 = nyquistFrequency(pixelPitch(FULL_FRAME, res24));
    expect(diffractionMtf(nyquist24, GREEN, 16)).toBeCloseTo(0.159, 2);
  });

  it("at f/4, passes substantial contrast even at 61 MP Nyquist", () => {
    const nyquist61 = nyquistFrequency(pixelPitch(FULL_FRAME, res61));
    expect(diffractionMtf(nyquist61, GREEN, 4)).toBeGreaterThan(0.6);
  });
});

describe("pixel aperture MTF", () => {
  it("equals 2/π at Nyquist for a full-fill square pixel", () => {
    const pitch = 6e-6;
    expect(pixelApertureMtf(nyquistFrequency(pitch), pitch)).toBeCloseTo(2 / Math.PI, 12);
  });
});
