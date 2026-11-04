/** Refractive index of water in the visible (≈ 1.333 at 589 nm, 20 °C). */
export const WATER_REFRACTIVE_INDEX = 1.333;

/**
 * Unpolarized Fresnel reflectance for light arriving from air onto a
 * dielectric of refractive index n, as a function of cos(incidence angle).
 */
export function fresnelReflectance(cosIncidence: number, n = WATER_REFRACTIVE_INDEX): number {
  const cosI = Math.min(Math.max(cosIncidence, 0), 1);
  const sinT = Math.sqrt(1 - cosI * cosI) / n;
  const cosT = Math.sqrt(Math.max(1 - sinT * sinT, 0));
  const rs = (cosI - n * cosT) / (cosI + n * cosT);
  const rp = (n * cosI - cosT) / (n * cosI + cosT);
  return (rs * rs + rp * rp) / 2;
}
