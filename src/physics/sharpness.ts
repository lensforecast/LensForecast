import { airyFwhm } from "./diffraction";

export type BlurSource = "diffraction" | "defocus" | "motion" | "pixel";

export interface BlurContributions {
  diffraction: number;
  defocus: number;
  motion: number;
  pixel: number;
}

export interface BlurBudget {
  contributions: BlurContributions;
  /** Root-sum-square of all widths. A rough summary, not a rendered PSF. */
  combined: number;
  limitingFactor: BlurSource;
}

/**
 * Heuristic "what limits sharpness here?" summary. Each blur is reduced to a
 * single width on the sensor (diffraction FWHM at the working f-number,
 * defocus circle diameter, motion streak length, and the larger of the pixel
 * pitch and the displayed output pixel) and combined in quadrature. This is
 * an empirical rule for UI guidance; rendered images use full OTFs.
 */
export function blurBudget(params: {
  wavelength: number;
  workingFNumber: number;
  defocusDiameter: number;
  motionLength: number;
  pixelPitch: number;
  displayPixel?: number;
}): BlurBudget {
  const contributions: BlurContributions = {
    diffraction: airyFwhm(params.wavelength, params.workingFNumber),
    defocus: params.defocusDiameter,
    motion: params.motionLength,
    pixel: Math.max(params.pixelPitch, params.displayPixel ?? 0),
  };
  const entries = Object.entries(contributions) as [BlurSource, number][];
  const combined = Math.sqrt(entries.reduce((sum, [, w]) => sum + w * w, 0));
  const [limitingFactor] = entries.reduce((max, entry) => (entry[1] > max[1] ? entry : max));
  return { contributions, combined, limitingFactor };
}
