import { describe, expect, it } from "vitest";
import { imageDistance } from "../physics/optics";
import { fresnelReflectance } from "../physics/reflection";
import { mm, um } from "../physics/units";
import { renderOpticalImage } from "./pipeline";
import { baseShot, resolutionForPitch } from "./testScenes";
import type { PlaneLayer, RGBA, Scene, ShotSettings } from "./types";
import { createWaterSurface, mirroredPlane, standingPlane, waterLayer } from "./water";

const H = 1;
const flat = createWaterSurface(H, { rippleAmplitude: 0, body: [0.02, 0.02, 0.02] });

const wall = (v: (x: number, y: number) => number, distance = 60): PlaneLayer => ({
  kind: "plane",
  id: "wall",
  distance,
  bounds: { minX: -40, maxX: 40, minY: -H, maxY: 30 },
  sample(x, y, _fp, out) {
    out.r = out.g = out.b = v(x, y);
    out.a = 1;
  },
});

const view = { centerX: 0, centerY: 0, width: 0.036, height: 0.024, outputPixelSize: 0.036 / 120 };
const cos4 = (x: number, y: number, vF: number): number => ((vF * vF) / (vF * vF + x * x + y * y)) ** 2;

describe("reflections in calm water", () => {
  it("mirror a plane about the water level at the plane's own distance", () => {
    const real = wall((x, y) => 0.3 + 0.1 * Math.sin(3 * x) + 0.05 * y);
    const virtual = mirroredPlane(real, flat);
    const a: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    const b: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    for (const [x, y] of [
      [0.3, -1.2],
      [-2, -3.5],
      [5, -10],
    ] as const) {
      virtual.sample(x, y, 1e-3, a);
      real.sample(x, -2 * H - y, 1e-3, b);
      expect(a.g).toBeCloseTo(b.g, 12);
    }
  });

  it("render as (1 − R)·body + R·(mirrored scene) with exact Fresnel R", () => {
    const D = 60;
    const scene: Scene = {
      sky: () => 1,
      aim: { x: 0, y: -H, distance: D },
      layers: [mirroredPlane(wall(() => 0.5, D), flat), waterLayer("water", flat, 1, 1e5)],
    };
    const shot: ShotSettings = { ...baseShot, focalLength: mm(200), fNumber: 8, focusDistance: D, resolution: resolutionForPitch(um(6)) };
    const image = renderOpticalImage(scene, shot, view);
    const vF = imageDistance(shot.focalLength, shot.focusDistance);
    const shiftY = (-H * vF) / D;
    let checked = 0;
    for (let i = 45; i < 80; i += 5) {
      const y = 0.012 - (i + 0.5) * view.outputPixelSize;
      const x = 0.5 * view.outputPixelSize;
      const depression = Math.atan2(-(y + shiftY), Math.hypot(vF, x));
      const R = fresnelReflectance(Math.sin(depression));
      const expected = (1 - R) * 0.02 + R * 0.5;
      expect(image.g[i * 120 + 60]! / cos4(x, y, vF) / expected).toBeCloseTo(1, 2);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it.each([
    [mm(1200), 2.8, 10],
    [mm(600), 5.6, 30],
  ])("join an object and its reflection without a halo at a defocused waterline (f = %f, f/%f, focus %f m)", (focalLength, fNumber, focus) => {
    const D = 60;
    const sky = () => 1;
    const real = wall((x) => 0.2 + 0.05 * Math.sin(x), D);
    const standing = standingPlane(real, flat, sky);
    const layered: Scene = {
      sky,
      aim: { x: 0, y: -H, distance: D },
      layers: [mirroredPlane(real, flat), waterLayer("water", flat, 1, 1e5), standing],
    };
    const { contactY: _uncut, ...wholeExtension } = standing;
    const reference: Scene = { ...layered, layers: [wholeExtension] };
    const shot: ShotSettings = { ...baseShot, focalLength, fNumber, focusDistance: focus, resolution: resolutionForPitch(um(6)) };
    const a = renderOpticalImage(layered, shot, view);
    const b = renderOpticalImage(reference, shot, view);
    let worst = 0;
    for (let i = 0; i < a.g.length; i++) worst = Math.max(worst, Math.abs(a.g[i]! - b.g[i]!));
    expect(worst).toBeLessThan(0.003);
  });
});
