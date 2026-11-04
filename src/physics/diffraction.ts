/**
 * Fraunhofer diffraction of an aberration-free circular aperture.
 * Lengths in meters; spatial frequencies in cycles per meter on the sensor.
 */

/**
 * Bessel function of the first kind, order 1. Rational approximation from
 * Numerical Recipes (absolute error below ~1e-8).
 */
export function besselJ1(x: number): number {
  const ax = Math.abs(x);
  if (ax < 8) {
    const y = x * x;
    const num =
      x *
      (72362614232.0 +
        y * (-7895059235.0 + y * (242396853.1 + y * (-2972611.439 + y * (15704.4826 + y * -30.16036606)))));
    const den =
      144725228442.0 + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
    return num / den;
  }
  const z = 8 / ax;
  const y = z * z;
  const xx = ax - 2.356194491;
  const p = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
  const q =
    0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
  const ans = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q);
  return x < 0 ? -ans : ans;
}

/** First zero of J1 divided by π: the Airy first dark ring is at r = 1.21967 λN. */
const AIRY_FIRST_ZERO = 1.2196698912665045;

/** Diameter of the Airy disk to its first dark ring: ≈ 2.44 λN. */
export function airyDiskDiameter(wavelength: number, fNumber: number): number {
  return 2 * AIRY_FIRST_ZERO * wavelength * fNumber;
}

/** Full width at half maximum of the Airy pattern: ≈ 1.029 λN. */
export function airyFwhm(wavelength: number, fNumber: number): number {
  return 1.0289939 * wavelength * fNumber;
}

/** Normalized Airy intensity I(r)/I(0) = [2 J1(x) / x]², x = π r / (λN). */
export function airyIntensity(radius: number, wavelength: number, fNumber: number): number {
  const x = (Math.PI * radius) / (wavelength * fNumber);
  if (Math.abs(x) < 1e-9) return 1;
  const v = (2 * besselJ1(x)) / x;
  return v * v;
}

/** Incoherent cutoff frequency 1 / (λN): no detail finer than this reaches the sensor. */
export function diffractionCutoffFrequency(wavelength: number, fNumber: number): number {
  return 1 / (wavelength * fNumber);
}

/** Diffraction-limited MTF of a circular aperture. */
export function diffractionMtf(frequency: number, wavelength: number, fNumber: number): number {
  const nu = Math.abs(frequency) / diffractionCutoffFrequency(wavelength, fNumber);
  if (nu >= 1) return 0;
  return (2 / Math.PI) * (Math.acos(nu) - nu * Math.sqrt(1 - nu * nu));
}

/**
 * Exact OTF of an aberration-free circular pupil with defocus (Hopkins 1955),
 * parameterized by the geometric blur-circle diameter c on the sensor. The
 * peak defocus wavefront error is W₀₂₀ = c / (8 N_w). With the substitution
 * x + s = cos φ the pupil autocorrelation becomes
 *   H(s) = (4/π) ∫₀^{acos s} sin²φ · cos(π c f (cos φ − s)) dφ,   s = f λ N_w,
 * which reduces to the diffraction MTF for c = 0 and to the geometric disk
 * OTF times the diffraction MTF for large c.
 */
export function defocusedOtf(frequency: number, blurDiameter: number, wavelength: number, fNumber: number): number {
  const f = Math.abs(frequency);
  const s = f * wavelength * fNumber;
  if (s >= 1) return 0;
  if (blurDiameter === 0) return diffractionMtf(f, wavelength, fNumber);
  const b = Math.PI * blurDiameter * f;
  const upper = Math.acos(s);
  const oscillations = (b * (1 - s)) / Math.PI;
  let n = Math.max(64, Math.ceil(oscillations * 16));
  if (n % 2) n++;
  const step = upper / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const phi = i * step;
    const sinPhi = Math.sin(phi);
    const value = sinPhi * sinPhi * Math.cos(b * (Math.cos(phi) - s));
    sum += value * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
  }
  return ((4 / Math.PI) * sum * step) / 3;
}

/**
 * Wavelength samples standing in for each colour channel's spectral
 * response (approximation: flat response across the band).
 */
export const COLOR_BANDS = {
  red: [580e-9, 597.5e-9, 615e-9, 632.5e-9, 650e-9],
  green: [500e-9, 520e-9, 540e-9, 560e-9, 580e-9],
  blue: [420e-9, 437.5e-9, 455e-9, 472.5e-9, 490e-9],
} as const;

export type ColorChannel = keyof typeof COLOR_BANDS;

/** Diffraction MTF averaged over a colour band. */
export function bandDiffractionMtf(frequency: number, band: readonly number[], fNumber: number): number {
  let sum = 0;
  for (const wavelength of band) sum += diffractionMtf(frequency, wavelength, fNumber);
  return sum / band.length;
}

/** Defocused-pupil OTF averaged over a colour band. */
export function bandDefocusedOtf(frequency: number, blurDiameter: number, band: readonly number[], fNumber: number): number {
  let sum = 0;
  for (const wavelength of band) sum += defocusedOtf(frequency, blurDiameter, wavelength, fNumber);
  return sum / band.length;
}

/** Nyquist frequency of a sampling grid with the given pixel pitch. */
export function nyquistFrequency(pixelPitch: number): number {
  return 1 / (2 * pixelPitch);
}

/** Pixel-aperture MTF for a 100% fill-factor square pixel: |sinc(f · pitch)|. */
export function pixelApertureMtf(frequency: number, pixelPitch: number): number {
  const x = Math.PI * frequency * pixelPitch;
  if (Math.abs(x) < 1e-12) return 1;
  return Math.abs(Math.sin(x) / x);
}
