/** Minimal scenes and measurements shared by the rendering validation tests. */
import type { SensorResolution } from "../physics/sensor";
import { mm, um } from "../physics/units";
import type { RGBA, Scene, ShotSettings } from "./types";

/** Custom sensor grid with the given pixel pitch on a 36 mm wide format. */
export function resolutionForPitch(pitch: number): SensorResolution {
  const pixelsX = Math.round(0.036 / pitch);
  return { id: "test", label: "test", pixelsX, pixelsY: Math.round((pixelsX * 2) / 3) };
}

type Radiance = number | readonly [number, number, number];

export interface PlaneSceneOptions {
  velocity?: { x: number; y: number };
  sky?: number;
}

/** One infinite plane whose radiance factor is given by `sample(x, y, footprint)`. */
export function planeScene(
  distance: number,
  sample: (x: number, y: number, footprint: number) => Radiance,
  options: PlaneSceneOptions = {},
): Scene {
  const sky = options.sky ?? 0;
  return {
    sky: () => sky,
    aim: { x: 0, y: 0, distance },
    layers: [
      {
        kind: "plane",
        id: "plane",
        distance,
        bounds: { minX: -1e3, maxX: 1e3, minY: -1e3, maxY: 1e3 },
        velocity: options.velocity ?? { x: 0, y: 0 },
        sample(x: number, y: number, fp: number, out: RGBA) {
          const v = sample(x, y, fp);
          if (typeof v === "number") {
            out.r = v;
            out.g = v;
            out.b = v;
          } else {
            out.r = v[0];
            out.g = v[1];
            out.b = v[2];
          }
          out.a = 1;
        },
      },
    ],
  };
}

export const baseShot: ShotSettings = {
  focalLength: mm(200),
  fNumber: 4,
  focusDistance: 20,
  shutterTime: 1 / 500,
  iso: 400,
  illuminance: 5000,
  resolution: resolutionForPitch(um(25)),
};

export function row(values: Float64Array, width: number, rowIndex: number): number[] {
  return Array.from(values.subarray(rowIndex * width, (rowIndex + 1) * width));
}

/** Modulus of the normalized DFT of a line spread function at the given frequency (cycles per sample). */
export function mtfFromLsf(lsf: number[], cyclesPerSample: number): number {
  let re = 0;
  let im = 0;
  let dc = 0;
  lsf.forEach((v, i) => {
    re += v * Math.cos(2 * Math.PI * cyclesPerSample * i);
    im += v * Math.sin(2 * Math.PI * cyclesPerSample * i);
    dc += v;
  });
  return Math.hypot(re, im) / dc;
}

/** Amplitude of a sinusoid with the given period (in samples) in a row, by projection. */
export function sinusoidAmplitude(values: number[], periodSamples: number): number {
  let re = 0;
  let im = 0;
  const n = values.length;
  values.forEach((v, j) => {
    const phase = (2 * Math.PI * (j - n / 2 + 0.5)) / periodSamples;
    re += v * Math.cos(phase);
    im += v * Math.sin(phase);
  });
  return (2 * Math.hypot(re, im)) / n;
}

/**
 * Expected modulus of the DFT of a differenced edge sampled at pixel
 * centres, with the edge on a pixel boundary: all aliases add in phase,
 *   M(f) = |Σ_k H(f + k)·sinc²(f + k)|   (f in cycles/pixel),
 * one sinc from the pixel aperture and one from differencing.
 */
export function aliasedEdgeMtf(cyclesPerPixel: number, pitch: number, opticalOtf: (frequency: number) => number): number {
  let sum = 0;
  for (let k = -4; k <= 4; k++) {
    const f = cyclesPerPixel + k;
    sum += opticalOtf(Math.abs(f) / pitch) * sinc(f) ** 2;
  }
  return Math.abs(sum);
}

/** sin(πx)/(πx). */
export function sinc(x: number): number {
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
}
