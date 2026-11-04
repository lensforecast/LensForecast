/**
 * Image formation: layered geometric optics (defocus, motion), wave optics
 * (defocused-pupil OTF and diffraction per colour band), pixel integration,
 * relative illumination, exposure and sensor noise.
 *
 * Every blur is applied as an analytic OTF in the frequency domain on grids
 * padded with real scene content, so circular wrap-around stays outside the
 * output except for the faint Airy tail beyond the diffraction margin.
 */
import { COLOR_BANDS, defocusedOtf, diffractionMtf } from "../physics/diffraction";
import { sensorExposure } from "../physics/exposure";
import { blurCircleDiameter, imageDistance, workingFNumber } from "../physics/optics";
import { mulberry32, poisson, standardNormal } from "../physics/random";
import {
  electronsAtWhite,
  FULL_FRAME,
  fullWellCapacity,
  GENERIC_SENSOR,
  meanElectrons,
  pixelPitch,
  type SensorFormat,
  type SensorModel,
} from "../physics/sensor";
import { fft1d, fft2d, nextFftSize, spatialFrequency } from "./fft";
import { boxOtf, lineOtf, sincPi } from "./otf";
import { tentStep } from "./textures";
import type { GroundLayer, PlaneLayer, RGBA, Scene, ShotSettings, ViewSpec } from "./types";

/** Diffraction margin in units of λN; the Airy pattern carries ≈ 1% of its energy beyond this radius. */
const DIFFRACTION_MARGIN = 16;
/** Spread of the defocus/diffraction ratio kernel, in units of λN, added around blurred layers. */
const RATIO_KERNEL_MARGIN = 4;
/** Coarse layer grids keep at least this many samples across the blur circle. */
const SAMPLES_PER_BLUR = 12;
/** Ground depth slices: blur-circle step relative to the slice's own blur, and at least half an output pixel. */
const SLICE_STEP = 0.15;
/** Rows beyond the grid considered for ground blur, in grid heights. */
const GROUND_REACH_LIMIT = 8;
const LONGEST_WAVELENGTH = COLOR_BANDS.red[COLOR_BANDS.red.length - 1]!;
const SHORTEST_WAVELENGTH = COLOR_BANDS.blue[0]!;
const TABLE_SIZE = 256;
const BANDS = [COLOR_BANDS.red, COLOR_BANDS.green, COLOR_BANDS.blue] as const;

export interface OpticalImage {
  width: number;
  height: number;
  /** Radiance factor reaching each output pixel, per channel, row-major from the top. */
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  sensorPitch: number;
  outputPixelSize: number;
  /** Sensor pixels combined into one output pixel: (outputPixelSize / pitch)². */
  binning: number;
  grid: { width: number; height: number; oversample: number };
}

interface FineGrid {
  gx: number;
  gy: number;
  h: number;
  x: (column: number) => number;
  y: (row: number) => number;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
}

interface Optics {
  focalLength: number;
  fNumber: number;
  focusDistance: number;
  imageDistance: number;
  aperture: number;
  workingFNumber: number;
  shutterTime: number;
  shiftX: number;
  shiftY: number;
}

interface Context {
  grid: FineGrid;
  optics: Optics;
  outputPixel: number;
  /** Fine columns between the grid edge and the first or last output sample. */
  marginColumns: number;
  tables: Map<string, RadialTables>;
}

/** Per-channel radial transfer functions sampled on [0, maxFrequency]. */
interface RadialTables {
  step: number;
  channels: [Float64Array, Float64Array, Float64Array];
}

function lookup(table: Float64Array, step: number, rho: number): number {
  const t = rho / step;
  const i = Math.floor(t);
  if (i >= table.length - 1) return table[table.length - 1]!;
  const f = t - i;
  return table[i]! * (1 - f) + table[i + 1]! * f;
}

function radialTables(maxFrequency: number, evaluate: (rho: number, band: readonly number[]) => number): RadialTables {
  const step = maxFrequency / (TABLE_SIZE - 1);
  const channels = BANDS.map((band) => {
    const table = new Float64Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE; i++) table[i] = evaluate(i * step, band);
    return table;
  }) as [Float64Array, Float64Array, Float64Array];
  return { step, channels };
}

/**
 * Ratio of the band-averaged defocused-pupil OTF to the band-averaged
 * diffraction MTF. Layers apply this ratio and the system applies the
 * diffraction MTF, so in-focus and defocused content share one diffraction
 * step while each layer still gets the exact Hopkins OTF.
 */
function defocusRatioTables(context: Context, blur: number, cell: number): RadialTables | null {
  if (blur === 0) return null;
  const nw = context.optics.workingFNumber;
  const maxFrequency = Math.min(Math.SQRT2 * (0.5 / cell), 1 / (SHORTEST_WAVELENGTH * nw));
  const key = `${blur}|${cell}`;
  const cached = context.tables.get(key);
  if (cached) return cached;
  const tables = radialTables(maxFrequency * 1.0001, (rho, band) => {
    let numerator = 0;
    let denominator = 0;
    for (const wavelength of band) {
      numerator += defocusedOtf(rho, blur, wavelength, nw);
      denominator += diffractionMtf(rho, wavelength, nw);
    }
    if (denominator < 1e-6) return 0;
    return Math.min(Math.max(numerator / denominator, -1), 1);
  });
  context.tables.set(key, tables);
  return tables;
}

/** Spectrum of an even line OTF; at Nyquist rows/columns ±f share a bin, so the two signs are averaged. */
function evenLineOtf(dx: number, dy: number, fx: number, fy: number, nyquistX: boolean, nyquistY: boolean): number {
  if (dx === 0 && dy === 0) return 1;
  if (nyquistX && nyquistY) {
    return (lineOtf(dx, dy, fx, fy) + lineOtf(dx, dy, -fx, fy) + lineOtf(dx, dy, fx, -fy) + lineOtf(dx, dy, -fx, -fy)) / 4;
  }
  if (nyquistX) return (lineOtf(dx, dy, fx, fy) + lineOtf(dx, dy, -fx, fy)) / 2;
  if (nyquistY) return (lineOtf(dx, dy, fx, fy) + lineOtf(dx, dy, fx, -fy)) / 2;
  return lineOtf(dx, dy, fx, fy);
}

/** Coarse layers average 2 × 2 sub-samples per cell. */
const coarseSupersample = (n: number): number => (n > 1 ? 2 : 1);

/**
 * Transfer of coarse sampling relative to fine sampling along one axis.
 * Fine cells carry their tent prefilter sinc²(f·h) to the system stage,
 * which removes it. Coarse cells carry sinc²(f·q)·sinc(f·cell)/sinc(f·q)
 * from tent-filtered sub-samples q = cell/s averaged over the cell, and
 * sinc²(f·cell) from bilinear upsampling; this replaces both by sinc²(f·h).
 */
function coarseCompensation(f: number, h: number, cell: number, q: number): number {
  if (cell === h) return 1;
  const s = sincPi(Math.min(Math.abs(f * cell), 0.5));
  return sincPi(f * h) ** 2 / (sincPi(f * q) * s * s * s);
}

interface Patch {
  lx: number;
  ly: number;
  cell: number;
  n: number;
  jStart: number;
  rStart: number;
  cols: number;
  rows: number;
}

function patchGeometry(j0: number, j1: number, r0: number, r1: number, e: number, n: number, h: number): Patch {
  return {
    lx: nextFftSize(Math.ceil((j1 - j0 + 4 * e) / n) + 4),
    ly: nextFftSize(Math.ceil((r1 - r0 + 4 * e) / n) + 4),
    cell: n * h,
    n,
    jStart: j0 - e,
    rStart: r0 - e,
    cols: Math.ceil((j1 - j0 + 2 * e) / n) + 2,
    rows: Math.ceil((r1 - r0 + 2 * e) / n) + 2,
  };
}

interface LayerBlur {
  blur: number;
  motionX: number;
  motionY: number;
}

/**
 * Filters premultiplied (r, g, b, a) with per-channel OTFs. Returns
 * [R, G, B, aR, aG, aB]: coverage is filtered with each channel's OTF so
 * occlusion edges blur exactly like the colours they cut.
 */
function filterPatch(
  context: Context,
  patch: Patch,
  blur: LayerBlur,
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  a: Float64Array,
  contentRows: { first: number; last: number },
  outputRows: { first: number; last: number },
): Float64Array[] {
  const { lx, ly, cell } = patch;
  const h = context.grid.h;
  const q = cell / coarseSupersample(patch.n);
  const tables = defocusRatioTables(context, blur.blur, cell);
  fft2d(r, g, lx, ly, false, contentRows);
  fft2d(b, a, lx, ly, false, contentRows);
  const size = lx * ly;
  const z1r = new Float64Array(size);
  const z1i = new Float64Array(size);
  const z2r = new Float64Array(size);
  const z2i = new Float64Array(size);
  const z3r = new Float64Array(size);
  const z3i = new Float64Array(size);
  for (let v = 0; v < ly; v++) {
    // Rows run downward while image y runs upward.
    const fy = -spatialFrequency(v, ly, cell);
    const mv = (ly - v) % ly;
    const compY = coarseCompensation(fy, h, cell, q);
    for (let u = 0; u < lx; u++) {
      const fx = spatialFrequency(u, lx, cell);
      const common =
        evenLineOtf(blur.motionX, blur.motionY, fx, fy, u === lx / 2, v === ly / 2) * coarseCompensation(fx, h, cell, q) * compY;
      let hr = common;
      let hg = common;
      let hb = common;
      if (tables) {
        const rho = Math.hypot(fx, fy);
        hr *= lookup(tables.channels[0], tables.step, rho);
        hg *= lookup(tables.channels[1], tables.step, rho);
        hb *= lookup(tables.channels[2], tables.step, rho);
      }
      const k = v * lx + u;
      const m = mv * lx + ((lx - u) % lx);
      const x1r = r[k]!;
      const x1i = g[k]!;
      const x1mr = r[m]!;
      const x1mi = g[m]!;
      const redR = (x1r + x1mr) / 2;
      const redI = (x1i - x1mi) / 2;
      const greenR = (x1i + x1mi) / 2;
      const greenI = -(x1r - x1mr) / 2;
      z1r[k] = redR * hr - greenI * hg;
      z1i[k] = redI * hr + greenR * hg;

      const x2r = b[k]!;
      const x2i = a[k]!;
      const x2mr = b[m]!;
      const x2mi = a[m]!;
      const alphaR = (x2i + x2mi) / 2;
      const alphaI = -(x2r - x2mr) / 2;
      z3r[k] = alphaR * hr - alphaI * hg;
      z3i[k] = alphaI * hr + alphaR * hg;
      z2r[k] = x2r * hb;
      z2i[k] = x2i * hb;
    }
  }
  fft2d(z1r, z1i, lx, ly, true, outputRows);
  fft2d(z2r, z2i, lx, ly, true, outputRows);
  fft2d(z3r, z3i, lx, ly, true, outputRows);
  return [z1r, z1i, z2r, z3r, z3i, z2i];
}

/** Coarse patch rows read when upsampling onto fine rows r0…r1. */
function outputRowsOf(patch: Patch, r0: number, r1: number): { first: number; last: number } {
  return { first: Math.floor((r0 - patch.rStart) / patch.n), last: Math.floor((r1 - patch.rStart) / patch.n) + 1 };
}

type Accumulate = (index: number, values: readonly number[]) => void;

/** Bilinearly upsamples filtered coarse channels onto fine rows r0…r1 and columns j0…j1. */
function upsample(patch: Patch, channels: Float64Array[], j0: number, j1: number, r0: number, r1: number, gx: number, accumulate: Accumulate): void {
  const { lx, n, jStart, rStart } = patch;
  const values = [0, 0, 0, 0, 0, 0];
  if (n === 1) {
    for (let row = r0; row <= r1; row++) {
      for (let col = j0; col <= j1; col++) {
        const i = (row - rStart) * lx + col - jStart;
        for (let c = 0; c < channels.length; c++) values[c] = channels[c]![i]!;
        accumulate(row * gx + col, values);
      }
    }
    return;
  }
  for (let row = r0; row <= r1; row++) {
    const fr = (row - rStart) / n;
    const kr = Math.floor(fr);
    const ty = fr - kr;
    for (let col = j0; col <= j1; col++) {
      const fc = (col - jStart) / n;
      const kc = Math.floor(fc);
      const tx = fc - kc;
      const i00 = kr * lx + kc;
      for (let c = 0; c < channels.length; c++) {
        const d = channels[c]!;
        values[c] = (d[i00]! * (1 - tx) + d[i00 + 1]! * tx) * (1 - ty) + (d[i00 + lx]! * (1 - tx) + d[i00 + lx + 1]! * tx) * ty;
      }
      accumulate(row * gx + col, values);
    }
  }
}

function overChannels(grid: FineGrid, index: number, values: readonly number[]): void {
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
  grid.r[index] = values[0]! + (1 - clamp(values[3]!)) * grid.r[index]!;
  grid.g[index] = values[1]! + (1 - clamp(values[4]!)) * grid.g[index]!;
  grid.b[index] = values[2]! + (1 - clamp(values[5]!)) * grid.b[index]!;
}

/** Coarse-grid step (odd, so coarse cells stay centred on fine samples) for a blur level. */
function coarseStep(blur: number, h: number): number {
  const m = Math.floor(blur / (SAMPLES_PER_BLUR * h));
  return m < 1 ? 1 : 2 * Math.floor((m - 1) / 2) + 1;
}

/** Blur levels spanning [cMin, cMax], spaced by max(P/2, SLICE_STEP·c) like the ground slices. */
function blurLevels(context: Context, cMin: number, cMax: number): number[] {
  const levels = [cMin];
  while (levels[levels.length - 1]! < cMax) {
    const c = levels[levels.length - 1]!;
    levels.push(c + Math.max(context.outputPixel / 2, SLICE_STEP * c));
  }
  return levels;
}

/**
 * A layer with depth, rendered by scatter: each sample's content is split
 * between the two blur levels nearest its own blur circle (tent weights),
 * every level is blurred with its own exact OTF, and the levels are summed.
 * Occlusion within the layer is resolved by its sample function.
 */
function renderRelief(context: Context, layer: PlaneLayer, relief: { near: number; far: number }): void {
  const { grid, optics } = context;
  const { h, gx, gy } = grid;
  const scale = optics.imageDistance / layer.distance;
  const lens = { focalLength: optics.focalLength, fNumber: optics.fNumber };
  const blurAt = (z: number): number => blurCircleDiameter(lens, optics.focusDistance, layer.distance + z);
  const motionX = (layer.velocity?.x ?? 0) * scale * optics.shutterTime;
  const motionY = (layer.velocity?.y ?? 0) * scale * optics.shutterTime;
  const motion = Math.hypot(motionX, motionY);
  const ratioMargin = RATIO_KERNEL_MARGIN * LONGEST_WAVELENGTH * optics.workingFNumber;
  const reachOf = (c: number): number => c / 2 + motion / 2 + ratioMargin;

  const cNear = blurAt(relief.near);
  const cFar = blurAt(relief.far);
  const focusInside = optics.focusDistance >= layer.distance + relief.near && optics.focusDistance <= layer.distance + relief.far;
  const cMax = Math.max(cNear, cFar);
  const levels = blurLevels(context, focusInside ? 0 : Math.min(cNear, cFar), cMax);
  const reach = reachOf(cMax);

  const { bounds } = layer;
  let bottom = bounds.minY * scale - optics.shiftY - reach;
  const top = bounds.maxY * scale - optics.shiftY + reach;
  let cut = -Infinity;
  const soft = cutSoftness(cMax);
  if (layer.contactY !== undefined) {
    cut = layer.contactY * scale - optics.shiftY - (cMax + Math.abs(motionY) + 2 * ratioMargin + 2 * h + soft);
    bottom = Math.max(bottom, cut - reach - soft);
  }
  const x0 = grid.x(0);
  const y0 = grid.y(0);
  const colOf = (x: number) => (x - x0) / h;
  const rowOf = (y: number) => (y0 - y) / h;
  const jLo = Math.ceil(colOf(bounds.minX * scale - optics.shiftX - reach));
  const jHi = Math.floor(colOf(bounds.maxX * scale - optics.shiftX + reach));
  const rLo = Math.ceil(rowOf(top));
  const rHi = Math.floor(rowOf(bottom));
  const j0 = Math.max(0, jLo);
  const j1 = Math.min(gx - 1, jHi);
  const r0 = Math.max(0, rLo);
  const r1 = Math.min(gy - 1, rHi);
  if (j0 > j1 || r0 > r1) return;

  const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  const sampleAt = (x: number, y: number, size: number): number => {
    const kept = cut === -Infinity ? 1 : tentStep((y - cut) / Math.max(size, soft));
    out.z = 0;
    if (kept === 0) {
      out.r = out.g = out.b = out.a = 0;
      return 0;
    }
    layer.sample((x + optics.shiftX) / scale, (y + optics.shiftY) / scale, size / scale, out);
    return kept;
  };

  // Fine samples shared by all levels sampled at full resolution.
  const fineLevels = levels.filter((c) => coarseStep(c, h) === 1);
  type FineCache = { j0: number; j1: number; r0: number; r1: number; w: number; data: Float32Array };
  const buildCache = (): FineCache => {
    const e = Math.ceil(reachOf(fineLevels[fineLevels.length - 1]!) / h) + 1;
    const cj0 = Math.max(-e, jLo);
    const cj1 = Math.min(gx - 1 + e, jHi);
    const cr0 = Math.max(-e, rLo);
    const cr1 = Math.min(gy - 1 + e, rHi);
    const w = cj1 - cj0 + 1;
    const data = new Float32Array(Math.max(0, w * (cr1 - cr0 + 1)) * 5);
    for (let row = cr0; row <= cr1; row++) {
      const y = grid.y(row);
      for (let col = cj0; col <= cj1; col++) {
        const kept = sampleAt(grid.x(col), y, h);
        const i = 5 * ((row - cr0) * w + col - cj0);
        data[i] = kept * out.r;
        data[i + 1] = kept * out.g;
        data[i + 2] = kept * out.b;
        data[i + 3] = kept * out.a;
        data[i + 4] = blurAt(out.z ?? 0);
      }
    }
    return { j0: cj0, j1: cj1, r0: cr0, r1: cr1, w, data };
  };
  const cache: FineCache | null = fineLevels.length > 0 ? buildCache() : null;

  // Coarse levels with the same step share one sample lattice (margins rounded to whole steps).
  const marginOf = (c: number, n: number): number => n * Math.ceil((Math.ceil(reachOf(c) / h) + n) / n);
  type Lattice = { e: number; rows: number; cols: number; filled: Uint8Array; data: Float32Array };
  const lattices = new Map<number, Lattice>();
  for (const c of levels) {
    const n = coarseStep(c, h);
    if (n === 1) continue;
    const e = Math.max(marginOf(c, n), lattices.get(n)?.e ?? 0);
    const rows = Math.ceil((r1 - r0 + 2 * e) / n) + 2;
    const cols = Math.ceil((j1 - j0 + 2 * e) / n) + 2;
    lattices.set(n, { e, rows, cols, filled: new Uint8Array(0), data: new Float32Array(0) });
  }
  for (const [n, lattice] of lattices) {
    const subSamples = coarseSupersample(n) ** 2;
    lattice.filled = new Uint8Array(lattice.rows * lattice.cols);
    lattice.data = new Float32Array(lattice.rows * lattice.cols * subSamples * 6);
  }
  const latticeSample = (lattice: Lattice, n: number, kr: number, kc: number, supersample: number): number => {
    const p = kr * lattice.cols + kc;
    const base = p * supersample * supersample * 6;
    if (!lattice.filled[p]) {
      lattice.filled[p] = 1;
      const cell = n * h;
      const q = cell / supersample;
      const x = grid.x(j0 - lattice.e + kc * n);
      const y = grid.y(r0 - lattice.e + kr * n);
      for (let i = 0; i < supersample; i++) {
        const oy = ((i + 0.5) / supersample - 0.5) * cell;
        for (let j = 0; j < supersample; j++) {
          const ox = ((j + 0.5) / supersample - 0.5) * cell;
          const kept = sampleAt(x + ox, y + oy, q);
          const s = base + 6 * (i * supersample + j);
          lattice.data[s] = kept;
          lattice.data[s + 1] = out.r;
          lattice.data[s + 2] = out.g;
          lattice.data[s + 3] = out.b;
          lattice.data[s + 4] = out.a;
          lattice.data[s + 5] = kept === 0 ? 0 : blurAt(out.z ?? 0);
        }
      }
    }
    return base;
  };

  const aw = j1 - j0 + 1;
  const acc = Array.from({ length: 6 }, () => new Float32Array(aw * (r1 - r0 + 1)));
  let touched = false;
  for (let k = 0; k < levels.length; k++) {
    const c = levels[k]!;
    const n = coarseStep(c, h);
    const e = n === 1 ? Math.ceil(reachOf(c) / h) + n : marginOf(c, n);
    let patch: Patch;
    let outRows: { first: number; last: number };
    let outCols: { first: number; last: number };
    let pr: Float64Array;
    let pg: Float64Array;
    let pb: Float64Array;
    let pa: Float64Array;
    if (n === 1 && cache) {
      const { data, w } = cache;
      let ca = Infinity;
      let cb = -Infinity;
      let ra = Infinity;
      let rb = -Infinity;
      for (let row: number = cache.r0; row <= cache.r1; row++) {
        for (let col: number = cache.j0; col <= cache.j1; col++) {
          const i = 5 * ((row - cache.r0) * w + col - cache.j0);
          if (data[i + 3] === 0 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) continue;
          if (tentWeight(levels, k, data[i + 4]!) === 0) continue;
          ca = Math.min(ca, col);
          cb = Math.max(cb, col);
          ra = Math.min(ra, row);
          rb = Math.max(rb, row);
        }
      }
      if (ca > cb) continue;
      patch = patchGeometry(ca, cb, ra, rb, e, 1, h);
      const size = patch.lx * patch.ly;
      pr = new Float64Array(size);
      pg = new Float64Array(size);
      pb = new Float64Array(size);
      pa = new Float64Array(size);
      for (let kr = 0; kr < patch.rows; kr++) {
        const row: number = patch.rStart + kr;
        if (row < cache.r0 || row > cache.r1) continue;
        for (let kc = 0; kc < patch.cols; kc++) {
          const col = patch.jStart + kc;
          if (col < cache.j0 || col > cache.j1) continue;
          const i = 5 * ((row - cache.r0) * w + col - cache.j0);
          const weight = tentWeight(levels, k, data[i + 4]!);
          if (weight === 0) continue;
          const index = kr * patch.lx + kc;
          pr[index] = weight * data[i]!;
          pg[index] = weight * data[i + 1]!;
          pb[index] = weight * data[i + 2]!;
          pa[index] = weight * data[i + 3]!;
        }
      }
      outRows = { first: Math.max(r0, ra - e), last: Math.min(r1, rb + e) };
      outCols = { first: Math.max(j0, ca - e), last: Math.min(j1, cb + e) };
    } else {
      patch = patchGeometry(j0, j1, r0, r1, e, n, h);
      const size = patch.lx * patch.ly;
      pr = new Float64Array(size);
      pg = new Float64Array(size);
      pb = new Float64Array(size);
      pa = new Float64Array(size);
      const supersample = coarseSupersample(n);
      const share = 1 / (supersample * supersample);
      const lattice = lattices.get(n)!;
      const offset = (lattice.e - e) / n;
      const { data } = lattice;
      let any = false;
      for (let kr = 0; kr < patch.rows; kr++) {
        for (let kc = 0; kc < patch.cols; kc++) {
          const index = kr * patch.lx + kc;
          const base = latticeSample(lattice, n, kr + offset, kc + offset, supersample);
          for (let s = base; s < base + 6 * supersample * supersample; s += 6) {
            const kept = data[s]!;
            if (kept === 0) continue;
            const weight = kept * share * tentWeight(levels, k, data[s + 5]!);
            if (weight === 0) continue;
            any = true;
            pr[index] = pr[index]! + weight * data[s + 1]!;
            pg[index] = pg[index]! + weight * data[s + 2]!;
            pb[index] = pb[index]! + weight * data[s + 3]!;
            pa[index] = pa[index]! + weight * data[s + 4]!;
          }
        }
      }
      if (!any) continue;
      outRows = { first: r0, last: r1 };
      outCols = { first: j0, last: j1 };
    }
    if (outRows.first > outRows.last || outCols.first > outCols.last) continue;
    touched = true;
    const channels = filterPatch(
      context,
      patch,
      { blur: c, motionX, motionY },
      pr,
      pg,
      pb,
      pa,
      { first: 0, last: patch.rows - 1 },
      outputRowsOf(patch, outRows.first, outRows.last),
    );
    upsample(patch, channels, outCols.first, outCols.last, outRows.first, outRows.last, gx, (index, values) => {
      const row = Math.floor(index / gx);
      const i = (row - r0) * aw + (index - row * gx) - j0;
      for (let ch = 0; ch < 6; ch++) acc[ch]![i] = acc[ch]![i]! + values[ch]!;
    });
  }
  if (!touched) return;
  const values = [0, 0, 0, 0, 0, 0];
  for (let row = r0; row <= r1; row++) {
    for (let col = j0; col <= j1; col++) {
      const i = (row - r0) * aw + col - j0;
      for (let ch = 0; ch < 6; ch++) values[ch] = acc[ch]![i]!;
      overChannels(grid, row * gx + col, values);
    }
  }
}

/** Half-width of the ramp that ends a submerged extension below its contact line. */
const cutSoftness = (blur: number): number => blur / 4;

function renderPlane(context: Context, layer: PlaneLayer): void {
  if (layer.relief) {
    renderRelief(context, layer, layer.relief);
    return;
  }
  const { grid, optics } = context;
  const { h, gx, gy } = grid;
  const scale = optics.imageDistance / layer.distance;
  const blur = blurCircleDiameter({ focalLength: optics.focalLength, fNumber: optics.fNumber }, optics.focusDistance, layer.distance);
  const motionX = (layer.velocity?.x ?? 0) * scale * optics.shutterTime;
  const motionY = (layer.velocity?.y ?? 0) * scale * optics.shutterTime;
  const blurred = blur > 0 || motionX !== 0 || motionY !== 0;
  const reach = blurred
    ? blur / 2 + Math.hypot(motionX, motionY) / 2 + RATIO_KERNEL_MARGIN * LONGEST_WAVELENGTH * optics.workingFNumber
    : 0;

  const { bounds } = layer;
  const left = bounds.minX * scale - optics.shiftX - reach;
  const right = bounds.maxX * scale - optics.shiftX + reach;
  let bottom = bounds.minY * scale - optics.shiftY - reach;
  const top = bounds.maxY * scale - optics.shiftY + reach;
  // Submerged part: deep enough to stay opaque under every pixel the ground in front leaves partly uncovered.
  let cut = -Infinity;
  // The cut ramps over a fraction of the blur: a hard cut sampled on a coarse grid rings visibly under large blur.
  const soft = cutSoftness(blur);
  if (layer.contactY !== undefined) {
    const depth = blur + Math.abs(motionY) + 2 * RATIO_KERNEL_MARGIN * LONGEST_WAVELENGTH * optics.workingFNumber + 2 * h + soft;
    cut = layer.contactY * scale - optics.shiftY - depth;
    bottom = Math.max(bottom, cut - reach - soft);
  }
  const x0 = grid.x(0);
  const y0 = grid.y(0);
  const j0 = Math.max(0, Math.ceil((left - x0) / h));
  const j1 = Math.min(gx - 1, Math.floor((right - x0) / h));
  const r0 = Math.max(0, Math.ceil((y0 - top) / h));
  const r1 = Math.min(gy - 1, Math.floor((y0 - bottom) / h));
  if (j0 > j1 || r0 > r1) return;

  const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  const sampleAt = (x: number, y: number, size: number, supersample: number): void => {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    const q = size / supersample;
    for (let i = 0; i < supersample; i++) {
      const oy = ((i + 0.5) / supersample - 0.5) * size;
      const kept = cut === -Infinity ? 1 : tentStep((y + oy - cut) / Math.max(q, soft));
      if (kept === 0) continue;
      for (let j = 0; j < supersample; j++) {
        const ox = ((j + 0.5) / supersample - 0.5) * size;
        layer.sample((x + ox + optics.shiftX) / scale, (y + oy + optics.shiftY) / scale, q / scale, out);
        sr += kept * out.r;
        sg += kept * out.g;
        sb += kept * out.b;
        sa += kept * out.a;
      }
    }
    const k = supersample * supersample;
    out.r = sr / k;
    out.g = sg / k;
    out.b = sb / k;
    out.a = sa / k;
  };

  if (!blurred) {
    const values = [0, 0, 0, 0, 0, 0];
    for (let row = r0; row <= r1; row++) {
      for (let col = j0; col <= j1; col++) {
        sampleAt(grid.x(col), grid.y(row), h, 1);
        values[0] = out.r;
        values[1] = out.g;
        values[2] = out.b;
        values[3] = values[4] = values[5] = out.a;
        overChannels(grid, row * gx + col, values);
      }
    }
    return;
  }

  const n = Math.max(1, Math.floor(blur / (SAMPLES_PER_BLUR * h)));
  const e = Math.ceil(reach / h) + n;
  const patch = patchGeometry(j0, j1, r0, r1, e, n, h);
  const supersample = coarseSupersample(n);
  const size = patch.lx * patch.ly;
  const pr = new Float64Array(size);
  const pg = new Float64Array(size);
  const pb = new Float64Array(size);
  const pa = new Float64Array(size);
  for (let kr = 0; kr < patch.rows; kr++) {
    const y = grid.y(patch.rStart + kr * n);
    for (let kc = 0; kc < patch.cols; kc++) {
      sampleAt(grid.x(patch.jStart + kc * n), y, patch.cell, supersample);
      const index = kr * patch.lx + kc;
      pr[index] = out.r;
      pg[index] = out.g;
      pb[index] = out.b;
      pa[index] = out.a;
    }
  }
  const channels = filterPatch(
    context,
    patch,
    { blur, motionX, motionY },
    pr,
    pg,
    pb,
    pa,
    { first: 0, last: patch.rows - 1 },
    outputRowsOf(patch, r0, r1),
  );
  upsample(patch, channels, j0, j1, r0, r1, gx, (index, values) => overChannels(grid, index, values));
}

/**
 * Depth slices shared by every ground layer with the same camera height:
 * blur levels, the rows each level covers, and the per-channel normalization
 * N = Σ_k S_k(w_k) of the slice operator.
 */
interface GroundPlan {
  levels: number[];
  bands: { level: number; r0: number; r1: number; patch: Patch; e: number }[];
  normalization: [Float64Array, Float64Array, Float64Array];
}

function tentWeight(levels: number[], k: number, c: number): number {
  const ck = levels[k]!;
  if (c === ck) return 1;
  if (c < ck) {
    if (k === 0) return 1;
    const lo = levels[k - 1]!;
    return c <= lo ? 0 : (c - lo) / (ck - lo);
  }
  if (k === levels.length - 1) return 1;
  const hi = levels[k + 1]!;
  return c >= hi ? 0 : (hi - c) / (hi - ck);
}

/**
 * Blur-circle diameter of the ground at shifted image height y′. Since
 * 1/Z = −y′/(H v_f) is linear in y′, c(y′) = A |y′/H + v_f/s_f| is piecewise
 * linear (and is continued algebraically above the horizon).
 */
function groundBlur(optics: Optics, cameraHeight: number, yShifted: number): number {
  return optics.aperture * Math.abs(yShifted / cameraHeight + optics.imageDistance / optics.focusDistance);
}

const groundMargin = (context: Context): number =>
  RATIO_KERNEL_MARGIN * LONGEST_WAVELENGTH * context.optics.workingFNumber + 2 * context.grid.h;

function groundPlan(context: Context, cameraHeight: number): GroundPlan {
  const { grid, optics } = context;
  const { h, gy } = grid;
  const margin = groundMargin(context);
  const blurAtY = (y: number): number => groundBlur(optics, cameraHeight, y + optics.shiftY);
  const blurAt = (row: number): number => blurAtY(grid.y(row));
  const reaches = (row: number): boolean => {
    const distance = row < 0 ? -row : row > gy - 1 ? row - (gy - 1) : 0;
    return distance * h <= blurAt(row) / 2 + margin;
  };
  const limit = GROUND_REACH_LIMIT * gy;
  let rLo = 0;
  while (rLo > -limit && reaches(rLo - 1)) rLo--;
  let rHi = gy - 1;
  while (rHi < gy - 1 + limit && reaches(rHi + 1)) rHi++;

  let cMin = Infinity;
  let cMax = 0;
  for (let row = rLo; row <= rHi; row++) {
    const c = blurAt(row);
    cMin = Math.min(cMin, c);
    cMax = Math.max(cMax, c);
  }
  const levels = [cMin];
  while (levels[levels.length - 1]! < cMax) {
    const c = levels[levels.length - 1]!;
    levels.push(c + Math.max(context.outputPixel / 2, SLICE_STEP * c));
  }

  const normalization: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(gy),
    new Float64Array(gy),
    new Float64Array(gy),
  ];
  const bands: GroundPlan["bands"] = [];
  for (let k = 0; k < levels.length; k++) {
    const c = levels[k]!;
    const n = Math.max(1, Math.floor(c / (SAMPLES_PER_BLUR * h)));
    const e = Math.ceil((c / 2 + (c > 0 ? margin : 0)) / h) + n;
    let start = -1;
    for (let row = rLo; row <= rHi + 1; row++) {
      const inside = row <= rHi && tentWeight(levels, k, blurAt(row)) > 0;
      if (inside && start < 0) start = row;
      if (!inside && start >= 0) {
        const r0 = Math.max(0, start - e);
        const r1 = Math.min(gy - 1, row - 1 + e);
        if (r0 <= r1) {
          // Thin in-focus bands reuse the grid's own width periodically when their blur fits in the grid margin.
          const patch: Patch =
            n === 1 && e <= context.marginColumns
              ? { ...patchGeometry(0, grid.gx - 1, r0, r1, e, 1, h), lx: grid.gx, jStart: 0, cols: grid.gx }
              : patchGeometry(0, grid.gx - 1, r0, r1, e, n, h);
          bands.push({ level: k, r0, r1, patch, e });
          accumulateNormalization(context, levels, k, blurAtY, patch, r0, r1, normalization);
        }
        start = -1;
      }
    }
  }
  return { levels, bands, normalization };
}

/**
 * The x-independent part of the slice operator: the same coarse rows,
 * sub-samples, transfer function (at f_x = 0) and upsampling that the 2D
 * patches use, applied to the slice weight alone.
 */
function accumulateNormalization(
  context: Context,
  levels: number[],
  k: number,
  blurAtY: (y: number) => number,
  patch: Patch,
  r0: number,
  r1: number,
  normalization: [Float64Array, Float64Array, Float64Array],
): void {
  const { grid } = context;
  const { ly, n, rStart, rows, cell } = patch;
  const supersample = coarseSupersample(n);
  const profile = new Float64Array(ly);
  for (let kr = 0; kr < rows; kr++) {
    const y = grid.y(rStart + kr * n);
    let sum = 0;
    for (let i = 0; i < supersample; i++) {
      const oy = ((i + 0.5) / supersample - 0.5) * cell;
      sum += tentWeight(levels, k, blurAtY(y + oy));
    }
    profile[kr] = sum / supersample;
  }
  const re = new Float64Array(profile);
  const im = new Float64Array(ly);
  fft1d(re, im, false);
  const tables = defocusRatioTables(context, levels[k]!, cell);
  for (let c = 0; c < 3; c++) {
    const zr = new Float64Array(ly);
    const zi = new Float64Array(ly);
    for (let v = 0; v < ly; v++) {
      const fy = spatialFrequency(v, ly, cell);
      let hv = coarseCompensation(fy, grid.h, cell, cell / supersample);
      if (tables) hv *= lookup(tables.channels[c]!, tables.step, Math.abs(fy));
      zr[v] = re[v]! * hv;
      zi[v] = im[v]! * hv;
    }
    fft1d(zr, zi, true);
    const target = normalization[c]!;
    for (let row = r0; row <= r1; row++) {
      const fr = (row - rStart) / n;
      const kr = Math.floor(fr);
      const t = fr - kr;
      target[row] = target[row]! + zr[kr]! * (1 - t) + zr[kr + 1]! * t;
    }
  }
}

function renderGround(context: Context, layer: GroundLayer, plan: GroundPlan): void {
  const { grid, optics } = context;
  const { gx, gy } = grid;
  const H = layer.cameraHeight;
  const vF = optics.imageDistance;
  let yNear = (-H * vF) / layer.nearDistance;
  const yFar = (-H * vF) / layer.farDistance;
  const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };

  if (layer.occluderOnly) {
    // Keep rows that stay opaque over the blurred submerged parts of planes standing at the far cut
    // (depth c + margins, blurred by c/2), plus this layer's own blurred near cut (c(y_near)/2 ≤ (c + slope·D)/2).
    const slope = optics.aperture / H;
    if (slope < 2) {
      const reach = 2 * groundBlur(optics, H, yFar) + 4 * groundMargin(context) + 4 * grid.h;
      yNear = Math.max(yNear, yFar - (1.1 * reach) / (1 - slope / 2));
    }
  }

  const bands = plan.bands.filter(({ patch }) => {
    const top = grid.y(patch.rStart) + optics.shiftY + patch.cell;
    const bottom = grid.y(patch.rStart + patch.rows * patch.n) + optics.shiftY - patch.cell;
    return bottom <= yFar && top >= yNear;
  });
  if (bands.length === 0) return;
  const rowMin = Math.min(...bands.map((b) => b.r0));
  const rowMax = Math.max(...bands.map((b) => b.r1));
  const acc = Array.from({ length: 6 }, () => new Float32Array((rowMax - rowMin + 1) * gx));
  // Fine rows sampled by consecutive (tent-paired) slices share their texture samples.
  const rowCache = new Map<number, Float32Array>();
  let touched = false;

  for (const band of bands) {
    const { patch, level, r0, r1 } = band;
    const { n, cell, rows, cols, lx, ly, rStart, jStart } = patch;
    const cacheable = n === 1 && jStart === 0 && cols === gx;
    const supersample = coarseSupersample(n);
    const q = cell / supersample;
    const pr = new Float64Array(lx * ly);
    const pg = new Float64Array(lx * ly);
    const pb = new Float64Array(lx * ly);
    const pa = new Float64Array(lx * ly);
    let first = rows;
    let last = -1;
    for (let kr = 0; kr < rows; kr++) {
      const y = grid.y(rStart + kr * n);
      for (let i = 0; i < supersample; i++) {
        const yp = y + ((i + 0.5) / supersample - 0.5) * cell + optics.shiftY;
        const weight = tentWeight(plan.levels, level, groundBlur(optics, H, yp));
        if (weight === 0) continue;
        const coverage = tentStep((yp - yNear) / q) - tentStep((yp - yFar) / q);
        if (coverage === 0) continue;
        first = Math.min(first, kr);
        last = Math.max(last, kr);
        const Z = (-H * vF) / yp;
        const fpX = (q * Z) / vF;
        const fpZ = (q * Z * Z) / (H * vF);
        const base = kr * lx;
        if (cacheable) {
          let samples = rowCache.get(rStart + kr);
          if (!samples) {
            samples = new Float32Array(4 * gx);
            for (let col = 0; col < gx; col++) {
              layer.sample(((grid.x(col) + optics.shiftX) * Z) / vF, Z, fpX, fpZ, out);
              samples[4 * col] = out.r * coverage;
              samples[4 * col + 1] = out.g * coverage;
              samples[4 * col + 2] = out.b * coverage;
              samples[4 * col + 3] = out.a * coverage;
            }
            rowCache.set(rStart + kr, samples);
          }
          for (let col = 0; col < gx; col++) {
            pr[base + col] = weight * samples[4 * col]!;
            pg[base + col] = weight * samples[4 * col + 1]!;
            pb[base + col] = weight * samples[4 * col + 2]!;
            pa[base + col] = weight * samples[4 * col + 3]!;
          }
          continue;
        }
        const w = (weight * coverage) / (supersample * supersample);
        for (let kc = 0; kc < cols; kc++) {
          const x = grid.x(jStart + kc * n);
          const index = base + kc;
          for (let j = 0; j < supersample; j++) {
            const xp = x + ((j + 0.5) / supersample - 0.5) * cell + optics.shiftX;
            layer.sample((xp * Z) / vF, Z, fpX, fpZ, out);
            pr[index] = pr[index]! + w * out.r;
            pg[index] = pg[index]! + w * out.g;
            pb[index] = pb[index]! + w * out.b;
            pa[index] = pa[index]! + w * out.a;
          }
        }
      }
    }
    if (last < 0) continue;
    touched = true;
    const channels = filterPatch(
      context,
      patch,
      { blur: plan.levels[level]!, motionX: 0, motionY: 0 },
      pr,
      pg,
      pb,
      pa,
      { first, last },
      outputRowsOf(patch, r0, r1),
    );
    upsample(patch, channels, 0, gx - 1, r0, r1, gx, (index, values) => {
      const i = index - rowMin * gx;
      for (let c = 0; c < 6; c++) acc[c]![i] = acc[c]![i]! + values[c]!;
    });
  }
  if (!touched) return;

  const values = [0, 0, 0, 0, 0, 0];
  for (let row = rowMin; row <= rowMax; row++) {
    const norms = plan.normalization.map((nrm) => nrm[row]!);
    for (let col = 0; col < gx; col++) {
      const i = (row - rowMin) * gx + col;
      for (let c = 0; c < 6; c++) {
        const norm = norms[c % 3]!;
        values[c] = norm > 1e-9 ? acc[c]![i]! / norm : 0;
      }
      overChannels(grid, row * gx + col, values);
    }
  }
}

/**
 * Diffraction (band-averaged, at the working f-number), output-pixel
 * integration, and removal of the fine-grid tent prefilter sinc²(f·h) that
 * every sampled texture carries.
 */
function applySystemOtf(grid: FineGrid, workingN: number, outputPixelSize: number): void {
  const { gx, gy, h } = grid;
  const size = gx * gy;
  const tables = radialTables(Math.SQRT2 * (0.5 / h) * 1.0001, (rho, band) => {
    let sum = 0;
    for (const wavelength of band) sum += diffractionMtf(rho, wavelength, workingN);
    return sum / band.length;
  });
  const re = grid.r;
  const im = grid.g;
  const blueIm = new Float64Array(size);
  fft2d(re, im, gx, gy);
  fft2d(grid.b, blueIm, gx, gy);

  const zr = new Float64Array(size);
  const zi = new Float64Array(size);
  for (let v = 0; v < gy; v++) {
    const fy = spatialFrequency(v, gy, h);
    const mv = (gy - v) % gy;
    const pixelY = boxOtf(outputPixelSize, fy) / sincPi(fy * h) ** 2;
    for (let u = 0; u < gx; u++) {
      const fx = spatialFrequency(u, gx, h);
      const rho = Math.hypot(fx, fy);
      const pixel = (boxOtf(outputPixelSize, fx) / sincPi(fx * h) ** 2) * pixelY;
      const hr = lookup(tables.channels[0], tables.step, rho) * pixel;
      const hg = lookup(tables.channels[1], tables.step, rho) * pixel;
      const hb = lookup(tables.channels[2], tables.step, rho) * pixel;
      const k = v * gx + u;
      const m = mv * gx + ((gx - u) % gx);
      const xr = re[k]!;
      const xi = im[k]!;
      const mr = re[m]!;
      const mi = im[m]!;
      const redR = ((xr + mr) / 2) * hr;
      const redI = ((xi - mi) / 2) * hr;
      const greenR = ((xi + mi) / 2) * hg;
      const greenI = (-(xr - mr) / 2) * hg;
      zr[k] = redR - greenI;
      zi[k] = redI + greenR;
      grid.b[k] = grid.b[k]! * hb;
      blueIm[k] = blueIm[k]! * hb;
    }
  }
  fft2d(zr, zi, gx, gy, true);
  fft2d(grid.b, blueIm, gx, gy, true);
  grid.r.set(zr);
  grid.g.set(zi);
}

/**
 * Fine-grid samples per output pixel. Pixel sampling aliases every
 * frequency the optics pass; the fine grid must carry them up to the
 * diffraction cutoff or 2 cycles/pixel, beyond which the pixel aperture
 * (sinc² < 0.02 per alias) makes the remainder negligible.
 */
export function defaultOversample(outputPixel: number, workingN: number): number {
  const required = Math.min(1 / (SHORTEST_WAVELENGTH * workingN), 2 / outputPixel);
  return Math.min(Math.max(Math.ceil(2 * required * outputPixel), 2), 4);
}

export function renderOpticalImage(
  scene: Scene,
  shot: ShotSettings,
  view: ViewSpec,
  format: SensorFormat = FULL_FRAME,
): OpticalImage {
  const pitch = pixelPitch(format, shot.resolution);
  const P = Math.max(view.outputPixelSize, pitch);
  const lens = { focalLength: shot.focalLength, fNumber: shot.fNumber };
  const os = Math.max(1, Math.round(view.oversample ?? defaultOversample(P, workingFNumber(lens, shot.focusDistance))));
  const h = P / os;
  const nx = Math.max(1, Math.round(view.width / P));
  const ny = Math.max(1, Math.round(view.height / P));

  const vF = imageDistance(shot.focalLength, shot.focusDistance);
  const optics: Optics = {
    focalLength: shot.focalLength,
    fNumber: shot.fNumber,
    focusDistance: shot.focusDistance,
    imageDistance: vF,
    aperture: shot.focalLength / shot.fNumber,
    workingFNumber: workingFNumber(lens, shot.focusDistance),
    shutterTime: shot.shutterTime,
    shiftX: (scene.aim.x * vF) / scene.aim.distance,
    shiftY: (scene.aim.y * vF) / scene.aim.distance,
  };

  const margin = Math.ceil((DIFFRACTION_MARGIN * LONGEST_WAVELENGTH * optics.workingFNumber + 2 * P) / h) + 2;
  const gx = nextFftSize(nx * os + 2 * margin);
  const gy = nextFftSize(ny * os + 2 * margin);
  const mx = Math.floor((gx - (nx - 1) * os) / 2);
  const my = Math.floor((gy - (ny - 1) * os) / 2);
  const xFirst = view.centerX - (nx * P) / 2 + P / 2;
  const yFirst = view.centerY + (ny * P) / 2 - P / 2;

  const size = gx * gy;
  const grid: FineGrid = {
    gx,
    gy,
    h,
    x: (column) => xFirst + (column - mx) * h,
    y: (row) => yFirst - (row - my) * h,
    r: new Float64Array(size),
    g: new Float64Array(size),
    b: new Float64Array(size),
  };
  for (let row = 0; row < gy; row++) {
    const yp = grid.y(row) + optics.shiftY;
    for (let col = 0; col < gx; col++) {
      const xp = grid.x(col) + optics.shiftX;
      const v = scene.sky(Math.atan2(yp, Math.hypot(vF, xp)));
      const index = row * gx + col;
      grid.r[index] = v;
      grid.g[index] = v;
      grid.b[index] = v;
    }
  }

  const context: Context = {
    grid,
    optics,
    outputPixel: P,
    marginColumns: Math.min(mx, gx - 1 - (mx + (nx - 1) * os)),
    tables: new Map(),
  };
  const plans = new Map<number, GroundPlan>();
  for (const layer of scene.layers) {
    if (layer.kind === "plane") {
      renderPlane(context, layer);
    } else {
      let plan = plans.get(layer.cameraHeight);
      if (!plan) {
        plan = groundPlan(context, layer.cameraHeight);
        plans.set(layer.cameraHeight, plan);
      }
      renderGround(context, layer, plan);
    }
  }
  applySystemOtf(grid, optics.workingFNumber, P);

  const r = new Float64Array(nx * ny);
  const g = new Float64Array(nx * ny);
  const b = new Float64Array(nx * ny);
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const src = (my + i * os) * gx + mx + j * os;
      const dst = i * nx + j;
      // Relative illumination of an aplanatic lens: cos⁴θ about the optical axis (frame centre).
      const x = xFirst + j * P;
      const y = yFirst - i * P;
      const falloff = ((vF * vF) / (vF * vF + x * x + y * y)) ** 2;
      r[dst] = grid.r[src]! * falloff;
      g[dst] = grid.g[src]! * falloff;
      b[dst] = grid.b[src]! * falloff;
    }
  }

  return {
    width: nx,
    height: ny,
    r,
    g,
    b,
    sensorPitch: pitch,
    outputPixelSize: P,
    binning: (P / pitch) ** 2,
    grid: { width: gx, height: gy, oversample: os },
  };
}

export interface ReadoutOptions {
  noise?: boolean;
  seed?: number;
  sensor?: SensorModel;
}

/**
 * Converts radiance factors to normalized output levels (0–1, linear):
 * exposure → photoelectrons → Poisson shot noise → full-well clip → read
 * noise → ISO gain. Binned output pixels sum the electrons of their sensor
 * pixels, which is exact for Poisson statistics.
 */
export function readOut(image: OpticalImage, shot: ShotSettings, options: ReadoutOptions = {}): Float32Array {
  const { noise = true, seed = 1, sensor = GENERIC_SENSOR } = options;
  const rng = mulberry32(seed);
  const pitch = image.sensorPitch;
  const k = image.binning;
  const unitExposure = sensorExposure(shot.illuminance / Math.PI, shot.focalLength, shot.fNumber, shot.focusDistance, shot.shutterTime);
  const electronsPerFactor = meanElectrons(unitExposure, pitch, sensor) * k;
  const white = electronsAtWhite(shot.iso, pitch, sensor) * k;
  const full = fullWellCapacity(pitch, sensor) * k;
  const readSigma = sensor.readNoise * Math.sqrt(k);

  const count = image.width * image.height;
  const out = new Float32Array(count * 3);
  const channels = [image.r, image.g, image.b];
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const mean = Math.max(channels[c]![i]!, 0) * electronsPerFactor;
      let electrons: number;
      if (noise) {
        electrons = Math.min(poisson(mean, rng), full) + readSigma * standardNormal(rng);
      } else {
        electrons = Math.min(mean, full);
      }
      out[i * 3 + c] = Math.min(Math.max(electrons / white, 0), 1);
    }
  }
  return out;
}

/** Standard sRGB display encoding of linear output levels into an RGBA byte buffer. */
export function encodeSrgb(levels: Float32Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      const v = levels[i * 3 + c]!;
      const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      out[i * 4 + c] = Math.round(encoded * 255);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}
