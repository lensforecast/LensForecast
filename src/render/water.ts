/**
 * Water as a mirror. For a flat surface the reflection of an object at
 * distance D is a virtual image at the same distance D, mirrored about the
 * water level, so reflections are rendered as mirrored layers that blur
 * exactly like the objects they show. The surface itself is a screen in
 * front of them: opacity 1 − R (Fresnel) with the water body's upwelling
 * colour. Ripples tilt the facets: they modulate R and displace the
 * reflected rays (heuristic slopes, first-order geometry).
 */
import type { Vector3 } from "../physics/exposure";
import { fresnelReflectance, WATER_REFRACTIVE_INDEX } from "../physics/reflection";
import { fbm, octavesDownTo, tentStep } from "./textures";
import type { GroundLayer, PlaneLayer, RGBA } from "./types";

/** RMS-scale water surface slope in radians (heuristic: light air, nearly calm). */
export const RIPPLE_SLOPE = 0.012;
/** Upwelling radiance factor of a fairly clear, greenish pond (approximation). */
export const WATER_BODY: readonly [number, number, number] = [0.018, 0.026, 0.02];

export interface WaterOptions {
  rippleAmplitude?: number;
  body?: readonly [number, number, number];
}

export interface WaterSurface {
  cameraHeight: number;
  body: readonly [number, number, number];
  /** Facet slopes at a ground point: toward the camera (sz) and sideways (sx), radians. */
  slope(groundX: number, groundZ: number, footprint: number): { sz: number; sx: number };
  /** The slope toward the camera alone. */
  slopeZ(groundX: number, groundZ: number, footprint: number): number;
  /** Fresnel reflectance of a facet seen at depression δ with slope sz toward the camera. */
  reflectance(depression: number, sz: number): number;
  /**
   * The surface as a screen over the mirrored scene: coverage 1 − R̄ and
   * premultiplied colour (1 − R̄)·body, R̄ averaged over the footprint.
   */
  sample(groundX: number, groundZ: number, footprintX: number, footprintZ: number, out: RGBA): void;
}

export function createWaterSurface(cameraHeight: number, options: WaterOptions = {}): WaterSurface {
  const amplitude = options.rippleAmplitude ?? RIPPLE_SLOPE;
  const body = options.body ?? WATER_BODY;
  const octaves = octavesDownTo(0.4, 1e-3);
  const slopeZ = (x: number, z: number, footprint: number) =>
    amplitude === 0 ? 0 : amplitude * fbm(x * 0.5, z, { scale: 0.4, octaves, footprint, seed: 7 });
  const slope = (x: number, z: number, footprint: number) =>
    amplitude === 0
      ? { sz: 0, sx: 0 }
      : { sz: slopeZ(x, z, footprint), sx: 0.5 * amplitude * fbm(x * 0.5, z, { scale: 0.4, octaves, footprint, seed: 8 }) };
  // Facets tilted away from the camera (δ + α < 0) are not masked by the crests in front (heuristic).
  const reflectance = (depression: number, sz: number) =>
    fresnelReflectance(Math.min(Math.max(Math.sin(depression + sz), 1e-3), 1), WATER_REFRACTIVE_INDEX);
  return {
    cameraHeight,
    body,
    slope,
    slopeZ,
    reflectance,
    sample(groundX, groundZ, fpX, fpZ, out) {
      const steps = Math.min(Math.max(Math.ceil(fpZ / fpX), 1), 8);
      const footprint = Math.max(0.5 * fpX, fpZ / steps);
      let R = 0;
      for (let i = 0; i < steps; i++) {
        const z = groundZ + ((i + 0.5) / steps - 0.5) * fpZ;
        R += reflectance(Math.atan2(cameraHeight, z), slopeZ(groundX, z, footprint));
      }
      const t = 1 - R / steps;
      out.r = t * body[0];
      out.g = t * body[1];
      out.b = t * body[2];
      out.a = t;
    },
  };
}

export function waterLayer(id: string, surface: WaterSurface, near: number, far: number, uniform?: number): GroundLayer {
  return {
    kind: "ground",
    id,
    cameraHeight: surface.cameraHeight,
    nearDistance: near,
    farDistance: far,
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

/** A camera ray through point (X, Y) of the plane at distance `distance`, reflected by the water. */
export interface Reflection {
  /** Water point hit by the camera ray. */
  point: Vector3;
  /** Reflected direction (unnormalized, z = 1). */
  direction: Vector3;
  /** Depression of the camera ray at the water point. */
  depression: number;
  reflectance: number;
  /** Extra footprint on a surface at `lever` meters past the water point, from ripple distortion. */
  spread: (lever: number) => number;
}

export function reflectCameraRay(water: WaterSurface, X: number, Y: number, distance: number, footprint: number): Reflection | null {
  const H = water.cameraHeight;
  if (Y >= -H * 1e-9) return null;
  const Zw = (distance * H) / -Y;
  const Xw = (X * Zw) / distance;
  const fpZ = (footprint * Zw * Zw) / (H * distance);
  const fpX = (footprint * Zw) / distance;
  const rippleFootprint = Math.max(fpX, fpZ);
  const { sz, sx } = water.slope(Xw, Zw, rippleFootprint);
  const dz = water.slopeZ(Xw, Zw + fpZ / 2, rippleFootprint) - water.slopeZ(Xw, Zw - fpZ / 2, rippleFootprint);
  const depression = Math.atan2(H, Zw);
  return {
    point: { x: Xw, y: -H, z: Zw },
    direction: { x: Xw / Zw + 2 * sx, y: H / Zw + 2 * sz, z: 1 },
    depression,
    reflectance: water.reflectance(depression, sz),
    spread: (lever) => 2 * Math.abs(dz) * lever,
  };
}

/** Elevation angle of a direction. */
export const elevationOf = (d: Vector3): number => Math.atan2(d.y, Math.hypot(d.x, d.z));

/**
 * The virtual image of a plane layer in the water: a layer at the same
 * distance showing the plane's content along reflected rays. Transparent
 * where the plane is, so the mirrored sky shows through.
 */
export function mirroredPlane(real: PlaneLayer, water: WaterSurface): PlaneLayer {
  const H = water.cameraHeight;
  const D = real.distance;
  const height = real.bounds.maxY + H;
  return {
    kind: "plane",
    id: `${real.id}-reflection`,
    distance: D,
    bounds: { minX: real.bounds.minX - 0.1 * height, maxX: real.bounds.maxX + 0.1 * height, minY: -H - 1.3 * height, maxY: -H },
    ...(real.velocity ? { velocity: { x: real.velocity.x, y: -real.velocity.y } } : {}),
    sample(X, Y, fp, out) {
      const reflection = reflectCameraRay(water, X, Y, D, fp);
      if (!reflection) {
        out.r = out.g = out.b = out.a = 0;
        return;
      }
      const { point, direction, spread } = reflection;
      const lever = D - point.z;
      real.sample(point.x + direction.x * lever, Math.max(point.y + direction.y * lever, -H), fp + spread(lever), out);
    },
  };
}

/**
 * A plane standing in the water: above the waterline its own content; below
 * it, wherever the plane meets the water, the water in front of it, opaque,
 * showing the plane's reflection over
 * whatever the reflected ray meets beyond it (`behind`, by default the sky).
 * Plane and reflection share one distance, so their contact line blurs as
 * one surface. The renderer keeps the part below the waterline only within
 * blur reach, where the water's own depth differs little from the plane's.
 */
export function standingPlane(
  real: PlaneLayer,
  water: WaterSurface,
  sky: (elevation: number) => number,
  behind?: (origin: Vector3, direction: Vector3, footprint: number, out: RGBA) => void,
): PlaneLayer {
  const H = water.cameraHeight;
  const D = real.distance;
  const above: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  const mirror: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  const beyond: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  const contact: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  return {
    ...real,
    contactY: -H,
    bounds: { ...real.bounds, minY: -H - D },
    sample(X, Y, fp, out) {
      const t = tentStep((Y + H) / fp);
      if (t > 0) real.sample(X, Math.max(Y, -H + 1e-9), fp, above);
      if (t === 1) {
        out.r = above.r;
        out.g = above.g;
        out.b = above.b;
        out.a = above.a;
        return;
      }
      if (Y >= -H || t === 0) real.sample(X, -H + 1e-9, fp, contact);
      else contact.a = above.a;
      const reflection = reflectCameraRay(water, X, Math.min(Y, -H * (1 + 1e-9)), D, fp);
      let r = 0;
      let g = 0;
      let b = 0;
      if (reflection && contact.a > 0) {
        const { point, direction, spread, reflectance } = reflection;
        const lever = D - point.z;
        real.sample(point.x + direction.x * lever, Math.max(point.y + direction.y * lever, -H), fp + spread(lever), mirror);
        let br: number;
        let bg: number;
        let bb: number;
        if (behind) {
          behind(point, direction, fp + spread(lever), beyond);
          br = beyond.r;
          bg = beyond.g;
          bb = beyond.b;
        } else {
          br = bg = bb = sky(elevationOf(direction));
        }
        const rest = 1 - mirror.a;
        r = contact.a * ((1 - reflectance) * water.body[0] + reflectance * (mirror.r + rest * br));
        g = contact.a * ((1 - reflectance) * water.body[1] + reflectance * (mirror.g + rest * bg));
        b = contact.a * ((1 - reflectance) * water.body[2] + reflectance * (mirror.b + rest * bb));
      }
      out.r = t * above.r + (1 - t) * r;
      out.g = t * above.g + (1 - t) * g;
      out.b = t * above.b + (1 - t) * b;
      out.a = t * above.a + (1 - t) * contact.a;
    },
  };
}
