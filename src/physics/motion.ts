import { imageDistance } from "./optics";

/**
 * Blur length on the sensor from a subject moving perpendicular to the
 * optical axis at constant speed. The subject's image moves with the chief
 * ray, scale v_f / s, which equals f / (s − f) when the subject is in focus.
 */
export function subjectMotionBlur(
  subjectSpeed: number,
  objectDistance: number,
  focalLength: number,
  shutterTime: number,
  focusDistance = objectDistance,
): number {
  return (subjectSpeed * shutterTime * imageDistance(focalLength, focusDistance)) / objectDistance;
}

/**
 * Blur length on the sensor from camera rotation at constant angular speed
 * (rad/s): v_f · tan(ω t). Exact for a given angular speed; the speed itself
 * is heuristic.
 */
export function cameraRotationBlur(
  angularSpeed: number,
  focalLength: number,
  shutterTime: number,
  focusDistance = Infinity,
): number {
  return imageDistance(focalLength, focusDistance) * Math.tan(angularSpeed * shutterTime);
}
