/**
 * Validation tests added by the physics audit. Each one fails on a specific
 * shortcut that would make the simulation disagree with optics.
 */
import { describe, expect, it } from "vitest";
import { bandDefocusedOtf, bandDiffractionMtf, COLOR_BANDS } from "../physics/diffraction";
import { lambertianLuminance, middleGreyExposure, sensorExposure, stopsBetween } from "../physics/exposure";
import { blurCircleDiameter, imageDistance, workingFNumber } from "../physics/optics";
import { outputLevel, pixelPitch, FULL_FRAME, RESOLUTION_PRESETS } from "../physics/sensor";
import { fresnelReflectance, WATER_REFRACTIVE_INDEX } from "../physics/reflection";
import { mm, um, WAVELENGTHS } from "../physics/units";
import { computeReadouts } from "../readouts";
import { readOut, renderOpticalImage } from "./pipeline";
import { createWaterSurface, createWildlifeStudio, DEFAULT_STUDIO } from "./studio";
import { aliasedEdgeMtf, baseShot, mtfFromLsf, planeScene, resolutionForPitch, row, sinc, sinusoidAmplitude } from "./testScenes";
import { prefilteredSine, tentStep } from "./textures";
import type { GroundLayer, RGBA, Scene, SceneLayer, ShotSettings } from "./types";

const aaStep = (x: number, fp: number, edge = 0): number => tentStep((x - edge) / fp);

/** Relative illumination of an aplanatic lens at image height r: cos⁴θ. */
const cos4 = (x: number, y: number, vF: number): number => (vF * vF / (vF * vF + x * x + y * y)) ** 2;

describe("water surface continuity (audit: seams leaked sky)", () => {
  it.each([
    [mm(600), 5.6, 30],
    [mm(1200), 2.8, 30],
    [mm(300), 4, 30],
    [mm(1200), 2.8, 18],
  ])("renders a uniform-radiance studio uniformly (f = %f, f/%f, focus %f m)", (focalLength, fNumber, focus) => {
    const scene = createWildlifeStudio({ ...DEFAULT_STUDIO, validationRadiance: 0.4 });
    const shot: ShotSettings = { ...baseShot, focalLength, fNumber, focusDistance: focus, resolution: resolutionForPitch(um(6)) };
    const nx = 120;
    const ny = 80;
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: 0.036,
      height: 0.024,
      outputPixelSize: 0.036 / nx,
    });
    const vF = imageDistance(focalLength, focus);
    let worst = 0;
    for (let i = 0; i < ny; i++) {
      for (let j = 0; j < nx; j++) {
        const x = (j - nx / 2 + 0.5) * image.outputPixelSize;
        const y = (ny / 2 - i - 0.5) * image.outputPixelSize;
        worst = Math.max(worst, Math.abs(image.g[i * nx + j]! / (0.4 * cos4(x, y, vF)) - 1));
      }
    }
    expect(worst).toBeLessThan(0.005);
  });
});

describe("contact lines with the water (re-audit: far water showed through blurred waterlines)", () => {
  const H = 1;
  const uniformGround = (id: string, near: number, far: number, v: number, occluderOnly: boolean): GroundLayer => ({
    kind: "ground",
    id,
    cameraHeight: H,
    nearDistance: near,
    farDistance: far,
    occluderOnly,
    sample(_x, _z, _fx, _fz, out) {
      out.r = out.g = out.b = v;
      out.a = 1;
    },
  });
  const opaqueBox = (id: string, distance: number, halfWidth: number, top: number, v: number, contact: boolean): SceneLayer => ({
    kind: "plane",
    id,
    distance,
    bounds: { minX: -halfWidth, maxX: halfWidth, minY: -50, maxY: top },
    velocity: { x: id === "box" ? 0.5 : 0, y: 0 },
    ...(contact ? { contactY: -H } : {}),
    sample(x, y, fp, out) {
      const a = tentStep((halfWidth - Math.abs(x)) / fp) * tentStep((top - y) / fp);
      out.r = out.g = out.b = v * a;
      out.a = a;
    },
  });
  // Rock and water at the same depth form one continuous surface: the reference draws the
  // wall and box opaque all the way down and the water in front of them in full.
  const layered: Scene = {
    sky: () => 1,
    aim: { x: 0, y: -0.88, distance: 30 },
    layers: [
      uniformGround("water", 1.5, 1e5, 0.8, false),
      opaqueBox("wall", 60, 30, 20, 0.2, true),
      uniformGround("water-before-wall", 1.5, 60, 0.8, true),
      opaqueBox("box", 30, 0.3, -0.7, 0.4, true),
      uniformGround("water-before-box", 1.5, 30, 0.8, true),
    ],
  };
  const reference: Scene = {
    ...layered,
    layers: [
      opaqueBox("wall", 60, 30, 20, 0.2, false),
      uniformGround("water-before-wall", 1.5, 60, 0.8, false),
      opaqueBox("box", 30, 0.3, -0.7, 0.4, false),
      uniformGround("water-before-box", 1.5, 30, 0.8, false),
    ],
  };

  it.each([
    [mm(600), 5.6, 30],
    [mm(1200), 2.8, 20],
    [mm(400), 4, 45],
  ])("matches an occlusion-correct reference (f = %f, f/%f, focus %f m)", (focalLength, fNumber, focus) => {
    const shot: ShotSettings = { ...baseShot, focalLength, fNumber, focusDistance: focus, resolution: resolutionForPitch(um(6)) };
    const view = { centerX: 0, centerY: 0, width: 0.036, height: 0.024, outputPixelSize: 0.036 / 120 };
    const a = renderOpticalImage(layered, shot, view);
    const b = renderOpticalImage(reference, shot, view);
    let worst = 0;
    for (let i = 0; i < a.g.length; i++) worst = Math.max(worst, Math.abs(a.g[i]! - b.g[i]!));
    expect(worst).toBeLessThan(0.005);
  });

  it("declares the studio's background and duck as standing in the water, opaque below it", () => {
    const scene = createWildlifeStudio({ ...DEFAULT_STUDIO, showTarget: false });
    const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    for (const id of ["background", "duck"]) {
      const layer = scene.layers.find((l) => l.id === id)!;
      expect(layer.kind === "plane" && layer.contactY).toBe(-DEFAULT_STUDIO.cameraHeight);
      if (layer.kind !== "plane") continue;
      layer.sample(id === "duck" ? 0 : 1, -DEFAULT_STUDIO.cameraHeight - 0.05, 1e-4, out);
      expect(out.a).toBeCloseTo(1, 6);
    }
  });
});

/** Tent-prefiltered indicator of the band [z0 − dz/2, z0 + dz/2]. */
function boxOverlap(z: number, fp: number, z0: number, dz: number): number {
  return tentStep((z - z0 + dz / 2) / fp) - tentStep((z - z0 - dz / 2) / fp);
}

function groundLineScene(cameraHeight: number, lineZ: number, thickness: number): Scene {
  const water: GroundLayer = {
    kind: "ground",
    id: "water",
    cameraHeight,
    nearDistance: 1,
    farDistance: 1e4,
    sample(_gx, gz, _fpX, fpZ, out: RGBA) {
      const v = 0.1 + 0.8 * boxOverlap(gz, fpZ, lineZ, thickness);
      out.r = v;
      out.g = v;
      out.b = v;
      out.a = 1;
    },
  };
  return { sky: () => 0.1, aim: { x: 0, y: -cameraHeight, distance: lineZ }, layers: [water] };
}

describe("depth-dependent blur on the water (audit: strips used their near-edge blur)", () => {
  const pitch = um(10);
  const focus = 20;
  const shot: ShotSettings = { ...baseShot, fNumber: 2.8, focusDistance: focus, resolution: resolutionForPitch(pitch) };
  const lens = { focalLength: shot.focalLength, fNumber: shot.fNumber };

  it.each([25, 30, 40, 20])("blurs a line on the water at %f m by the blur circle of its own depth", (lineZ) => {
    const scene = groundLineScene(1, lineZ, 0.01);
    const n = 128;
    const image = renderOpticalImage(scene, shot, {
      centerX: 0,
      centerY: 0,
      width: 16 * pitch,
      height: n * pitch,
      outputPixelSize: pitch,
    });
    const c = blurCircleDiameter(lens, focus, lineZ) / pitch;
    // The Airy line spread has a divergent second moment, so moments are taken within c/2 + 4 px of the line.
    const window = Math.ceil(c / 2) + 4;
    const profile: number[] = [];
    for (let i = n / 2 - window; i < n / 2 + window; i++) profile.push(image.g[i * 16 + 8]! - 0.1);
    const total = profile.reduce((a, b) => a + b, 0);
    const mean = profile.reduce((a, v, i) => a + v * i, 0) / total;
    const variance = profile.reduce((a, v, i) => a + v * (i - mean) ** 2, 0) / total;
    // Uniform disk projected onto one axis has variance c²/16; pixel box adds 1/12.
    const expectedSigma = Math.sqrt((c * c) / 16 + 1 / 12);
    if (c < 1) expect(Math.sqrt(variance)).toBeLessThan(1);
    else expect(Math.abs(Math.sqrt(variance) / expectedSigma - 1)).toBeLessThan(0.1);
  });
});

describe("diffraction at the working f-number (audit: (1 + m) ignored)", () => {
  it("matches the band MTF at N(1 + m) for an edge at 5 m through 1200 mm", () => {
    const pitch = um(2);
    const focus = 5;
    const shot: ShotSettings = {
      ...baseShot,
      focalLength: mm(1200),
      fNumber: 8,
      focusDistance: focus,
      resolution: resolutionForPitch(pitch),
    };
    const scene = planeScene(focus, (x, _y, fp) => aaStep(x, fp));
    scene.aim = { x: 0, y: 0, distance: focus };
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
    const nw = workingFNumber({ focalLength: mm(1200), fNumber: 8 }, focus);
    let maxGap = 0;
    for (const cpp of [0.05, 0.1, 0.15, 0.2, 0.3]) {
      const f = cpp / pitch;
      const expected = aliasedEdgeMtf(cpp, pitch, (freq) => bandDiffractionMtf(freq, COLOR_BANDS.green, nw));
      const naive = bandDiffractionMtf(f, COLOR_BANDS.green, 8) * sinc(cpp) ** 2;
      maxGap = Math.max(maxGap, naive - expected);
      expect(Math.abs(mtfFromLsf(lsf, cpp) - expected)).toBeLessThan(0.01);
    }
    expect(maxGap).toBeGreaterThan(0.04);
  });
});

describe("defocus and diffraction together (audit: product of OTFs)", () => {
  it("matches the Hopkins defocused-pupil OTF at small defocus", () => {
    const pitch = um(2);
    const nw = workingFNumber({ focalLength: mm(200), fNumber: 4 }, 20);
    const c = 4 * WAVELENGTHS.green * nw;
    const vF = imageDistance(mm(200), 20);
    const objectDistance = 1 / (1 / 20 - c / ((mm(200) / 4) * vF));
    const scene = planeScene(objectDistance, (x, _y, fp) => aaStep(x, fp));
    scene.aim = { x: 0, y: 0, distance: objectDistance };
    const shot = { ...baseShot, resolution: resolutionForPitch(pitch) };
    expect(blurCircleDiameter({ focalLength: mm(200), fNumber: 4 }, 20, objectDistance)).toBeCloseTo(c, 9);

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
    let maxGap = 0;
    for (const cpp of [0.05, 0.1, 0.15, 0.2, 0.25]) {
      const f = cpp / pitch;
      const expected = aliasedEdgeMtf(cpp, pitch, (freq) => bandDefocusedOtf(freq, c, COLOR_BANDS.green, nw));
      const disk = Math.abs((2 * besselJ1(Math.PI * c * f)) / (Math.PI * c * f));
      const product = disk * bandDiffractionMtf(f, COLOR_BANDS.green, nw) * sinc(cpp) ** 2;
      maxGap = Math.max(maxGap, Math.abs(product - expected));
      expect(Math.abs(mtfFromLsf(lsf, cpp) - expected)).toBeLessThan(0.01);
    }
    expect(maxGap).toBeGreaterThan(0.03);
  });
});

describe("resolution fairness (audit: prefilter favoured finer pixels)", () => {
  it("renders the same grating with contrast exactly diffraction × own pixel aperture on 24 and 61 MP", () => {
    const focus = 20;
    const scale = imageDistance(mm(200), focus) / focus;
    const ratios: number[] = [];
    for (const sensorFrequency of [40e3, 70e3]) {
      for (const preset of [RESOLUTION_PRESETS[0]!, RESOLUTION_PRESETS[2]!]) {
        const pitch = pixelPitch(FULL_FRAME, preset);
        const objectPeriod = 1 / (sensorFrequency * scale);
        const scene = planeScene(focus, (x, _y, fp) => 0.5 + 0.4 * prefilteredSine((2 * Math.PI * x) / objectPeriod, objectPeriod, fp));
        const shot = { ...baseShot, resolution: preset };
        const nx = 512;
        const image = renderOpticalImage(scene, shot, {
          centerX: 0,
          centerY: 0,
          width: nx * pitch,
          height: 4 * pitch,
          outputPixelSize: pitch,
        });
        const measured = sinusoidAmplitude(row(image.g, nx, 2), 1 / (sensorFrequency * pitch));
        const nw = workingFNumber({ focalLength: mm(200), fNumber: 4 }, focus);
        ratios.push(measured / (0.4 * bandDiffractionMtf(sensorFrequency, COLOR_BANDS.green, nw) * sinc(sensorFrequency * pitch)));
      }
    }
    for (const r of ratios) expect(Math.abs(r - 1)).toBeLessThan(0.01);
    expect(Math.abs(ratios[0]! - ratios[1]!)).toBeLessThan(0.005);
    expect(Math.abs(ratios[2]! - ratios[3]!)).toBeLessThan(0.005);
  });
});

describe("colour channels (audit: weak tests)", () => {
  it.each([
    ["static", { x: 0, y: 0 }],
    ["diagonal motion", { x: 0.31, y: 0.17 }],
  ])("keeps red and green independent through packed FFTs (%s)", (_label, velocity) => {
    const pitch = um(10);
    const pattern = (x: number, y: number, fp: number) => 0.3 + 0.2 * prefilteredSine((2 * Math.PI * (x + 0.4 * y)) / 0.004, 0.004, fp);
    const other = (x: number, y: number, fp: number) => 0.5 + 0.3 * aaStep(x - 0.2 * y, fp);
    const shot = { ...baseShot, shutterTime: 1 / 30, resolution: resolutionForPitch(pitch) };
    const view = { centerX: 0, centerY: 0, width: 40 * pitch, height: 40 * pitch, outputPixelSize: pitch };
    const mixed = renderOpticalImage(planeScene(20, (x, y, fp) => [pattern(x, y, fp), other(x, y, fp), 0.1], { velocity }), shot, view);
    const alone = renderOpticalImage(planeScene(20, (x, y, fp) => [pattern(x, y, fp), pattern(x, y, fp), 0.1], { velocity }), shot, view);
    for (let i = 0; i < mixed.r.length; i++) expect(Math.abs(mixed.r[i]! - alone.r[i]!)).toBeLessThan(1e-9);
  });
});

describe("sky luminance by elevation (audit: uniform sky vs lit surfaces)", () => {
  it("fills uncovered rows with the sky radiance at each pixel's elevation, times cos⁴", () => {
    const focalLength = mm(100);
    const sky = (elevation: number) => 1 + 2 * Math.sin(elevation);
    const scene: Scene = { sky: (e) => sky(e), aim: { x: 0, y: 0, distance: 100 }, layers: [] };
    const shot = { ...baseShot, focalLength, focusDistance: 100, resolution: resolutionForPitch(um(6)) };
    const nx = 60;
    const ny = 40;
    const image = renderOpticalImage(scene, shot, { centerX: 0, centerY: 0, width: 0.036, height: 0.024, outputPixelSize: 0.036 / nx });
    const vF = imageDistance(focalLength, 100);
    for (const [i, j] of [
      [1, 1],
      [20, 30],
      [38, 50],
    ] as const) {
      const x = (j - nx / 2 + 0.5) * image.outputPixelSize;
      const y = (ny / 2 - i - 0.5) * image.outputPixelSize;
      const expected = sky(Math.atan(y / Math.hypot(vF, x))) * cos4(x, y, vF);
      expect(image.g[i * nx + j]! / expected).toBeCloseTo(1, 2);
    }
  });
});

describe("readouts share the renderer's exposure model (audit: missing bellows factor)", () => {
  it("reports the same EV offset that a rendered 18% grey card produces", () => {
    const shot: ShotSettings = {
      ...baseShot,
      focalLength: mm(1200),
      fNumber: 8,
      focusDistance: 5,
      shutterTime: 1 / 250,
      iso: 400,
      resolution: RESOLUTION_PRESETS[0]!,
    };
    const studio = { ...DEFAULT_STUDIO, subjectDistance: 5 };
    const readouts = computeReadouts(shot, studio, { displayPixel: 0 });
    const scene = planeScene(5, () => 0.18);
    const pitch = pixelPitch(FULL_FRAME, shot.resolution);
    const image = renderOpticalImage(scene, shot, { centerX: 0, centerY: 0, width: 8 * pitch, height: 8 * pitch, outputPixelSize: pitch });
    const level = readOut(image, shot, { noise: false })[1]!;
    expect(stopsBetween(10 / 78, level)).toBeCloseTo(readouts.exposureOffsetEv, 2);
    const exposure = sensorExposure(lambertianLuminance(shot.illuminance, 0.18), mm(1200), 8, 5, 1 / 250);
    expect(level).toBeCloseTo(outputLevel(exposure, 400, pitch), 6);
    expect(middleGreyExposure(400)).toBeCloseTo(10 / 400, 12);
  });

  it("warns when the aim angle exceeds the image-shift validity limit", () => {
    const shot = { ...baseShot, focalLength: mm(600), focusDistance: 5 };
    expect(computeReadouts(shot, { ...DEFAULT_STUDIO, subjectDistance: 5, cameraHeight: 2 }, { displayPixel: 0 }).aimWarning).toBe(true);
    expect(computeReadouts(shot, { ...DEFAULT_STUDIO, subjectDistance: 30, cameraHeight: 1 }, { displayPixel: 0 }).aimWarning).toBe(false);
  });

  it("uses the chief-ray scale for subject motion when focus is off the subject", () => {
    const shot = { ...baseShot, focalLength: mm(1200), focusDistance: 10, shutterTime: 1 / 100 };
    const r = computeReadouts(shot, { ...DEFAULT_STUDIO, subjectDistance: 30, subjectSpeed: 0.3 }, { displayPixel: 0 });
    const pitch = pixelPitch(FULL_FRAME, shot.resolution);
    expect(r.motionBlur).toBeCloseTo((0.3 * 0.01 * imageDistance(mm(1200), 10)) / 30, 12);
    expect(r.motionBlurPixels).toBeCloseTo(r.motionBlur / pitch, 9);
  });
});

describe("scene detail (audit: textures coarser than 61 MP Nyquist when close)", () => {
  it("puts measurable feather detail beyond 61 MP Nyquist at 1200 mm and 10 m", () => {
    const scene = createWildlifeStudio({ ...DEFAULT_STUDIO, subjectDistance: 10 });
    const duck = scene.layers.find((l) => l.id === "duck");
    if (!duck || duck.kind !== "plane") throw new Error("duck layer missing");
    const m = imageDistance(mm(1200), 10) / 10;
    const nyquistPeriod = (2 * pixelPitch(FULL_FRAME, RESOLUTION_PRESETS[2]!)) / m;
    const step = nyquistPeriod / 12;
    const n = 1024;
    const values: number[] = [];
    const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    const headY = scene.aim.y + 0.09;
    for (let i = 0; i < n; i++) {
      duck.sample(0.13 + i * step, headY, step, out);
      values.push(out.g);
    }
    const mean = values.reduce((a, b) => a + b, 0) / n;
    let fine = 0;
    let total = 0;
    for (let k = 1; k < n / 2; k++) {
      let re = 0;
      let im = 0;
      values.forEach((v, i) => {
        re += (v - mean) * Math.cos((2 * Math.PI * k * i) / n);
        im += (v - mean) * Math.sin((2 * Math.PI * k * i) / n);
      });
      const power = re * re + im * im;
      total += power;
      if (k / (n * step) > 1.25 / nyquistPeriod) fine += power;
    }
    expect(fine / total).toBeGreaterThan(0.01);
  });
});

describe("water reflection (audit: Schlick and isotropic over-filtering)", () => {
  it.each([
    [30, 0.002],
    [60, 0.004],
  ])("matches the area average over a footprint elongated in depth (Z = %f m)", (Z, fpX) => {
    const water = createWaterSurface(1, { kind: "cieOvercast" });
    const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    const fpZ = fpX * Z;
    const nz = 4 * Z;
    const got: number[] = [];
    const ref: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = i * fpX;
      water.sample(x, Z, fpX, fpZ, out);
      got.push(out.g);
      let sum = 0;
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < nz; b++) {
          water.sample(x + ((a + 0.5) / 4 - 0.5) * fpX, Z + ((b + 0.5) / nz - 0.5) * fpZ, fpX / 4, fpZ / nz, out);
          sum += out.g;
        }
      }
      ref.push(sum / (4 * nz));
    }
    const mean = ref.reduce((a, b) => a + b, 0) / ref.length;
    const std = Math.sqrt(ref.reduce((a, b) => a + (b - mean) ** 2, 0) / ref.length);
    const rms = Math.sqrt(got.reduce((a, g, i) => a + (g - ref[i]!) ** 2, 0) / got.length);
    expect(std).toBeGreaterThan(1e-3);
    expect(rms / std).toBeLessThan(0.05);
  });

  it("uses exact Fresnel reflectance for a flat surface", () => {
    const water = createWaterSurface(1, { kind: "uniform", radianceFactor: 1 }, { rippleAmplitude: 0, body: [0, 0, 0] });
    const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    water.sample(0, 1, 1e-3, 1e-3, out);
    // 45° incidence on n = 1.333 (Schlick would give 0.0221).
    expect(out.g).toBeCloseTo(fresnelReflectance(Math.SQRT1_2, WATER_REFRACTIVE_INDEX), 6);
    expect(out.g).toBeCloseTo(0.0279, 4);
  });
});

function besselJ1(x: number): number {
  let sum = 0;
  let term = x / 2;
  for (let k = 0; k < 40; k++) {
    sum += term;
    term *= -(x * x) / (4 * (k + 1) * (k + 2));
  }
  return sum;
}
