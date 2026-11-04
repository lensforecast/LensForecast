import { describe, expect, it } from "vitest";
import { focalPlaneExposure, middleGreyExposure } from "./exposure";
import {
  baseIso,
  croppedResolution,
  FULL_FRAME,
  fullWellCapacity,
  GENERIC_SENSOR,
  megapixels,
  outputLevel,
  pixelPitch,
  pixelSnr,
  RESOLUTION_PRESETS,
  snrAtOutputScale,
  type SensorModel,
} from "./sensor";
import { toUm } from "./units";

const [res24, res33, res61] = RESOLUTION_PRESETS as [
  (typeof RESOLUTION_PRESETS)[number],
  (typeof RESOLUTION_PRESETS)[number],
  (typeof RESOLUTION_PRESETS)[number],
];
const pitch24 = pixelPitch(FULL_FRAME, res24);
const pitch61 = pixelPitch(FULL_FRAME, res61);
const SHOT_NOISE_ONLY: SensorModel = { ...GENERIC_SENSOR, readNoise: 0 };

describe("geometry", () => {
  it("derives pixel pitch from format width", () => {
    expect(toUm(pitch24)).toBeCloseTo(6.0, 6);
    expect(toUm(pixelPitch(FULL_FRAME, res33))).toBeCloseTo(5.137, 3);
    expect(toUm(pitch61)).toBeCloseTo(3.764, 3);
  });

  it("reports megapixels", () => {
    expect(megapixels(res24)).toBeCloseTo(24, 6);
    expect(megapixels(res61)).toBeCloseTo(61, 0);
  });

  it("crops 61 MP by 1.5× to about 27 MP", () => {
    expect(megapixels(croppedResolution(res61, 1.5))).toBeCloseTo(27.1, 1);
  });
});

describe("generic sensor", () => {
  it("has a base ISO near 100 and ~61k e⁻ full well at 6 µm", () => {
    expect(baseIso()).toBeGreaterThan(80);
    expect(baseIso()).toBeLessThan(125);
    expect(fullWellCapacity(pitch24)).toBeCloseTo(61_200, -2);
  });
});

describe("ISO is a gain, not a light source", () => {
  it("renders middle grey at the same output level for any ISO", () => {
    for (const iso of [200, 800, 6400]) {
      expect(outputLevel(middleGreyExposure(iso), iso, pitch24)).toBeCloseTo(10 / 78, 9);
    }
  });

  it("doubles brightness when ISO doubles at the same exposure", () => {
    const h = 0.01;
    expect(outputLevel(h, 1600, pitch24)).toBeCloseTo(2 * outputLevel(h, 800, pitch24), 12);
  });

  it("halves shot-noise SNR when compensating f/4 → f/8 with +2 stops of ISO", () => {
    const h4 = focalPlaneExposure(500, 4, 1 / 1000);
    const h8 = focalPlaneExposure(500, 8, 1 / 1000);
    expect(outputLevel(h8, 1600, pitch24)).toBeCloseTo(outputLevel(h4, 400, pitch24), 12);
    expect(pixelSnr(h4, pitch24, SHOT_NOISE_ONLY) / pixelSnr(h8, pitch24, SHOT_NOISE_ONLY)).toBeCloseTo(2, 9);
  });
});

describe("resolution and noise", () => {
  const h = 0.005;

  it("gives smaller pixels lower per-pixel SNR (100% crop view)", () => {
    expect(pixelSnr(h, pitch61)).toBeLessThan(pixelSnr(h, pitch24));
  });

  it("gives identical shot-noise SNR at equal output size", () => {
    const a = snrAtOutputScale(h, pitch24, pitch24, SHOT_NOISE_ONLY);
    const b = snrAtOutputScale(h, pitch61, pitch24, SHOT_NOISE_ONLY);
    expect(b).toBeCloseTo(a, 9);
  });

  it("keeps the read-noise penalty of more pixels small in good light", () => {
    const a = snrAtOutputScale(h, pitch24, pitch24);
    const b = snrAtOutputScale(h, pitch61, pitch24);
    expect(b / a).toBeGreaterThan(0.98);
    expect(b / a).toBeLessThan(1);
  });
});
