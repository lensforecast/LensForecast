/**
 * Analytic optical transfer functions. Applying blur by multiplying these in
 * the frequency domain avoids kernel-sampling errors entirely.
 */
import { besselJ1 } from "../physics/diffraction";

/** sin(πx) / (πx). */
export function sincPi(x: number): number {
  if (Math.abs(x) < 1e-12) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** OTF of a uniform disk of the given diameter (geometric defocus): 2 J1(πdρ) / (πdρ). */
export function diskOtf(diameter: number, radialFrequency: number): number {
  const x = Math.PI * diameter * radialFrequency;
  if (Math.abs(x) < 1e-9) return 1;
  return (2 * besselJ1(x)) / x;
}

/** OTF of a box (uniform integration) of the given width along one axis. */
export function boxOtf(width: number, frequency: number): number {
  return sincPi(width * frequency);
}

/** OTF of a centered uniform line segment with extent (dx, dy): constant-velocity motion. */
export function lineOtf(dx: number, dy: number, fx: number, fy: number): number {
  return sincPi(dx * fx + dy * fy);
}
