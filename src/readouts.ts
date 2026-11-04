/**
 * Numbers shown beside each simulated photo. They use the same exposure,
 * working f-number and chief-ray geometry as the renderer, so the readouts
 * always describe the image that is displayed.
 */
import {
  aimAngle,
  blurBudget,
  blurCircleDiameter,
  checkLensEnvelope,
  depthOfField,
  fieldOfView,
  FULL_FRAME,
  lambertianLuminance,
  MAX_SHIFT_AIM_ANGLE,
  middleGreyExposure,
  pixelPitch,
  sensorExposure,
  snrAtOutputScale,
  stopsBetween,
  subjectMotionBlur,
  WAVELENGTHS,
  workingFNumber,
  type BlurSource,
  type LensEnvelopeCheck,
} from "./physics";
import type { StudioOptions } from "./render/studio";
import type { ShotSettings } from "./render/types";

const SUBJECT_REFLECTANCE = 0.18;
/** Height of the aim point above the water, matching the studio's duck centre. */
const AIM_HEIGHT = 0.12;

export interface Readouts {
  fieldOfView: number;
  depthOfField: number;
  pixelPitch: number;
  workingFNumber: number;
  subjectBlur: number;
  backgroundBlur: number;
  airyFwhm: number;
  /** EV of an 18% grey subject relative to ISO middle grey (10/S lux·s). */
  exposureOffsetEv: number;
  snr: number;
  motionBlur: number;
  motionBlurPixels: number;
  limitingFactor: BlurSource;
  lensEnvelope: LensEnvelopeCheck;
  aimAngle: number;
  aimWarning: boolean;
}

export function computeReadouts(
  shot: ShotSettings,
  studio: StudioOptions,
  display: { displayPixel: number; circleOfConfusion?: number },
): Readouts {
  const lens = { focalLength: shot.focalLength, fNumber: shot.fNumber };
  const pitch = pixelPitch(FULL_FRAME, shot.resolution);
  const nw = workingFNumber(lens, shot.focusDistance);
  const subjectBlur = blurCircleDiameter(lens, shot.focusDistance, studio.subjectDistance);
  const backgroundBlur = blurCircleDiameter(lens, shot.focusDistance, studio.backgroundDistance);
  const exposure = sensorExposure(
    lambertianLuminance(shot.illuminance, SUBJECT_REFLECTANCE),
    shot.focalLength,
    shot.fNumber,
    shot.focusDistance,
    shot.shutterTime,
  );
  const motion = subjectMotionBlur(studio.subjectSpeed, studio.subjectDistance, shot.focalLength, shot.shutterTime, shot.focusDistance);
  const budget = blurBudget({
    wavelength: WAVELENGTHS.green,
    workingFNumber: nw,
    defocusDiameter: subjectBlur,
    motionLength: motion,
    pixelPitch: pitch,
    displayPixel: display.displayPixel,
  });
  const dof = depthOfField(lens, shot.focusDistance, display.circleOfConfusion ?? 30e-6);
  const aim = aimAngle(studio.cameraHeight - AIM_HEIGHT, studio.subjectDistance);
  return {
    fieldOfView: fieldOfView(shot.focalLength, FULL_FRAME.width, shot.focusDistance),
    depthOfField: dof.total,
    pixelPitch: pitch,
    workingFNumber: nw,
    subjectBlur,
    backgroundBlur,
    airyFwhm: budget.contributions.diffraction,
    exposureOffsetEv: stopsBetween(middleGreyExposure(shot.iso), exposure),
    snr: snrAtOutputScale(exposure, pitch, Math.max(display.displayPixel, pitch)),
    motionBlur: motion,
    motionBlurPixels: motion / pitch,
    limitingFactor: budget.limitingFactor,
    lensEnvelope: checkLensEnvelope(lens),
    aimAngle: aim,
    aimWarning: aim > MAX_SHIFT_AIM_ANGLE,
  };
}
