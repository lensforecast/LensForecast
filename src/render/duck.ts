/**
 * A drake mallard built from ellipsoids and ray-traced, so every point has
 * its true perspective position and depth (blurred by its own blur circle)
 * and a true surface normal (shaded by the sky and sun it faces).
 * Plumage colours are representative albedos (approximation).
 */
import { skyRadianceFactor, surfaceIrradianceFactor, type SkyModel, type Vector3 } from "../physics/exposure";
import { fresnelReflectance } from "../physics/reflection";
import { fbm, hash2, octavesDownTo, prefilteredSine, smoothstep, tentStep } from "./textures";
import type { PlaneLayer, RGBA } from "./types";
import { elevationOf, reflectCameraRay, type WaterSurface } from "./water";

/** Refractive index of the cornea. */
const CORNEA_INDEX = 1.376;

type Part = "body" | "breast" | "rump" | "tail" | "curl" | "neck" | "head" | "bill" | "eye";

interface Ellipsoid {
  part: Part;
  /** Centre in duck coordinates: x forward, y above the water, z away from the camera. */
  c: Vector3;
  a: Vector3;
  /** Rotation about the z axis (nose up), radians. */
  tilt: number;
}

const PARTS: readonly Ellipsoid[] = [
  { part: "eye", c: { x: 0.183, y: 0.245, z: -0.0345 }, a: { x: 0.0045, y: 0.0045, z: 0.0045 }, tilt: 0 },
  { part: "bill", c: { x: 0.232, y: 0.218, z: 0 }, a: { x: 0.042, y: 0.011, z: 0.02 }, tilt: -0.25 },
  { part: "head", c: { x: 0.165, y: 0.235, z: 0 }, a: { x: 0.055, y: 0.042, z: 0.04 }, tilt: 0.1 },
  { part: "neck", c: { x: 0.15, y: 0.165, z: 0 }, a: { x: 0.034, y: 0.07, z: 0.034 }, tilt: -0.15 },
  { part: "curl", c: { x: -0.2, y: 0.13, z: 0 }, a: { x: 0.012, y: 0.012, z: 0.008 }, tilt: 0 },
  { part: "breast", c: { x: 0.12, y: 0.075, z: 0 }, a: { x: 0.085, y: 0.08, z: 0.085 }, tilt: 0 },
  { part: "tail", c: { x: -0.235, y: 0.105, z: 0 }, a: { x: 0.05, y: 0.02, z: 0.035 }, tilt: 0.45 },
  { part: "rump", c: { x: -0.15, y: 0.07, z: 0 }, a: { x: 0.1, y: 0.06, z: 0.07 }, tilt: 0.25 },
  { part: "body", c: { x: 0, y: 0.045, z: 0 }, a: { x: 0.19, y: 0.085, z: 0.095 }, tilt: 0 },
];

/** Body cross-section at the waterline: the hull the water in front of the duck meets. */
const HULL = (() => {
  const body = PARTS.find((p) => p.part === "body")!;
  const k = Math.sqrt(1 - (body.c.y / body.a.y) ** 2);
  return { halfLength: body.a.x * k, halfDepth: body.a.z * k };
})();

/** Head centre in duck coordinates; detail crops centre here. */
export const DUCK_HEAD = PARTS.find((p) => p.part === "head")!.c;
export const DUCK_DEPTH = { near: -0.1, far: 0.1 } as const;

interface Hit {
  part: Part;
  /** Ray parameter of the surface point (hit, or closest approach for grazing rays). */
  t: number;
  coverage: number;
  point: Vector3;
  normal: Vector3;
}

const GREEN: readonly [number, number, number] = [0.012, 0.07, 0.03];
const CHESTNUT: readonly [number, number, number] = [0.21, 0.08, 0.045];
const BLACK: readonly [number, number, number] = [0.018, 0.018, 0.022];

/**
 * Scalloped feather cells with a central shaft, barbs and barbules over
 * seven octaves down to barbPeriod·4/64 (≈ 12–20 µm), and mottling down to
 * 10 µm, so close-up resolution comparisons are never limited by the scene.
 */
const BARB_SCALES = [
  [1, 0.18],
  [2, 0.14],
  [4, 0.1],
  [8, 0.08],
  [16, 0.06],
  [32, 0.05],
  [64, 0.04],
] as const;

function feathers(u0: number, w0: number, footprint: number, cellW: number, cellH: number, barbPeriod: number, seed: number): number {
  // Warp the cell lattice by about one cell so rows wander like real feather tracts.
  const warpScale = 4 * cellW;
  const warpOctaves = octavesDownTo(warpScale, Math.max(footprint, cellW / 2));
  const u = u0 + 0.8 * cellW * fbm(u0, w0, { scale: warpScale, octaves: warpOctaves, footprint, seed: seed + 2 });
  const w = w0 + 0.8 * cellH * fbm(u0, w0, { scale: warpScale, octaves: warpOctaves, footprint, seed: seed + 3 });
  const row = Math.floor(w / cellH);
  const offset = row & 1 ? cellW / 2 : 0;
  const col = Math.floor((u + offset) / cellW);
  const lu = (u + offset) / cellW - col;
  const lw = w / cellH - row;
  const across = 2 * lu - 1;
  const scallop = lw - 0.35 * (1 - across * across);
  const edgeWidth = Math.max(0.15, footprint / cellH);
  const edge = 0.8 + 0.2 * smoothstep(-edgeWidth, edgeWidth, scallop);
  const shaftWidth = Math.max(0.04, footprint / cellW);
  const shaft = 1 - 0.2 * (1 - smoothstep(0, shaftWidth, Math.abs(across)));
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

/** Band coverage of lo < v < hi, prefiltered. */
const band = (v: number, lo: number, hi: number, fp: number): number => tentStep((v - lo) / fp) - tentStep((v - hi) / fp);
const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [
  a[0]! + (b[0]! - a[0]!) * t,
  a[1]! + (b[1]! - a[1]!) * t,
  a[2]! + (b[2]! - a[2]!) * t,
];

/** Albedo of the plumage at a duck-coordinate point. */
function albedo(part: Part, p: Vector3, n: Vector3, fp: number): [number, number, number] {
  switch (part) {
    case "eye": {
      // Dark brown iris around a black pupil facing sideways (toward the camera).
      const pupil = tentStep((-n.z - 0.93) / Math.max(fp / 0.0045, 0.02));
      return mix([0.025, 0.013, 0.006], [0.004, 0.004, 0.004], pupil);
    }
    case "bill": {
      const nail = tentStep((p.x - 0.262) / fp);
      const nostril = Math.max(0, 1 - Math.hypot(p.x - 0.214, p.y - 0.224) / 0.003);
      const base: [number, number, number] = [0.46, 0.39, 0.065];
      const tone = 1 + 0.08 * fbm(p.x, p.y, { scale: 0.01, octaves: octavesDownTo(0.01, 1e-4), footprint: fp, seed: 31 });
      return mix(base.map((v) => v * tone), [0.03, 0.03, 0.02], Math.min(1, nail + nostril));
    }
    case "head": {
      // Structural colour shifts toward blue-violet at grazing view (heuristic).
      const sheen = 0.6 * (1 - Math.abs(n.z)) ** 2;
      const tex = 0.5 + 0.5 * feathers(p.x, p.y, fp, 0.004, 0.003, 0.0002, 21);
      return mix(GREEN, [0.03, 0.03, 0.09], sheen).map((v) => v * tex) as [number, number, number];
    }
    case "neck": {
      const ring = band(p.y, 0.135, 0.147, fp);
      const upper = tentStep((p.y - 0.152) / fp);
      const tex = feathers(p.x, p.y, fp, 0.005, 0.0035, 0.00025, 22);
      const base = mix(CHESTNUT, GREEN, upper);
      return mix(base, [0.72, 0.72, 0.7], ring).map((v) => v * tex) as [number, number, number];
    }
    case "breast": {
      const tex = feathers(p.x, p.y, fp, 0.012, 0.008, 0.0003, 23);
      return CHESTNUT.map((v) => v * tex) as [number, number, number];
    }
    case "rump":
    case "curl":
      return BLACK.map((v) => v * feathers(p.x, p.y + p.z, fp, 0.012, 0.008, 0.0003, 24)) as [number, number, number];
    case "tail": {
      const tex = feathers(p.x, p.y + p.z, fp, 0.01, 0.025, 0.0003, 25);
      return mix([0.5, 0.5, 0.48], BLACK, tentStep((p.x + 0.205) / fp)).map((v) => v * tex) as [number, number, number];
    }
    case "body": {
      // Vermiculated grey flank: fine wavy dark lines, period 1.6 mm.
      const wave = p.y + 0.0012 * Math.sin((2 * Math.PI * p.x) / 0.009);
      const vermiculation = 1 + 0.22 * prefilteredSine((2 * Math.PI * wave) / 0.0016, 0.0016, fp);
      const flankTex = feathers(p.x, p.y + p.z, fp, 0.02, 0.013, 0.0003, 26);
      let color = [0.31, 0.305, 0.29].map((v) => v * vermiculation * (0.6 + 0.4 * flankTex)) as [number, number, number];
      // Brown-grey tertials and back above the flank line.
      const wingLine = 0.085 + 0.01 * Math.sin((2 * Math.PI * p.x) / 0.18);
      const wing = tentStep((p.y - wingLine) / fp) * band(p.x, -0.15, 0.09, fp);
      const tertials = feathers(p.x, p.y, fp, 0.03, 0.02, 0.0003, 27);
      color = mix(color, [0.3, 0.26, 0.2].map((v) => v * tertials), wing);
      // Speculum: iridescent blue-violet patch bordered by white bars.
      const spec = band(p.x, -0.118, -0.062, fp) * band(p.y, wingLine + 0.002, wingLine + 0.016, fp);
      const bars = (band(p.x, -0.124, -0.118, fp) + band(p.x, -0.062, -0.056, fp)) * band(p.y, wingLine + 0.002, wingLine + 0.016, fp);
      color = mix(color, [0.05, 0.07, 0.3], spec);
      color = mix(color, [0.75, 0.75, 0.73], bars);
      color = mix(color, CHESTNUT, smoothstep(0.1, 0.15, p.x) * tentStep((p.y - 0.04) / fp));
      color = mix(color, BLACK, smoothstep(-0.12, -0.15, p.x));
      return color;
    }
  }
}

function rotate(v: Vector3, angle: number): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
}

export interface DuckOptions {
  distance: number;
  cameraHeight: number;
  speed: number;
  sky: SkyModel;
  water: WaterSurface;
  /** What a reflected ray meets beyond the duck (background, then sky). */
  behind: (origin: Vector3, direction: Vector3, footprint: number, out: RGBA) => void;
  uniform?: number;
}

export interface Duck {
  real: PlaneLayer;
  reflection: PlaneLayer;
}

export function createDuck(options: DuckOptions): Duck {
  const { distance: s, cameraHeight: H, sky, water, uniform } = options;
  const skyAt = (e: number): number => skyRadianceFactor(sky, Math.abs(e));
  const origin = { x: 0, y: -H, z: s };

  /**
   * Front-to-back composite of the ellipsoids along a ray, each with
   * prefiltered silhouette coverage. `footprint` is the tent half-width on
   * the reference plane; `clipWater` hides points below the water plane.
   */
  const trace = (o: Vector3, d: Vector3, footprint: number, clipWater: boolean, out: RGBA): void => {
    const hits: Hit[] = [];
    for (const e of PARTS) {
      const ox = o.x - origin.x - e.c.x;
      const oy = o.y - origin.y - e.c.y;
      const oz = o.z - origin.z - e.c.z;
      const lo = rotate({ x: ox, y: oy, z: oz }, -e.tilt);
      const ld = rotate(d, -e.tilt);
      const ax = lo.x / e.a.x;
      const ay = lo.y / e.a.y;
      const az = lo.z / e.a.z;
      const bx = ld.x / e.a.x;
      const by = ld.y / e.a.y;
      const bz = ld.z / e.a.z;
      const bb = bx * bx + by * by + bz * bz;
      const ab = ax * bx + ay * by + az * bz;
      const aa = ax * ax + ay * ay + az * az;
      const tc = -ab / bb;
      const dist = Math.sqrt(Math.max(aa - (ab * ab) / bb, 0));
      // Footprint in the ellipsoid's own units at its depth.
      const depth = o.z + tc * d.z;
      const fpWorld = (footprint * depth) / s;
      const minAxis = Math.min(e.a.x, e.a.y, e.a.z);
      const maxAxis = Math.max(e.a.x, e.a.y);
      if (dist > 1 + (2 * fpWorld) / minAxis) continue;
      const disc = 1 - dist * dist;
      const t = disc > 0 ? tc - Math.sqrt(disc / bb) : tc;
      if (t <= 0) continue;
      const qx = ax + t * bx;
      const qy = ay + t * by;
      const qz = az + t * bz;
      const qn = Math.hypot(qx, qy, qz) || 1;
      const ln = { x: qx / qn / e.a.x, y: qy / qn / e.a.y, z: qz / qn / e.a.z };
      const n = rotate(ln, e.tilt);
      const nn = Math.hypot(n.x, n.y, n.z);
      const point = { x: o.x + t * d.x, y: o.y + t * d.y, z: o.z + t * d.z };
      // Signed distance to the silhouette, converted to reference-plane units.
      const sd = ((dist - 1) * (dist > 1 ? maxAxis : minAxis) * s) / depth;
      let coverage = tentStep(-sd / footprint);
      if (clipWater) coverage *= tentStep((point.y + H) / fpWorld);
      if (coverage <= 0) continue;
      hits.push({ part: e.part, t, coverage, point, normal: { x: n.x / nn, y: n.y / nn, z: n.z / nn } });
    }
    hits.sort((a, b) => a.t - b.t);
    let r = 0;
    let g = 0;
    let b = 0;
    let remaining = 1;
    let depthSum = 0;
    let depthWeight = 0;
    for (const hit of hits) {
      const w = remaining * hit.coverage;
      depthSum += w * (hit.point.z - s);
      depthWeight += w;
      if (uniform !== undefined) {
        r += w * uniform;
        g += w * uniform;
        b += w * uniform;
      } else {
        const local = { x: hit.point.x - origin.x, y: hit.point.y - origin.y, z: hit.point.z - origin.z };
        const fpWorld = (footprint * hit.point.z) / s;
        const [ar, ag, ab] = albedo(hit.part, local, hit.normal, fpWorld);
        const irradiance = surfaceIrradianceFactor(sky, hit.normal);
        let specular = 0;
        if (hit.part === "eye") {
          const dn = Math.hypot(d.x, d.y, d.z);
          const cosI = -(d.x * hit.normal.x + d.y * hit.normal.y + d.z * hit.normal.z) / dn;
          const rd = {
            x: d.x / dn + 2 * cosI * hit.normal.x,
            y: d.y / dn + 2 * cosI * hit.normal.y,
            z: d.z / dn + 2 * cosI * hit.normal.z,
          };
          const e = elevationOf(rd);
          const seen = e >= 0 ? skyAt(e) : water.reflectance(-e, 0) * skyAt(e);
          specular = fresnelReflectance(Math.max(cosI, 0), CORNEA_INDEX) * seen;
        }
        r += w * (ar * irradiance + specular);
        g += w * (ag * irradiance + specular);
        b += w * (ab * irradiance + specular);
      }
      remaining *= 1 - hit.coverage;
      if (remaining < 1e-4) break;
    }
    out.r = r;
    out.g = g;
    out.b = b;
    out.a = 1 - remaining;
    out.z = depthWeight > 0 ? Math.min(Math.max(depthSum / depthWeight, DUCK_DEPTH.near), DUCK_DEPTH.far) : 0;
  };

  /** Reference-plane height of the hull's near waterline at X. */
  const waterlineY = (X: number): number => {
    const u = Math.min(Math.abs(X - origin.x) / HULL.halfLength, 1);
    return (-H * s) / (s - HULL.halfDepth * Math.sqrt(1 - u * u));
  };

  const reflected: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  const beyond: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  const top = -H + 0.3;

  const real: PlaneLayer = {
    kind: "plane",
    id: "duck",
    distance: s,
    bounds: { minX: -0.3, maxX: 0.3, minY: -H - s, maxY: top },
    velocity: { x: options.speed, y: 0 },
    contactY: (-H * s) / (s - HULL.halfDepth),
    relief: DUCK_DEPTH,
    sample(X, Y, fp, out) {
      trace({ x: 0, y: 0, z: 0 }, { x: X / s, y: Y / s, z: 1 }, fp, true, out);
      // Water in front of the submerged hull, showing the reflection.
      const hull = tentStep((HULL.halfLength - Math.abs(X - origin.x)) / fp) * tentStep((waterlineY(X) - Y) / fp);
      const open = (1 - out.a) * hull;
      if (open <= 0) return;
      const duckZ = out.z ?? 0;
      let r: number;
      let g: number;
      let b: number;
      let z: number = DUCK_DEPTH.near;
      if (uniform !== undefined) {
        r = g = b = uniform;
      } else {
        const reflection = reflectCameraRay(water, X, Math.min(Y, -H * (1 + 1e-9)), s, fp);
        if (!reflection) return;
        const { point, direction, reflectance, spread } = reflection;
        const lever = s - point.z;
        trace(point, direction, fp + spread(lever), false, reflected);
        options.behind(point, direction, fp + spread(lever), beyond);
        const rest = 1 - reflected.a;
        r = (1 - reflectance) * water.body[0] + reflectance * (reflected.r + rest * beyond.r);
        g = (1 - reflectance) * water.body[1] + reflectance * (reflected.g + rest * beyond.g);
        b = (1 - reflectance) * water.body[2] + reflectance * (reflected.b + rest * beyond.b);
        if (reflected.a > 0) z = reflected.z ?? z;
      }
      out.r += open * r;
      out.g += open * g;
      out.b += open * b;
      out.z = out.a >= open ? duckZ : z;
      out.a += open;
    },
  };

  const reflection: PlaneLayer = {
    kind: "plane",
    id: "duck-reflection",
    distance: s,
    bounds: { minX: -0.35, maxX: 0.35, minY: -H - 0.45, maxY: -H },
    velocity: { x: options.speed, y: 0 },
    relief: DUCK_DEPTH,
    sample(X, Y, fp, out) {
      out.z = 0;
      const reflected = reflectCameraRay(water, X, Y, s, fp);
      if (!reflected || uniform !== undefined) {
        out.r = out.g = out.b = out.a = 0;
        return;
      }
      trace(reflected.point, reflected.direction, fp + reflected.spread(s - reflected.point.z), false, out);
    },
  };

  return { real, reflection };
}
