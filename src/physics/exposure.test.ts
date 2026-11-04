import { describe, expect, it } from "vitest";
import {
  exposureValue,
  focalPlaneExposure,
  incidentMeteredShutterTime,
  lambertianLuminance,
  meteredShutterTime,
  middleGreyExposure,
  stopsBetween,
} from "./exposure";

describe("camera equation", () => {
  it("loses two stops going from f/4 to f/8", () => {
    const h4 = focalPlaneExposure(1000, 4, 1 / 500);
    const h8 = focalPlaneExposure(1000, 8, 1 / 500);
    expect(stopsBetween(h4, h8)).toBeCloseTo(-2, 12);
  });

  it("recovers the loss with a 4× longer shutter", () => {
    const h4 = focalPlaneExposure(1000, 4, 1 / 500);
    const h8 = focalPlaneExposure(1000, 8, 4 / 500);
    expect(h8).toBeCloseTo(h4, 12);
  });

  it("applies the (1 + m)² bellows factor at close focus", () => {
    const far = focalPlaneExposure(1000, 8, 1 / 100);
    const lifeSize = focalPlaneExposure(1000, 8, 1 / 100, { magnification: 1 });
    expect(stopsBetween(far, lifeSize)).toBeCloseTo(-2, 12);
  });
});

describe("metering consistency", () => {
  it("reproduces the sunny 16 rule within one stop at 100,000 lux", () => {
    const t = incidentMeteredShutterTime(100_000, 16, 100);
    expect(Math.abs(stopsBetween(1 / 100, t))).toBeLessThan(1);
  });

  it("places a metered surface within half a stop of ISO 12232 middle grey", () => {
    const luminance = 2000;
    const iso = 400;
    const t = meteredShutterTime(luminance, 8, iso);
    const h = focalPlaneExposure(luminance, 8, t);
    expect(Math.abs(stopsBetween(middleGreyExposure(iso), h))).toBeLessThan(0.5);
  });
});

describe("photometry helpers", () => {
  it("computes Lambertian luminance of an 18% card in sunlight", () => {
    expect(lambertianLuminance(100_000, 0.18)).toBeCloseTo(5729.58, 1);
  });

  it("computes exposure values", () => {
    expect(exposureValue(1, 1)).toBe(0);
    expect(exposureValue(16, 1 / 125)).toBeCloseTo(14.97, 2);
  });
});
