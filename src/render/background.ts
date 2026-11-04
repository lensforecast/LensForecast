/**
 * Shoreline backdrop on a plane at the background distance: tree crowns,
 * trunks and forest interior, shrubs, a grassy bank, boulders and reeds.
 * Shapes are prefiltered; shading uses each shape's approximate normal
 * (spheres for crowns and boulders, cylinders for trunks) under the same
 * sky as the subject. Albedos are representative (approximation).
 */
import { surfaceIrradianceFactor, type SkyModel, type Vector3 } from "../physics/exposure";
import { fbm, hash2, octavesDownTo, smoothstep, tentStep } from "./textures";
import type { PlaneLayer, RGBA } from "./types";

type Color = readonly [number, number, number];

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
  get done(): boolean {
    return this.remaining < 1e-4;
  }
  add(coverage: number, color: () => Color): void {
    if (coverage <= 0 || this.done) return;
    const [r, g, b] = color();
    const w = this.remaining * Math.min(coverage, 1);
    this.r += w * r;
    this.g += w * g;
    this.b += w * b;
    this.remaining *= 1 - Math.min(coverage, 1);
  }
  write(out: RGBA): void {
    out.r = this.r;
    out.g = this.g;
    out.b = this.b;
    out.a = 1 - this.remaining;
  }
}

const sphereNormal = (u: number, v: number): Vector3 => {
  const r2 = Math.min(u * u + v * v, 0.98);
  return { x: u, y: v, z: -Math.sqrt(1 - r2) };
};

const scale = (c: Color, k: number): Color => [c[0] * k, c[1] * k, c[2] * k];

export function createBackground(distance: number, waterY: number, sky: SkyModel): PlaneLayer {
  const stack = new ShapeStack();
  const lit = (n: Vector3): number => surfaceIrradianceFactor(sky, n);
  const bankLight = lit({ x: 0, y: 0.6, z: -0.8 });
  const reedLight = lit({ x: 0, y: 0.15, z: -0.99 });

  const bankTop = (x: number, fp: number): number =>
    0.3 + 0.18 * fbm(x, 0, { scale: 5, octaves: octavesDownTo(5, 0.05), footprint: fp, seed: 41 });
  const crownBase = (x: number, fp: number): number =>
    2.6 + 1.2 * fbm(x, 0, { scale: 9, octaves: octavesDownTo(9, 0.5), footprint: fp, seed: 42 });

  /**
   * Reed stands: many rows of blades, so the stand is nearly opaque low down
   * and thins toward ragged tips. Blades show as fine vertical streaks.
   */
  function reeds(x: number, w: number, fp: number): void {
    const clumpWidth = 1.6;
    const kc = Math.floor(x / clumpWidth);
    for (let k = kc - 1; k <= kc + 1 && !stack.done; k++) {
      if (hash2(k, 0, 51) > 0.55) continue;
      const centre = (k + 0.5 + 0.4 * (hash2(k, 1, 51) - 0.5)) * clumpWidth;
      const half = 0.3 + 0.6 * hash2(k, 2, 51);
      const height = 0.7 + 0.9 * hash2(k, 3, 51);
      if (Math.abs(x - centre) > 1.5 * half || w > height * 1.4 + fp) continue;
      // The stand fans out upward; blade tips make a spiky, uneven top.
      const spread = half * (0.55 + 0.6 * Math.min(Math.max(w / height, 0), 1));
      const across = Math.abs(x - centre) / spread;
      const spikes = Math.abs(fbm(x * 30, 0, { scale: 0.6, octaves: octavesDownTo(0.6, 1e-3), footprint: 30 * fp, seed: 53 }));
      const tips = height * (1 - 0.7 * across * across) * (0.75 + 0.6 * spikes);
      const sides = 1 - across + 0.25 * fbm(x * 12, w, { scale: 0.5, octaves: octavesDownTo(0.5, 2e-3), footprint: 12 * fp, seed: 55 });
      const shape = tentStep((sides * spread) / Math.max(fp, 0.005));
      const density = shape * tentStep((tips - w) / Math.max(fp, 0.005)) * (0.95 - 0.5 * smoothstep(0.3 * tips, tips, w));
      stack.add(density, () => {
        const streaks = fbm(x * 40, w, { scale: 0.4, octaves: octavesDownTo(0.4, 1e-3), footprint: 40 * fp, seed: 54 });
        const t = Math.min(Math.max(w / tips, 0), 1);
        const straw = 0.5 + 0.5 * streaks;
        const colour: Color = [0.07 + 0.13 * t * straw, 0.09 + 0.08 * t * straw, 0.03 + 0.04 * t * straw];
        return scale(colour, reedLight * (0.75 + 0.5 * streaks));
      });
    }
  }

  /** Shrubs along the shore in front of the forest: leafy clumps with sphere shading. */
  function shrubs(x: number, w: number, fp: number): void {
    const cell = 1.9;
    const kc = Math.floor(x / cell);
    for (let k = kc - 1; k <= kc + 1 && !stack.done; k++) {
      if (hash2(k, 0, 101) > 0.8) continue;
      const cx = (k + 0.5 + 0.6 * (hash2(k, 1, 101) - 0.5)) * cell;
      const rx = 0.7 + 0.9 * hash2(k, 2, 101);
      const ry = rx * (0.6 + 0.4 * hash2(k, 3, 101));
      const cy = 0.2 + 0.6 * ry;
      const u = (x - cx) / rx;
      const v = (w - cy) / ry;
      const radius = Math.hypot(u, v);
      if (radius > 1.3 + (2 * fp) / ry) continue;
      const ragged = 0.18 * fbm(x, w, { scale: 0.25, octaves: octavesDownTo(0.25, 5e-3), footprint: fp, seed: 102 });
      stack.add(tentStep(((1 + ragged - radius) * ry) / fp), () => {
        const leaves = fbm(x, w, { scale: 0.08, octaves: octavesDownTo(0.08, 1e-3), footprint: fp, seed: 103 });
        const hue = hash2(k, 4, 101);
        const colour: Color = [0.04 + 0.04 * hue, 0.08 + 0.03 * hue, 0.025];
        return scale(colour, lit(sphereNormal(u * 0.9, v * 0.9)) * Math.max(0.2, 0.8 + 0.6 * leaves));
      });
    }
  }

  function boulders(x: number, w: number, fp: number): void {
    const cell = 2.6;
    const kc = Math.floor(x / cell);
    for (let k = kc - 1; k <= kc + 1 && !stack.done; k++) {
      if (hash2(k, 0, 61) > 0.2) continue;
      const cx = (k + 0.2 + 0.6 * hash2(k, 1, 61)) * cell;
      const rx = 0.25 + 0.45 * hash2(k, 2, 61);
      const ry = rx * (0.35 + 0.25 * hash2(k, 3, 61));
      const cy = -ry * (0.1 + 0.3 * hash2(k, 4, 61));
      const u = (x - cx) / rx;
      const v = (w - cy) / ry;
      const r = Math.hypot(u, v);
      if (r > 1 + (2 * fp) / ry) continue;
      const gradient = r > 0 ? Math.hypot(u / rx, v / ry) / r : 1 / ry;
      const coverage = tentStep(-(r - 1) / gradient / fp);
      stack.add(coverage, () => {
        const tone = 0.8 + 0.4 * hash2(k, 5, 61);
        const mottle = 1 + 0.25 * fbm(x, w, { scale: 0.25, octaves: octavesDownTo(0.25, 2e-4), footprint: fp, seed: 62 });
        const lichen = smoothstep(0.25, 0.45, fbm(x, w, { scale: 0.12, octaves: octavesDownTo(0.12, 2e-3), footprint: fp, seed: 63 }));
        const base: Color = [0.1 * tone, 0.097 * tone, 0.09 * tone];
        const colour: Color = [base[0] + 0.04 * lichen, base[1] + 0.04 * lichen, base[2] - 0.02 * lichen];
        return scale(colour, mottle * lit(sphereNormal(u * 0.95, v * 0.95)));
      });
    }
  }

  function bank(x: number, w: number, fp: number): void {
    // Grass tufts make the top edge ragged at a few centimetres.
    const tufts = 0.06 * fbm(x * 8, 0, { scale: 0.4, octaves: octavesDownTo(0.4, 2e-3), footprint: 8 * fp, seed: 44 });
    const coverage = tentStep((bankTop(x, fp) + tufts - w) / fp);
    stack.add(coverage, () => {
      const grass = fbm(x * 3, w * 0.5, { scale: 0.05, octaves: octavesDownTo(0.05, 1e-3), footprint: fp, seed: 43 });
      const patches = fbm(x, w, { scale: 1.2, octaves: octavesDownTo(1.2, 0.05), footprint: fp, seed: 45 });
      const mud = smoothstep(0.12, 0, w);
      const dry = smoothstep(-0.2, 0.5, patches);
      const colour: Color = [0.045 + 0.04 * dry + 0.04 * mud, 0.06 + 0.02 * dry + 0.01 * mud, 0.025 + 0.01 * dry + 0.02 * mud];
      return scale(colour, bankLight * (1 + 0.4 * grass) * (0.75 + 0.25 * smoothstep(0, 0.25, w)));
    });
  }

  function trees(x: number, w: number, fp: number): void {
    // Two rows of crowns; the front row is drawn first.
    for (const [row, cell, seed] of [
      [0, 4.6, 71],
      [1, 5.3, 72],
    ] as const) {
      const kc = Math.floor(x / cell);
      for (let k = kc - 1; k <= kc + 1 && !stack.done; k++) {
        const r = 2.1 + 1.6 * hash2(k, 1, seed);
        const cx = (k + 0.5 + 0.5 * (hash2(k, 0, seed) - 0.5)) * cell;
        const cy = crownBase(cx, fp) + 1.2 * row + r * (0.75 + 0.6 * hash2(k, 2, seed));
        const rx = r;
        const ry = r * (1.05 + 0.25 * hash2(k, 3, seed));
        const u = (x - cx) / rx;
        const v = (w - cy) / ry;
        const radius = Math.hypot(u, v);
        const ragged = 0.16 * fbm(x, w, { scale: 0.9, octaves: octavesDownTo(0.9, 0.02), footprint: fp, seed: seed + 5 });
        if (radius > 1.35 + (2 * fp) / ry) continue;
        const edge = (radius - 1 - ragged) * ry;
        const leaves = smoothstep(-0.55, -0.2, fbm(x, w, { scale: 0.5, octaves: octavesDownTo(0.5, 0.01), footprint: fp, seed: seed + 6 }) + 0.45 * (1 - radius));
        stack.add(tentStep(-edge / fp) * leaves, () => {
          const clumps = fbm(x, w, { scale: 0.35, octaves: octavesDownTo(0.35, 3e-3), footprint: fp, seed: seed + 7 });
          const hue = hash2(k, 4, seed);
          const colour: Color = [0.035 + 0.025 * hue, 0.075 + 0.02 * hue, 0.03 - 0.01 * row];
          return scale(colour, lit(sphereNormal(u * 0.9, v * 0.9)) * Math.max(0.15, 0.75 + 0.7 * clumps));
        });
      }
    }
  }

  function trunks(x: number, w: number, fp: number): void {
    const cell = 3.1;
    const kc = Math.floor(x / cell);
    for (let k = kc - 1; k <= kc + 1 && !stack.done; k++) {
      if (hash2(k, 0, 81) > 0.45) continue;
      const cx = (k + hash2(k, 1, 81)) * cell;
      const half = 0.12 + 0.14 * hash2(k, 2, 81);
      const u = (x - cx) / half;
      if (Math.abs(u) > 1 + (2 * fp) / half) continue;
      stack.add(tentStep((half - Math.abs(x - cx)) / fp), () => {
        const bark = 1 + 0.3 * fbm(x * 4, w, { scale: 0.3, octaves: octavesDownTo(0.3, 2e-3), footprint: fp, seed: 82 });
        const uc = Math.max(-0.97, Math.min(0.97, u));
        return scale([0.045, 0.038, 0.03], bark * lit({ x: uc, y: 0, z: -Math.sqrt(1 - uc * uc) }));
      });
    }
  }

  function interior(x: number, w: number, fp: number): void {
    const top = crownBase(x, fp) + 1.5;
    stack.add(tentStep((top - w) / fp), () => {
      const depth = fbm(x, w, { scale: 0.8, octaves: octavesDownTo(0.8, 0.01), footprint: fp, seed: 91 });
      return [0.018 + 0.008 * depth, 0.028 + 0.012 * depth, 0.014 + 0.005 * depth];
    });
  }

  return {
    kind: "plane",
    id: "background",
    distance,
    bounds: { minX: -0.4 * distance, maxX: 0.4 * distance, minY: waterY - 0.05, maxY: waterY + 0.5 * distance },
    sample(x, y, fp, out) {
      const w = y - waterY;
      stack.reset();
      reeds(x, w, fp);
      boulders(x, w, fp);
      bank(x, w, fp);
      shrubs(x, w, fp);
      trunks(x, w, fp);
      trees(x, w, fp);
      interior(x, w, fp);
      stack.write(out);
    },
  };
}

/** ISO 12233-style slanted-edge chart (5°) on a wooden stake standing in the water beside the duck. */
export function createTestChart(distance: number, waterY: number, sky: SkyModel): PlaneLayer {
  const cx = -0.55;
  const cy = waterY + 0.48;
  const half = 0.16;
  const tilt = (5 * Math.PI) / 180;
  const front = surfaceIrradianceFactor(sky, { x: 0, y: 0, z: -1 });
  const stack = new ShapeStack();
  return {
    kind: "plane",
    id: "target",
    distance,
    bounds: { minX: cx - half - 0.02, maxX: cx + half + 0.02, minY: waterY - 0.05, maxY: cy + half + 0.02 },
    sample(x, y, fp, out) {
      stack.reset();
      const inside = (h: number) => tentStep((h - Math.abs(x - cx)) / fp) * tentStep((h - Math.abs(y - cy)) / fp);
      const square = (h: number) => {
        const u = (x - cx) * Math.cos(tilt) + (y - cy) * Math.sin(tilt);
        const v = -(x - cx) * Math.sin(tilt) + (y - cy) * Math.cos(tilt);
        return tentStep((h - Math.abs(u)) / fp) * tentStep((h - Math.abs(v)) / fp);
      };
      stack.add(square(0.07), () => scale([0.04, 0.04, 0.04], front));
      stack.add(inside(half - 0.012), () => scale([0.78, 0.78, 0.76], front));
      stack.add(inside(half), () => scale([0.05, 0.05, 0.05], front));
      const stake = tentStep((0.02 - Math.abs(x - cx)) / fp) * tentStep((cy - y) / fp);
      stack.add(stake, () => {
        const grain = 1 + 0.25 * fbm(x * 20, y, { scale: 0.05, octaves: octavesDownTo(0.05, 1e-4), footprint: fp, seed: 95 });
        return scale([0.2, 0.14, 0.09], grain * front);
      });
      stack.write(out);
    },
  };
}
