/**
 * 2.5D wildlife studio: a duck on water in front of rocks and foliage. The
 * duck, a test card and the background are fronto-parallel planes; the water
 * is a true horizontal surface, so its defocus varies continuously with depth.
 */
import { skyRadianceFactor, type SkyModel } from "../physics/exposure";
import { fresnelReflectance, WATER_REFRACTIVE_INDEX } from "../physics/reflection";
import { fbm, hash2, octavesDownTo, prefilteredSine, smoothstep, tentStep } from "./textures";
import type { GroundLayer, PlaneLayer, RGBA, Scene, SceneLayer } from "./types";

export interface StudioOptions {
  subjectDistance: number;
  backgroundDistance: number;
  /** Camera height above the water, meters. */
  cameraHeight: number;
  /** Duck swimming speed to the right, m/s. */
  subjectSpeed: number;
  showTarget: boolean;
  sky: SkyModel;
  /**
   * Validation mode: every surface (not the sky) has this radiance factor,
   * so any seam or occlusion error shows up as a deviation from uniformity.
   */
  validationRadiance?: number;
}

export const DEFAULT_STUDIO: StudioOptions = {
  subjectDistance: 30,
  backgroundDistance: 60,
  cameraHeight: 1,
  subjectSpeed: 0.15,
  showTarget: true,
  sky: { kind: "cieOvercast" },
};

const WATER_BODY: readonly [number, number, number] = [0.02, 0.028, 0.024];
/** RMS-scale water surface slope in radians (heuristic: light breeze). */
const RIPPLE_SLOPE = 0.04;
/** Height of the duck's centre above the waterline, meters. */
const DUCK_AIM_HEIGHT = 0.12;

/** Duck head centre relative to the aim point, in object meters; detail crops centre here. */
export const DUCK_HEAD_OFFSET = { x: 0.15, y: 0.21 - DUCK_AIM_HEIGHT } as const;

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);

/** Tent-prefiltered coverage of a half-plane whose signed distance (positive outside) is d. */
const edgeCoverage = (d: number, fp: number): number => tentStep(-d / fp);

/** Approximate prefiltered coverage of an ellipse via its first-order signed distance. */
function ellipseCoverage(x: number, y: number, cx: number, cy: number, rx: number, ry: number, fp: number): number {
  const u = (x - cx) / rx;
  const v = (y - cy) / ry;
  const r = Math.hypot(u, v);
  if (r < 0.5) return 1;
  const gradient = Math.hypot(u / rx, v / ry) / r;
  return edgeCoverage((r - 1) / gradient, fp);
}

/** Front-to-back compositing of prefiltered shapes into one premultiplied sample. */
class ShapeStack {
  r = 0;
  g = 0;
  b = 0;
  remaining = 1;
  reset(): void {
    this.r = this.g = this.b = 0;
    this.remaining = 1;
  }
  add(coverage: number, r: number, g: number, b: number): void {
    if (coverage <= 0) return;
    const w = this.remaining * coverage;
    this.r += w * r;
    this.g += w * g;
    this.b += w * b;
    this.remaining *= 1 - coverage;
  }
  write(out: RGBA, scale = 1): void {
    out.r = this.r * scale;
    out.g = this.g * scale;
    out.b = this.b * scale;
    out.a = (1 - this.remaining) * scale;
  }
}

const BARB_SCALES = [
  [1, 0.18],
  [2, 0.14],
  [4, 0.1],
  [8, 0.08],
  [16, 0.06],
  [32, 0.05],
  [64, 0.04],
] as const;

/**
 * Scalloped feather cells with a central shaft, barbs and barbules over
 * seven octaves down to barbPeriod·4/64 (≈ 12–20 µm), and mottling down to
 * 10 µm, so close-up resolution comparisons are never limited by the scene.
 */
function feathers(u: number, w: number, footprint: number, cellW: number, cellH: number, barbPeriod: number, seed: number): number {
  const row = Math.floor(w / cellH);
  const offset = row & 1 ? cellW / 2 : 0;
  const col = Math.floor((u + offset) / cellW);
  const lu = (u + offset) / cellW - col;
  const lw = w / cellH - row;
  const across = 2 * lu - 1;
  const scallop = lw - 0.35 * (1 - across * across);
  const edge = 0.65 + 0.35 * smoothstep(-0.1, 0.25, scallop);
  const shaftWidth = Math.max(0.04, footprint / cellW);
  const shaft = 1 - 0.25 * (1 - smoothstep(0, shaftWidth, Math.abs(across)));
  const angle = 0.5 + 0.6 * (hash2(col, row, seed) - 0.5);
  const side = across < 0 ? -1 : 1;
  const along = u * Math.cos(angle * side) + w * Math.sin(angle);
  let barbs = 0;
  for (const [divisor, contrast] of BARB_SCALES) {
    const period = (barbPeriod * 4) / divisor;
    if (period < footprint) break;
    barbs += contrast * prefilteredSine((2 * Math.PI * along) / period, period, footprint);
  }
  const mottle = fbm(u, w, { scale: 0.006, octaves: octavesDownTo(0.006, 1e-5), footprint, seed: seed + 1 });
  return edge * shaft * (1 + barbs + 0.12 * mottle);
}

function createDuck(distance: number, waterY: number, speed: number, uniform: number | undefined): PlaneLayer {
  const stack = new ShapeStack();
  return {
    kind: "plane",
    id: "duck",
    distance,
    bounds: { minX: -0.25, maxX: 0.27, minY: waterY - 10, maxY: waterY + 0.28 },
    velocity: { x: speed, y: 0 },
    contactY: waterY,
    sample(x, y, fp, out) {
      // Below the waterline the body continues as its waterline cross-section (hidden by the water in front).
      const w = Math.max(y - waterY, 0);
      stack.reset();
      const tone = (base: readonly [number, number, number], t: number) =>
        uniform === undefined ? ([base[0] * t, base[1] * t, base[2] * t] as const) : ([uniform, uniform, uniform] as const);
      const shape = (cov: number, color: () => readonly [number, number, number]) => {
        if (cov > 0) {
          const [r, g, b] = color();
          stack.add(cov, r, g, b);
        }
      };
      shape(ellipseCoverage(x, w, 0.165, 0.222, 0.007, 0.007, fp), () => tone([0.02, 0.015, 0.01], 1));
      shape(ellipseCoverage(x, w, 0.215, 0.195, 0.045, 0.014, fp), () => tone([0.55, 0.45, 0.08], 1));
      shape(ellipseCoverage(x, w, 0.15, 0.21, 0.05, 0.05, fp), () => tone([0.02, 0.1, 0.04], feathers(x, w, fp, 0.006, 0.004, 0.0002, 21)));
      const neck = ellipseCoverage(x, w, 0.12, 0.15, 0.035, 0.07, fp);
      const ring = tentStep((w - 0.115) / fp) - tentStep((w - 0.13) / fp);
      shape(neck * ring, () => tone([0.7, 0.7, 0.68], 1));
      shape(neck, () => tone([0.18, 0.08, 0.04], feathers(x, w, fp, 0.008, 0.005, 0.00025, 22)));
      shape(ellipseCoverage(x, w, -0.17, 0.09, 0.06, 0.03, fp), () => tone([0.08, 0.07, 0.06], feathers(x, w, fp, 0.015, 0.01, 0.0003, 23)));
      shape(ellipseCoverage(x, w, 0, 0.06, 0.19, 0.085, fp), () => tone([0.2, 0.16, 0.12], feathers(x, w, fp, 0.022, 0.014, 0.0003, 24)));
      stack.write(out);
    },
  };
}

/** ISO 12233-style slanted edge card (5°) floating beside the duck, for sharpness measurement. */
function createTarget(distance: number, waterY: number, uniform: number | undefined): PlaneLayer {
  const cx = -0.5;
  const cy = waterY + 0.17;
  const tilt = (5 * Math.PI) / 180;
  return {
    kind: "plane",
    id: "target",
    distance,
    bounds: { minX: -0.66, maxX: -0.34, minY: waterY + 0.01, maxY: waterY + 0.33 },
    sample(x, y, fp, out) {
      const card =
        edgeCoverage(-0.65 - x, fp) * edgeCoverage(x + 0.35, fp) * edgeCoverage(waterY + 0.02 - y, fp) * edgeCoverage(y - waterY - 0.32, fp);
      const side = (x - cx) * Math.cos(tilt) - (y - cy) * Math.sin(tilt);
      const v = uniform ?? 0.05 + 0.65 * tentStep(side / fp);
      out.r = out.g = out.b = v * card;
      out.a = card;
    },
  };
}

function createBackground(distance: number, waterY: number, uniform: number | undefined): PlaneLayer {
  return {
    kind: "plane",
    id: "background",
    distance,
    bounds: { minX: -0.3 * distance, maxX: 0.3 * distance, minY: waterY - distance, maxY: waterY + 0.5 * distance },
    contactY: waterY,
    sample(x, y, fp, out) {
      // Rock fills everything below rockTop ≥ 0.2 m, including the submerged part below the waterline.
      const w = y - waterY;
      if (uniform !== undefined) {
        out.r = out.g = out.b = uniform;
        out.a = 1;
        return;
      }
      const rockTop = 1 + 0.8 * fbm(x, 0, { scale: 3, octaves: octavesDownTo(3, 1e-3), footprint: fp, seed: 11 });
      const rock = w < 0 ? 1 : tentStep((rockTop - w) / fp);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (rock > 0) {
        const v =
          0.2 +
          0.07 * fbm(x, w, { scale: 0.6, octaves: octavesDownTo(0.6, 1e-4), footprint: fp, seed: 12 }) +
          0.04 * fbm(x, w, { scale: 0.08, octaves: octavesDownTo(0.08, 1e-4), footprint: fp, seed: 15 });
        r = rock * v * 1.05;
        g = rock * v;
        b = rock * v * 0.92;
        a = rock;
      }
      if (rock < 1) {
        const density = fbm(x, w, { scale: 2.5, octaves: octavesDownTo(2.5, 5e-4), footprint: fp, seed: 13 });
        const threshold = -0.2 + (0.5 * (w - rockTop)) / 12;
        const leaf = smoothstep(threshold - 0.04, threshold + 0.04, density);
        const tone = 1 + 0.6 * fbm(x, w, { scale: 0.12, octaves: octavesDownTo(0.12, 1e-4), footprint: fp, seed: 14 });
        const k = (1 - rock) * leaf;
        r += k * 0.035 * tone;
        g += k * 0.06 * tone;
        b += k * 0.02 * tone;
        a += k;
      }
      out.r = r;
      out.g = g;
      out.b = b;
      out.a = a;
    },
  };
}

export interface WaterOptions {
  rippleAmplitude?: number;
  body?: readonly [number, number, number];
}

export interface WaterSurface {
  sample(groundX: number, groundZ: number, footprintX: number, footprintZ: number, out: RGBA): void;
}

/**
 * Rippled water reflecting the sky. A facet tilted by α towards the camera,
 * seen at depression δ = atan(H/Z), reflects the sky at elevation δ + 2α with
 * exact Fresnel reflectance at incidence cos θ = sin(δ + α); the water body
 * adds its upwelling radiance weighted by 1 − R. Ripple slopes are a
 * heuristic. Elongated footprints are integrated by sub-sampling along Z.
 */
export function createWaterSurface(cameraHeight: number, sky: SkyModel, options: WaterOptions = {}): WaterSurface {
  const amplitude = options.rippleAmplitude ?? RIPPLE_SLOPE;
  const body = options.body ?? WATER_BODY;
  const octaves = octavesDownTo(0.4, 1e-3);
  return {
    sample(groundX, groundZ, fpX, fpZ, out) {
      const steps = Math.min(Math.max(Math.ceil(fpZ / fpX), 1), 8);
      const footprint = Math.max(0.5 * fpX, fpZ / steps);
      let reflectance = 0;
      let reflected = 0;
      for (let i = 0; i < steps; i++) {
        const z = groundZ + ((i + 0.5) / steps - 0.5) * fpZ;
        const ripple = amplitude === 0 ? 0 : fbm(groundX * 0.5, z, { scale: 0.4, octaves, footprint, seed: 7 });
        const alpha = amplitude * ripple;
        const depression = Math.atan2(cameraHeight, z);
        const cosIncidence = Math.min(Math.max(Math.sin(depression + alpha), 1e-3), 1);
        const R = fresnelReflectance(cosIncidence, WATER_REFRACTIVE_INDEX);
        reflectance += R;
        reflected += R * skyRadianceFactor(sky, Math.max(depression + 2 * alpha, 0));
      }
      reflectance /= steps;
      reflected /= steps;
      out.r = reflected + (1 - reflectance) * body[0];
      out.g = reflected + (1 - reflectance) * body[1];
      out.b = reflected + (1 - reflectance) * body[2];
      out.a = 1;
    },
  };
}

function waterLayer(
  id: string,
  cameraHeight: number,
  near: number,
  far: number,
  occluderOnly: boolean,
  surface: WaterSurface,
  uniform: number | undefined,
): GroundLayer {
  return {
    kind: "ground",
    id,
    cameraHeight,
    nearDistance: near,
    farDistance: far,
    occluderOnly,
    sample(groundX, groundZ, fpX, fpZ, out) {
      if (uniform !== undefined) {
        out.r = out.g = out.b = uniform;
        out.a = 1;
        return;
      }
      surface.sample(groundX, groundZ, fpX, fpZ, out);
    },
  };
}

/**
 * Drawing order, back to front: all water out to the horizon, background,
 * the water just in front of the background's waterline (occluding its
 * blurred bottom edge), test card, duck, and the water just in front of the
 * duck. Wherever a nearer layer is partly transparent the same water lies
 * behind it, so seams cannot leak sky.
 */
export function createWildlifeStudio(options: StudioOptions): Scene {
  const waterY = -options.cameraHeight;
  const H = options.cameraHeight;
  const subject = options.subjectDistance;
  const background = Math.max(options.backgroundDistance, subject + 0.5);
  const near = Math.min(1.5, subject / 2);
  const uniform = options.validationRadiance;
  const surface = createWaterSurface(H, options.sky);

  const layers: SceneLayer[] = [
    waterLayer("water", H, near, 1e5, false, surface, uniform),
    createBackground(background, waterY, uniform),
    waterLayer("water-before-background", H, near, background, true, surface, uniform),
  ];
  if (options.showTarget) layers.push(createTarget(subject, waterY, uniform));
  layers.push(createDuck(subject, waterY, options.subjectSpeed, uniform));
  layers.push(waterLayer("water-before-duck", H, near, subject, true, surface, uniform));

  return {
    layers,
    sky: (elevation) => skyRadianceFactor(options.sky, elevation),
    aim: { x: 0, y: waterY + DUCK_AIM_HEIGHT, distance: subject },
  };
}
