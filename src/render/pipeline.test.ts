import { describe, expect, it } from "vitest";
import { bandDiffractionMtf, COLOR_BANDS } from "../physics/diffraction";
import { lambertianLuminance, sensorExposure, stopsBetween } from "../physics/exposure";
import { blurCircleDiameter, imageDistance, workingFNumber } from "../physics/optics";
import { electronsAtWhite, GENERIC_SENSOR, meanElectrons, outputLevel } from "../physics/sensor";
import { mm, um } from "../physics/units";
import { readOut, renderOpticalImage } from "./pipeline";
import { createWildlifeStudio, DEFAULT_STUDIO } from "./studio";
import { aliasedEdgeMtf, baseShot, mtfFromLsf, planeScene, resolutionForPitch, row, sinc, sinusoidAmplitude } from "./testScenes";
import { prefilteredSine, tentStep } from "./textures";
import type { ShotSettings } from "./types";

/** Prefiltered step at x = edge, as every scene outline is sampled. */
const aaStep = (x: number, fp: number, edge = 0): number => tentStep((x - edge) / fp);

describe("exposure through the pipeline", () => {
  const scene = planeScene(20, () => 0.18);
  const view = { centerX: 0, centerY: 0, width: um(25) * 16, height: um(25) * 16, outputPixelSize: 0 };

  it("preserves a uniform radiance factor through all OTFs, apart from cos⁴ falloff", () => {
    const image = renderOpticalImage(scene, baseShot, view);
    const vF = imageDistance(baseShot.focalLength, 20);
    image.g.forEach((v, i) => {
      const x = ((i % image.width) - image.width / 2 + 0.5) * image.outputPixelSize;
      const y = (image.height / 2 - Math.floor(i / image.width) - 0.5) * image.outputPixelSize;
      expect(v / ((vF * vF) / (vF * vF + x * x + y * y)) ** 2).toBeCloseTo(0.18, 9);
    });
  });

  it("matches the closed-form sensor model for a uniform 18% surface", () => {
    const image = renderOpticalImage(scene, baseShot, view);
    const levels = readOut(image, baseShot, { noise: false });
    const exposure = sensorExposure(lambertianLuminance(5000, 0.18), mm(200), 4, 20, 1 / 500);
    expect(levels[0]).toBeCloseTo(outputLevel(exposure, 400, image.sensorPitch), 5);
  });

  it("halves the signal for each stop of aperture", () => {
    const at4 = readOut(renderOpticalImage(scene, baseShot, view), baseShot, { noise: false });
    const shot56 = { ...baseShot, fNumber: 4 * Math.SQRT2 };
    const at56 = readOut(renderOpticalImage(scene, shot56, view), shot56, { noise: false });
    expect(stopsBetween(at4[0]!, at56[0]!)).toBeCloseTo(-1, 6);
  });
});

/** Fraction of a uniform disk of radius R lying left of a vertical line at x. */
function diskEsf(x: number, radius: number): number {
  if (x <= -radius) return 0;
  if (x >= radius) return 1;
  const segment = radius * radius * Math.acos(x / radius) - x * Math.sqrt(radius * radius - x * x);
  return 1 - segment / (Math.PI * radius * radius);
}

describe("geometric defocus", () => {
  it("reproduces the analytic edge spread of a uniform blur disk within 1%", () => {
    const pitch = um(12);
    const scene = planeScene(40, (x, _y, fp) => 0.1 + 0.4 * aaStep(x, fp));
    const shot = { ...baseShot, focusDistance: 20, resolution: resolutionForPitch(pitch) };
    const c = blurCircleDiameter({ focalLength: shot.focalLength, fNumber: shot.fNumber }, 20, 40);
    expect(c / pitch).toBeGreaterThan(15);

    const nx = 64;
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: nx * pitch,
      height: 8 * pitch,
      outputPixelSize: pitch,
      oversample: 4,
    });
    const values = row(image.g, nx, 4);
    let maxError = 0;
    for (let j = 0; j < nx; j++) {
      const x = (j - nx / 2 + 0.5) * pitch;
      let ref = 0;
      for (let s = 0; s < 64; s++) ref += diskEsf(x + ((s + 0.5) / 64 - 0.5) * pitch, c / 2);
      maxError = Math.max(maxError, Math.abs(values[j]! - (0.1 + (0.4 * ref) / 64)) / 0.4);
    }
    expect(maxError).toBeLessThan(0.01);
  });

  it("places a defocused plane at the chief-ray position X·v_f/s, not X·f/(s − f)", () => {
    const pitch = um(20);
    const edgeX = 1;
    const shot = { ...baseShot, focusDistance: 5, resolution: resolutionForPitch(pitch) };
    const scene = planeScene(100, (x, _y, fp) => aaStep(x, fp, edgeX));
    scene.aim = { x: 0, y: 0, distance: 100 };
    const expectedX = (edgeX * imageDistance(shot.focalLength, 5)) / 100;
    const wrongX = (edgeX * shot.focalLength) / (100 - shot.focalLength);
    expect((expectedX - wrongX) / pitch).toBeGreaterThan(3);

    const nx = 256;
    const image = renderOpticalImage(scene, shot, {
      centerX: expectedX,
      centerY: 0,
      width: nx * pitch,
      height: 4 * pitch,
      outputPixelSize: pitch,
    });
    const values = row(image.g, nx, 2);
    const k = values.findIndex((v) => v >= 0.5);
    const crossing = k - 1 + (0.5 - values[k - 1]!) / (values[k]! - values[k - 1]!);
    const crossingX = expectedX + (crossing - nx / 2 + 0.5) * pitch;
    expect(Math.abs(crossingX - expectedX) / pitch).toBeLessThan(0.1);
  });
});

describe("subject motion", () => {
  it("turns a moving edge into a linear ramp of length v·t·m", () => {
    const pitch = um(10);
    const shot = { ...baseShot, fNumber: 2.8, shutterTime: 1 / 25, resolution: resolutionForPitch(pitch) };
    const scene = planeScene(20, (x, _y, fp) => aaStep(x, fp), { velocity: { x: 0.5, y: 0 } });
    const streak = (0.5 * shot.shutterTime * imageDistance(shot.focalLength, 20)) / 20;
    expect(streak / pitch).toBeGreaterThan(15);

    const nx = 64;
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: nx * pitch,
      height: 4 * pitch,
      outputPixelSize: pitch,
      oversample: 4,
    });
    const values = row(image.g, nx, 2);
    for (let j = 0; j < nx; j++) {
      const x = (j - nx / 2 + 0.5) * pitch;
      const expected = Math.min(Math.max(x / streak + 0.5, 0), 1);
      expect(Math.abs(values[j]! - expected)).toBeLessThan(0.02);
    }
  });
});

describe("diffraction and pixel sampling", () => {
  function edgeMtf(fNumber: number, pitch: number, focus: number, focal = mm(200)) {
    const shot = { ...baseShot, focalLength: focal, fNumber, focusDistance: focus, resolution: resolutionForPitch(pitch) };
    const scene = planeScene(focus, (x, _y, fp) => aaStep(x, fp));
    const nx = 256;
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: nx * pitch,
      height: 4 * pitch,
      outputPixelSize: pitch,
    });
    const esf = row(image.g, nx, 2);
    const lsf = esf.slice(1).map((v, i) => v - esf[i]!);
    return { shot, lsf };
  }

  it.each([
    [16, um(2)],
    [4, um(6)],
  ])("measures an edge MTF equal to band diffraction × pixel aperture within 0.01 (f/%f)", (fNumber, pitch) => {
    const { shot, lsf } = edgeMtf(fNumber, pitch, 20);
    const nw = workingFNumber({ focalLength: shot.focalLength, fNumber }, 20);
    for (const cyclesPerPixel of [0.05, 0.1, 0.2, 0.3, 0.4]) {
      const expected = aliasedEdgeMtf(cyclesPerPixel, pitch, (f) => bandDiffractionMtf(f, COLOR_BANDS.green, nw));
      expect(Math.abs(mtfFromLsf(lsf, cyclesPerPixel) - expected)).toBeLessThan(0.01);
    }
  });
});

describe("resolution versus diffraction", () => {
  const sensorPeriod = um(9);
  const focus = 20;
  const scale = imageDistance(mm(200), focus) / focus;
  const objectPeriod = sensorPeriod / scale;
  const scene = planeScene(focus, (x, _y, fp) => 0.5 + 0.4 * prefilteredSine((2 * Math.PI * x) / objectPeriod, objectPeriod, fp));
  const pitch61 = 0.036 / 9564;

  function gratingAmplitude(fNumber: number): number {
    const shot = { ...baseShot, fNumber, resolution: { id: "61", label: "61", pixelsX: 9564, pixelsY: 6376 } };
    const nx = 512;
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: nx * pitch61,
      height: 4 * pitch61,
      outputPixelSize: pitch61,
    });
    return sinusoidAmplitude(row(image.g, nx, 2), sensorPeriod / pitch61);
  }

  it("resolves a grating beyond 24 MP Nyquist on 61 MP at f/4 with the predicted contrast (1%)", () => {
    const f = 1 / sensorPeriod;
    const nw = workingFNumber({ focalLength: mm(200), fNumber: 4 }, focus);
    const expected = 0.4 * bandDiffractionMtf(f, COLOR_BANDS.green, nw) * sinc(f * pitch61);
    expect(Math.abs(gratingAmplitude(4) / expected - 1)).toBeLessThan(0.01);
  });

  it("leaves only the band-averaged diffraction residue (< 1.5% modulation) at f/16", () => {
    const f = 1 / sensorPeriod;
    const nw = workingFNumber({ focalLength: mm(200), fNumber: 16 }, focus);
    const expected = 0.4 * bandDiffractionMtf(f, COLOR_BANDS.green, nw) * sinc(f * pitch61);
    const amplitude = gratingAmplitude(16);
    expect(Math.abs(amplitude - expected)).toBeLessThan(0.0004);
    expect(amplitude / 0.5).toBeLessThan(0.015);
  });
});

describe("sensor noise", () => {
  const scene = planeScene(20, () => 0.18);

  it.each([
    ["native pixels", um(25), um(25)],
    ["4× binned output", um(10), um(20)],
  ])("has electron variance = mean + read noise² (%s)", (_label, pitch, outputPixel) => {
    const shot = { ...baseShot, iso: 800, resolution: resolutionForPitch(pitch) };
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: 48 * outputPixel,
      height: 48 * outputPixel,
      outputPixelSize: outputPixel,
    });
    const levels = readOut(image, shot, { seed: 9 });
    const white = electronsAtWhite(shot.iso, image.sensorPitch) * image.binning;
    const electrons = Array.from({ length: image.width * image.height }, (_, i) => levels[i * 3 + 1]! * white);
    const mean = electrons.reduce((a, b) => a + b, 0) / electrons.length;
    const variance = electrons.reduce((a, b) => a + (b - mean) ** 2, 0) / (electrons.length - 1);

    const exposure = sensorExposure(lambertianLuminance(5000, 0.18), mm(200), 4, 20, 1 / 500);
    const expectedMean = meanElectrons(exposure, image.sensorPitch) * image.binning;
    const expectedVariance = expectedMean + GENERIC_SENSOR.readNoise ** 2 * image.binning;
    expect(Math.abs(mean - expectedMean) / expectedMean).toBeLessThan(0.01);
    expect(variance / expectedVariance).toBeGreaterThan(0.85);
    expect(variance / expectedVariance).toBeLessThan(1.15);
  });

  it("is reproducible for a seed and changes with the seed", () => {
    const shot = { ...baseShot, iso: 3200 };
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: um(25) * 16,
      height: um(25) * 16,
      outputPixelSize: 0,
    });
    const a = readOut(image, shot, { seed: 4 });
    const b = readOut(image, shot, { seed: 4 });
    const c = readOut(image, shot, { seed: 5 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe("wildlife studio", () => {
  it("renders a full-frame preview with plausible levels", () => {
    const scene = createWildlifeStudio(DEFAULT_STUDIO);
    const shot: ShotSettings = {
      focalLength: mm(600),
      fNumber: 5.6,
      focusDistance: DEFAULT_STUDIO.subjectDistance,
      shutterTime: 1 / 500,
      iso: 800,
      illuminance: 5000,
      resolution: resolutionForPitch(um(6)),
    };
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: 0.036,
      height: 0.024,
      outputPixelSize: 0.036 / 96,
    });
    expect(image.width).toBe(96);
    expect(image.height).toBe(64);
    const levels = readOut(image, shot, { noise: false });
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    expect(mean).toBeGreaterThan(0.02);
    expect(mean).toBeLessThan(0.9);
  });
});
