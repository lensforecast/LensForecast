/**
 * Geometric (thin-lens) optics. Lengths in meters; distances are measured
 * from the lens to the object.
 */

export interface Lens {
  focalLength: number;
  fNumber: number;
}

function assertBeyondFocalLength(distance: number, focalLength: number): void {
  if (!(distance > focalLength)) {
    throw new RangeError(`Object distance ${distance} m must exceed focal length ${focalLength} m`);
  }
}

export function entrancePupilDiameter(lens: Lens): number {
  return lens.focalLength / lens.fNumber;
}

/** Thin-lens equation 1/f = 1/s + 1/v, solved for the image distance v. */
export function imageDistance(focalLength: number, objectDistance: number): number {
  if (objectDistance === Infinity) return focalLength;
  assertBeyondFocalLength(objectDistance, focalLength);
  return (focalLength * objectDistance) / (objectDistance - focalLength);
}

/** Lateral magnification m = v / s = f / (s − f). */
export function magnification(focalLength: number, objectDistance: number): number {
  if (objectDistance === Infinity) return 0;
  assertBeyondFocalLength(objectDistance, focalLength);
  return focalLength / (objectDistance - focalLength);
}

/**
 * Angular field of view across one sensor dimension. Uses the image distance
 * at the focus distance, so focusing closer narrows the view slightly.
 */
export function fieldOfView(focalLength: number, sensorDimension: number, focusDistance = Infinity): number {
  const v = imageDistance(focalLength, focusDistance);
  return 2 * Math.atan(sensorDimension / (2 * v));
}

/** Width of the scene covered by one sensor dimension at a given object distance. */
export function frameCoverageAt(focalLength: number, sensorDimension: number, objectDistance: number): number {
  return sensorDimension / magnification(focalLength, objectDistance);
}

/**
 * Diameter of the geometric blur circle on the sensor for an object at
 * `objectDistance` when the lens is focused at `focusDistance`:
 *   c = A · |s − s_f| / s · f / (s_f − f),   A = f / N
 */
export function blurCircleDiameter(lens: Lens, focusDistance: number, objectDistance: number): number {
  const { focalLength: f } = lens;
  assertBeyondFocalLength(focusDistance, f);
  const A = entrancePupilDiameter(lens);
  const m = f / (focusDistance - f);
  if (objectDistance === Infinity) return A * m;
  return (A * Math.abs(objectDistance - focusDistance) * m) / objectDistance;
}

/**
 * Working (image-space) f-number N_w = N (1 + m) for pupil magnification 1.
 * Governs diffraction and image irradiance at finite focus distances.
 */
export function workingFNumber(lens: Lens, focusDistance: number): number {
  return lens.fNumber * (1 + magnification(lens.focalLength, focusDistance));
}

/**
 * Scale from object plane to sensor for a plane at `objectDistance` when the
 * lens is focused at `focusDistance`: v_f / s (chief ray through the pupil centre).
 */
export function chiefRayScale(focalLength: number, focusDistance: number, objectDistance: number): number {
  return imageDistance(focalLength, focusDistance) / objectDistance;
}

/** Hyperfocal distance H = f² / (N c) + f. */
export function hyperfocalDistance(lens: Lens, circleOfConfusion: number): number {
  const { focalLength: f, fNumber: N } = lens;
  return (f * f) / (N * circleOfConfusion) + f;
}

export interface DepthOfField {
  near: number;
  far: number;
  total: number;
}

/** Near and far limits of acceptable sharpness for a chosen circle of confusion. */
export function depthOfField(lens: Lens, focusDistance: number, circleOfConfusion: number): DepthOfField {
  const f = lens.focalLength;
  assertBeyondFocalLength(focusDistance, f);
  const H = hyperfocalDistance(lens, circleOfConfusion);
  const s = focusDistance;
  const near = (s * (H - f)) / (H + s - 2 * f);
  const far = s < H ? (s * (H - f)) / (H - s) : Infinity;
  return { near, far, total: far - near };
}

/** Largest entrance pupil found in commercially common lenses (e.g. 600 mm f/4 ≈ 150 mm). */
export const TYPICAL_MAX_ENTRANCE_PUPIL = 0.16;

export interface LensEnvelopeCheck {
  realistic: boolean;
  entrancePupil: number;
}

export function checkLensEnvelope(lens: Lens, maxPupil = TYPICAL_MAX_ENTRANCE_PUPIL): LensEnvelopeCheck {
  const entrancePupil = entrancePupilDiameter(lens);
  return { realistic: entrancePupil <= maxPupil, entrancePupil };
}

/**
 * Largest aim angle for which modeling camera aim as an image shift (instead
 * of a tilt) keeps geometric errors near 1% or below.
 */
export const MAX_SHIFT_AIM_ANGLE = (5 * Math.PI) / 180;

/** Angle between the horizontal optical axis and the line to an aim point. */
export function aimAngle(verticalOffset: number, distance: number): number {
  return Math.atan(Math.abs(verticalOffset) / distance);
}
