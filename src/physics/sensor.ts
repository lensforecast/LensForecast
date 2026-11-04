/**
 * Generic sensor model: geometry, photon-to-electron conversion, full-well
 * capacity, read noise and ISO as an output gain. Not modeled on any brand.
 */
import { saturationExposure } from "./exposure";

export interface SensorFormat {
  id: string;
  name: string;
  width: number;
  height: number;
}

export const FULL_FRAME: SensorFormat = { id: "fullFrame", name: "Full frame (36 × 24 mm)", width: 0.036, height: 0.024 };

export interface SensorResolution {
  id: string;
  label: string;
  pixelsX: number;
  pixelsY: number;
}

export const RESOLUTION_PRESETS: readonly SensorResolution[] = [
  { id: "24mp", label: "24 MP", pixelsX: 6000, pixelsY: 4000 },
  { id: "33mp", label: "33 MP", pixelsX: 7008, pixelsY: 4672 },
  { id: "61mp", label: "61 MP", pixelsX: 9564, pixelsY: 6376 },
];

export function megapixels(resolution: SensorResolution): number {
  return (resolution.pixelsX * resolution.pixelsY) / 1e6;
}

export function pixelPitch(format: SensorFormat, resolution: SensorResolution): number {
  return format.width / resolution.pixelsX;
}

/** Pixels remaining after cropping the frame by a linear factor (e.g. 2 for a 2× crop). */
export function croppedResolution(resolution: SensorResolution, cropFactor: number): SensorResolution {
  if (cropFactor < 1) throw new RangeError("Crop factor must be at least 1");
  return {
    id: `${resolution.id}-crop${cropFactor}`,
    label: `${resolution.label} cropped ${cropFactor}×`,
    pixelsX: Math.round(resolution.pixelsX / cropFactor),
    pixelsY: Math.round(resolution.pixelsY / cropFactor),
  };
}

const PLANCK = 6.62607015e-34;
const SPEED_OF_LIGHT = 299_792_458;
const LUMINOUS_EFFICACY_555NM = 683;

/**
 * Photons per m² per lux·second at 555 nm. Used as the effective flux of a
 * green-filtered pixel under daylight (approximation, roughly ±50%).
 */
export const PHOTONS_PER_LUX_SECOND_PER_M2 = 1 / (LUMINOUS_EFFICACY_555NM * ((PLANCK * SPEED_OF_LIGHT) / 555e-9));

export interface SensorModel {
  /** Effective quantum efficiency including the color filter. */
  quantumEfficiency: number;
  /** Full-well capacity per unit pixel area, electrons per m². */
  fullWellPerArea: number;
  /** Read noise in electrons RMS, assumed ISO-invariant. */
  readNoise: number;
}

/** Generic modern sensor: ~61k e⁻ full well at 6 µm pitch, base ISO near 100. */
export const GENERIC_SENSOR: SensorModel = {
  quantumEfficiency: 0.5,
  fullWellPerArea: 1700e12,
  readNoise: 2,
};

/** Mean photoelectrons collected by one pixel for focal-plane exposure H (lux·s). */
export function meanElectrons(exposure: number, pitch: number, sensor: SensorModel = GENERIC_SENSOR): number {
  return exposure * PHOTONS_PER_LUX_SECOND_PER_M2 * pitch * pitch * sensor.quantumEfficiency;
}

export function fullWellCapacity(pitch: number, sensor: SensorModel = GENERIC_SENSOR): number {
  return sensor.fullWellPerArea * pitch * pitch;
}

/** ISO at which the ISO 12232 saturation exposure exactly fills the well. Independent of pitch. */
export function baseIso(sensor: SensorModel = GENERIC_SENSOR): number {
  return (78 * PHOTONS_PER_LUX_SECOND_PER_M2 * sensor.quantumEfficiency) / sensor.fullWellPerArea;
}

/**
 * Electrons that map to output white at the given ISO. ISO is a gain: it
 * changes how electrons map to brightness, never how many are collected.
 */
export function electronsAtWhite(iso: number, pitch: number, sensor: SensorModel = GENERIC_SENSOR): number {
  return meanElectrons(saturationExposure(iso), pitch, sensor);
}

/** Normalized output brightness (0–1) for a noise-free pixel. */
export function outputLevel(exposure: number, iso: number, pitch: number, sensor: SensorModel = GENERIC_SENSOR): number {
  const collected = Math.min(meanElectrons(exposure, pitch, sensor), fullWellCapacity(pitch, sensor));
  return Math.min(collected / electronsAtWhite(iso, pitch, sensor), 1);
}

/** Per-pixel signal-to-noise ratio from shot noise and read noise. */
export function pixelSnr(exposure: number, pitch: number, sensor: SensorModel = GENERIC_SENSOR): number {
  const e = Math.min(meanElectrons(exposure, pitch, sensor), fullWellCapacity(pitch, sensor));
  return e / Math.sqrt(e + sensor.readNoise * sensor.readNoise);
}

/**
 * SNR after resampling to a common output pixel size (measured on the
 * sensor). This is the fair comparison between resolutions: shot noise per
 * unit area is independent of pixel count.
 */
export function snrAtOutputScale(
  exposure: number,
  pitch: number,
  outputPixelSize: number,
  sensor: SensorModel = GENERIC_SENSOR,
): number {
  const pixelsPerOutputPixel = (outputPixelSize / pitch) ** 2;
  return pixelSnr(exposure, pitch, sensor) * Math.sqrt(pixelsPerOutputPixel);
}
