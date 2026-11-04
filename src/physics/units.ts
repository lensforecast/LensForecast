/** All physics functions take SI units (meters, seconds). These helpers keep call sites readable. */
export const mm = (value: number): number => value * 1e-3;
export const um = (value: number): number => value * 1e-6;
export const nm = (value: number): number => value * 1e-9;

export const toMm = (meters: number): number => meters * 1e3;
export const toUm = (meters: number): number => meters * 1e6;

export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Representative wavelengths for three-band rendering (blue, green, red). */
export const WAVELENGTHS = {
  blue: nm(450),
  green: nm(550),
  red: nm(620),
} as const;
