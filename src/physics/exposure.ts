/**
 * Photometric exposure. Luminance in cd/m², illuminance in lux, exposure in
 * lux·seconds.
 */
import { fresnelReflectance } from "./reflection";

/**
 * Lens factor q in the camera equation (ISO 2720). Bundles π/4, lens
 * transmission and on-axis vignetting into one typical value.
 */
export const LENS_FACTOR_Q = 0.65;

/** Reflected-light meter calibration constant K (ISO 2720, common value). */
export const METER_CONSTANT_K = 12.5;

/** Incident-light meter calibration constant C for a flat receptor. */
export const INCIDENT_METER_CONSTANT_C = 250;

export interface CameraEquationOptions {
  /** Lens factor q; defaults to LENS_FACTOR_Q. */
  q?: number;
  /** Lateral magnification; adds the (1 + m)² bellows factor at close focus. */
  magnification?: number;
}

/** Focal-plane illuminance E = q · L / (N² (1 + m)²). */
export function focalPlaneIlluminance(
  sceneLuminance: number,
  fNumber: number,
  { q = LENS_FACTOR_Q, magnification = 0 }: CameraEquationOptions = {},
): number {
  const bellows = (1 + magnification) ** 2;
  return (q * sceneLuminance) / (fNumber * fNumber * bellows);
}

/** Focal-plane exposure H = E · t. */
export function focalPlaneExposure(
  sceneLuminance: number,
  fNumber: number,
  shutterTime: number,
  options?: CameraEquationOptions,
): number {
  return focalPlaneIlluminance(sceneLuminance, fNumber, options) * shutterTime;
}

/** Luminance of a Lambertian surface: L = ρ · E / π. */
export function lambertianLuminance(illuminance: number, reflectance: number): number {
  return (reflectance * illuminance) / Math.PI;
}

/** Exposure value of a camera setting: EV = log₂(N² / t). */
export function exposureValue(fNumber: number, shutterTime: number): number {
  return Math.log2((fNumber * fNumber) / shutterTime);
}

/** Difference in stops between two exposures (positive when `to` is brighter). */
export function stopsBetween(from: number, to: number): number {
  return Math.log2(to / from);
}

/** Shutter time a reflected-light meter recommends: t = K · N² / (L · S). */
export function meteredShutterTime(
  sceneLuminance: number,
  fNumber: number,
  iso: number,
  k = METER_CONSTANT_K,
): number {
  return (k * fNumber * fNumber) / (sceneLuminance * iso);
}

/** Shutter time an incident-light meter recommends: t = C · N² / (E · S). */
export function incidentMeteredShutterTime(
  illuminance: number,
  fNumber: number,
  iso: number,
  c = INCIDENT_METER_CONSTANT_C,
): number {
  return (c * fNumber * fNumber) / (illuminance * iso);
}

/** ISO 12232 standard output sensitivity: middle grey lands at H_m = 10 / S. */
export function middleGreyExposure(iso: number): number {
  return 10 / iso;
}

/** ISO 12232 saturation-based sensitivity: the output clips at H_sat = 78 / S. */
export function saturationExposure(iso: number): number {
  return 78 / iso;
}

/**
 * Sky luminance model. Sky radiance factors are relative to E/π, where E is
 * the illuminance on the subject's camera-facing (vertical) surfaces, so a
 * white Lambertian subject has radiance factor 1.
 */
export type SkyModel =
  | { kind: "cieOvercast" }
  /**
   * Clear or hazy sky with a fixed horizon luminance expressed as a radiance
   * factor; with `sunElevation` (radians), direct sun from behind the
   * photographer supplies the rest of the subject illuminance.
   */
  | { kind: "uniform"; radianceFactor: number; sunElevation?: number };

/**
 * CIE standard overcast sky: L(γ) = L_z (1 + 2 sin γ) / 3. Integrating over
 * the half sky in front of a vertical surface gives
 *   E_v = 2 ∫₀^{π/2} L(γ) cos²γ dγ = (2/3)(π/4 + 2/3) L_z ≈ 0.968 L_z.
 */
export const CIE_OVERCAST_VERTICAL_ILLUMINANCE_PER_ZENITH_LUMINANCE = (2 / 3) * (Math.PI / 4 + 2 / 3);

/**
 * The lower half of the same view: calm water mirroring the sky at depression
 * δ with Fresnel reflectance R(cos θ = sin δ),
 *   E_w = 2 ∫₀^{π/2} R(sin δ) L(δ) cos²δ dδ ≈ 0.148 L_z.
 * The water body's own upwelling light (about 1% of E_v) and ripples are neglected.
 */
export const CIE_OVERCAST_WATER_ILLUMINANCE_PER_ZENITH_LUMINANCE = (() => {
  const n = 2000;
  const h = Math.PI / 2 / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const d = i * h;
    const weight = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    sum += weight * fresnelReflectance(Math.sin(d)) * ((1 + 2 * Math.sin(d)) / 3) * Math.cos(d) ** 2;
  }
  return (2 * sum * h) / 3;
})();

/** Sky radiance factor at elevation γ (radians above the horizon). */
export function skyRadianceFactor(sky: SkyModel, elevation: number): number {
  if (sky.kind === "uniform") return sky.radianceFactor;
  const gamma = Math.max(elevation, 0);
  const subjectIlluminance = CIE_OVERCAST_VERTICAL_ILLUMINANCE_PER_ZENITH_LUMINANCE + CIE_OVERCAST_WATER_ILLUMINANCE_PER_ZENITH_LUMINANCE;
  return (Math.PI * (1 + 2 * Math.sin(gamma))) / 3 / subjectIlluminance;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

const IRRADIANCE_TABLE_SIZE = 181;
const irradianceTables = new Map<string, Float64Array>();

/**
 * Sky irradiance factor (1/π)∫ρ(ω)(n·ω)⁺dω as a function of the normal's
 * elevation β. Below the horizon the sky is seen mirrored in calm water with
 * Fresnel reflectance R(sin δ). The sky is azimuthally symmetric, so only β matters.
 */
function skyIrradianceTable(sky: SkyModel): Float64Array {
  const key = sky.kind === "uniform" ? `u${sky.radianceFactor}` : "cie";
  const cached = irradianceTables.get(key);
  if (cached) return cached;
  const ne = 120;
  const na = 240;
  const de = Math.PI / ne;
  const da = (2 * Math.PI) / na;
  const radiance: number[] = [];
  for (let i = 0; i < ne; i++) {
    const e = -Math.PI / 2 + (i + 0.5) * de;
    const sky0 = skyRadianceFactor(sky, Math.abs(e));
    radiance.push(e >= 0 ? sky0 : fresnelReflectance(Math.sin(-e)) * sky0);
  }
  const table = new Float64Array(IRRADIANCE_TABLE_SIZE);
  for (let t = 0; t < IRRADIANCE_TABLE_SIZE; t++) {
    const beta = -Math.PI / 2 + (t * Math.PI) / (IRRADIANCE_TABLE_SIZE - 1);
    const ny = Math.sin(beta);
    const nz = -Math.cos(beta);
    let sum = 0;
    for (let i = 0; i < ne; i++) {
      const e = -Math.PI / 2 + (i + 0.5) * de;
      const ce = Math.cos(e);
      const se = Math.sin(e);
      for (let j = 0; j < na; j++) {
        const cosine = se * ny + ce * Math.cos((j + 0.5) * da) * nz;
        if (cosine > 0) sum += radiance[i]! * cosine * ce;
      }
    }
    table[t] = (sum * de * da) / Math.PI;
  }
  irradianceTables.set(key, table);
  return table;
}

/**
 * Irradiance on a Lambertian surface with unit normal n (x right, y up,
 * z away from the camera) relative to a camera-facing vertical surface,
 * which the lighting presets define. Multiplying by albedo gives the
 * radiance factor. Shadows and interreflections are not modeled.
 */
export function surfaceIrradianceFactor(sky: SkyModel, normal: Vector3): number {
  const table = skyIrradianceTable(sky);
  const t = ((Math.asin(Math.min(Math.max(normal.y, -1), 1)) + Math.PI / 2) / Math.PI) * (IRRADIANCE_TABLE_SIZE - 1);
  const i = Math.min(Math.floor(t), IRRADIANCE_TABLE_SIZE - 2);
  const f = t - i;
  const skyPart = table[i]! * (1 - f) + table[i + 1]! * f;
  if (sky.kind !== "uniform" || sky.sunElevation === undefined) return skyPart;
  const e = sky.sunElevation;
  const facing = table[(IRRADIANCE_TABLE_SIZE - 1) / 2]!;
  const reflectance = fresnelReflectance(Math.sin(e));
  const k = (1 - facing) / (Math.cos(e) * (1 + reflectance));
  const direct = Math.max(0, normal.y * Math.sin(e) - normal.z * Math.cos(e));
  const mirrored = Math.max(0, -normal.y * Math.sin(e) - normal.z * Math.cos(e));
  return skyPart + k * (direct + reflectance * mirrored);
}

export interface LightingPreset {
  id: string;
  name: string;
  /** Illuminance on the subject's camera-facing surfaces (incident meter pointed at the camera), lux. */
  illuminance: number;
  sky: SkyModel;
}

/**
 * Representative conditions; real scenes vary widely (approximation).
 * Clear-sky horizon luminance is typically 5–10 kcd/m²; the sun and hazy
 * presets use 8 and 6 kcd/m² with the sun behind the photographer. Overcast
 * and dusk use the CIE overcast sky.
 */
export const LIGHTING_PRESETS: readonly LightingPreset[] = [
  {
    id: "sun",
    name: "Sun behind photographer",
    illuminance: 75_000,
    sky: { kind: "uniform", radianceFactor: (8000 * Math.PI) / 75_000, sunElevation: (35 * Math.PI) / 180 },
  },
  {
    id: "hazy",
    name: "Hazy sun",
    illuminance: 30_000,
    sky: { kind: "uniform", radianceFactor: (6000 * Math.PI) / 30_000, sunElevation: (35 * Math.PI) / 180 },
  },
  { id: "overcast", name: "Overcast", illuminance: 5_000, sky: { kind: "cieOvercast" } },
  { id: "heavyOvercast", name: "Heavy overcast", illuminance: 1_000, sky: { kind: "cieOvercast" } },
  { id: "dusk", name: "Dusk", illuminance: 50, sky: { kind: "cieOvercast" } },
];

/**
 * Focal-plane exposure for a subject of the given luminance, including the
 * bellows factor at the focus distance. Shared by the renderer and readouts.
 */
export function sensorExposure(
  sceneLuminance: number,
  focalLength: number,
  fNumber: number,
  focusDistance: number,
  shutterTime: number,
): number {
  const magnification = focusDistance === Infinity ? 0 : focalLength / (focusDistance - focalLength);
  return focalPlaneExposure(sceneLuminance, fNumber, shutterTime, { magnification });
}
