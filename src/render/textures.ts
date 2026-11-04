/**
 * Band-limited procedural textures. Every function takes the sample
 * footprint and removes detail finer than it, which keeps aliasing of
 * texture far below what the optics resolve. The
 * reference prefilter is a tent of half-width `footprint` per axis; outlines
 * and sinusoids apply it exactly, fractal noise approximately.
 */
import { sincPi } from "./otf";

export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise in [-1, 1] with unit lattice spacing. */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const u = fade(x - ix);
  const v = fade(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return 2 * (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) - 1;
}

/** Weight of a feature of the given size under a box prefilter: 0 below the footprint, 1 above twice it. */
export function bandWeight(featureSize: number, footprint: number): number {
  return Math.min(Math.max(featureSize / footprint - 1, 0), 1);
}

export interface FbmOptions {
  scale: number;
  octaves: number;
  footprint: number;
  seed: number;
  gain?: number;
}

/**
 * Fractal noise in roughly [-1, 1]; octaves finer than the footprint are
 * replaced by their mean (0). The normalization covers all octaves, so
 * coarser sampling lowers contrast instead of rescaling it.
 */
const halfGainNorms = Float64Array.from({ length: 64 }, (_, octaves) => (1 - 0.5 ** octaves) / 0.5);

export function fbm(x: number, y: number, { scale, octaves, footprint, seed, gain = 0.5 }: FbmOptions): number {
  let sum = 0;
  let amplitude = 1;
  let size = scale;
  const norm = gain === 0.5 && Number.isInteger(octaves) && octaves < halfGainNorms.length
    ? halfGainNorms[octaves]!
    : gain === 1 ? octaves : (1 - gain ** octaves) / (1 - gain);
  for (let o = 0; o < octaves; o++) {
    const w = bandWeight(size, footprint);
    if (w === 0) break;
    sum += amplitude * w * valueNoise(x / size, y / size, seed + o * 101);
    amplitude *= gain;
    size /= 2;
  }
  return sum / norm;
}

/** Octave count that carries fBm detail from `scale` down to `finest`. */
export function octavesDownTo(scale: number, finest: number): number {
  return Math.max(1, Math.ceil(Math.log2(scale / finest)) + 1);
}

/**
 * Exact prefiltered sin(phase): the scene prefilter is a tent of half-width
 * `footprint` (box ⊗ box), whose transfer is sinc²(footprint / period).
 */
export function prefilteredSine(phase: number, period: number, footprint: number): number {
  return Math.sin(phase) * sincPi(footprint / period) ** 2;
}

/**
 * Exact tent-prefiltered unit step: coverage of the region u > 0 under a
 * triangle kernel of half-width 1, at signed position u (in footprints).
 */
export function tentStep(u: number): number {
  if (u <= -1) return 0;
  if (u >= 1) return 1;
  return u < 0 ? 0.5 * (1 + u) ** 2 : 1 - 0.5 * (1 - u) ** 2;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
