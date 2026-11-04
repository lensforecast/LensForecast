/** Iterative complex FFT (radix 2, plus one radix-3 stage) on split real/imaginary arrays. */

interface FftPlan {
  reverse: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const plans = new Map<number, FftPlan>();

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function getPlan(n: number): FftPlan {
  let plan = plans.get(n);
  if (plan) return plan;
  if (!isPowerOfTwo(n)) throw new RangeError(`FFT size ${n} is not a power of two`);
  const bits = Math.log2(n);
  const reverse = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  plan = { reverse, cos, sin };
  plans.set(n, plan);
  return plan;
}

/** Smallest supported transform size ≥ n: 2^k or 3·2^k. */
export function nextFftSize(n: number): number {
  const pow2 = nextPow2(n);
  const triple = 3 * nextPow2(Math.ceil(n / 3));
  return Math.min(pow2, triple);
}

interface RadixThreePlan {
  scratch: Float64Array[];
  cos: Float64Array;
  sin: Float64Array;
}

const radixThreePlans = new Map<number, RadixThreePlan>();

/** 3·2^k transform: one decimation-in-time radix-3 stage over three radix-2 sub-transforms. */
function fftRadixThree(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  const m = n / 3;
  let plan = radixThreePlans.get(n);
  if (!plan) {
    const cos = new Float64Array(n);
    const sin = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    plan = { scratch: Array.from({ length: 6 }, () => new Float64Array(m)), cos, sin };
    radixThreePlans.set(n, plan);
  }
  const [r0, i0, r1, i1, r2, i2] = plan.scratch as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array];
  for (let j = 0; j < m; j++) {
    r0[j] = re[3 * j]!;
    i0[j] = im[3 * j]!;
    r1[j] = re[3 * j + 1]!;
    i1[j] = im[3 * j + 1]!;
    r2[j] = re[3 * j + 2]!;
    i2[j] = im[3 * j + 2]!;
  }
  fftPow2(r0, i0, inverse);
  fftPow2(r1, i1, inverse);
  fftPow2(r2, i2, inverse);
  const sign = inverse ? 1 : -1;
  // ω = exp(±2πi/3) = −1/2 ± i√3/2
  const wr = -0.5;
  const wi = (sign * Math.sqrt(3)) / 2;
  const scale = inverse ? 1 / 3 : 1;
  for (let k = 0; k < m; k++) {
    const c1 = plan.cos[k]!;
    const s1 = sign * plan.sin[k]!;
    const c2 = plan.cos[(2 * k) % n]!;
    const s2 = sign * plan.sin[(2 * k) % n]!;
    const t1r = r1[k]! * c1 - i1[k]! * s1;
    const t1i = r1[k]! * s1 + i1[k]! * c1;
    const t2r = r2[k]! * c2 - i2[k]! * s2;
    const t2i = r2[k]! * s2 + i2[k]! * c2;
    const sr = t1r + t2r;
    const si = t1i + t2i;
    const dr = t1r - t2r;
    const di = t1i - t2i;
    const a0r = r0[k]!;
    const a0i = i0[k]!;
    re[k] = (a0r + sr) * scale;
    im[k] = (a0i + si) * scale;
    // a0 + ω t1 + ω² t2 and a0 + ω² t1 + ω t2, with ω² = conj(ω).
    const br = a0r + wr * sr;
    const bi = a0i + wr * si;
    re[k + m] = (br - wi * di) * scale;
    im[k + m] = (bi + wi * dr) * scale;
    re[k + 2 * m] = (br + wi * di) * scale;
    im[k + 2 * m] = (bi - wi * dr) * scale;
  }
}

/** In-place 1D FFT of length 2^k or 3·2^k. The inverse transform includes the 1/n normalization. */
export function fft1d(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n > 1 && !isPowerOfTwo(n) && n % 3 === 0 && isPowerOfTwo(n / 3)) {
    fftRadixThree(re, im, inverse);
    return;
  }
  fftPow2(re, im, inverse);
}

function fftPow2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n <= 1) return;
  const { reverse, cos, sin } = getPlan(n);
  for (let i = 0; i < n; i++) {
    const j = reverse[i]!;
    if (j > i) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >>> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0; j < half; j++) {
        const wr = cos[j * step]!;
        const wi = sign * sin[j * step]!;
        const a = start + j;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  if (inverse) {
    const scale = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! * scale;
      im[i] = im[i]! * scale;
    }
  }
}

/**
 * In-place 2D FFT of a row-major width × height grid. The forward
 * transform runs rows then columns, the inverse columns then rows, so
 * `rows` can restrict the row pass: forward, rows outside it must be zero;
 * inverse, rows outside it are left untransformed and must not be read.
 */
export function fft2d(
  re: Float64Array,
  im: Float64Array,
  width: number,
  height: number,
  inverse = false,
  rows: { first: number; last: number } = { first: 0, last: height - 1 },
): void {
  const first = Math.max(0, rows.first);
  const last = Math.min(height - 1, rows.last);
  const rowPass = () => {
    for (let row = first; row <= last; row++) {
      const offset = row * width;
      fft1d(re.subarray(offset, offset + width), im.subarray(offset, offset + width), inverse);
    }
  };
  if (!inverse) rowPass();
  const colRe = new Float64Array(height);
  const colIm = new Float64Array(height);
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      colRe[row] = re[row * width + col]!;
      colIm[row] = im[row * width + col]!;
    }
    fft1d(colRe, colIm, inverse);
    for (let row = 0; row < height; row++) {
      re[row * width + col] = colRe[row]!;
      im[row * width + col] = colIm[row]!;
    }
  }
  if (inverse) rowPass();
}

/** Signed spatial frequency (cycles per unit length) of FFT bin `index` for sample spacing `step`. */
export function spatialFrequency(index: number, n: number, step: number): number {
  return (index < n / 2 ? index : index - n) / (n * step);
}
