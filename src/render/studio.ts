/**
 * 2.5D wildlife studio: a ray-traced drake mallard on a pond in front of a
 * wooded shore. The water is a true ground plane and a mirror: every object
 * standing in it has a reflection at its own distance.
 */
import { skyRadianceFactor, type SkyModel, type Vector3 } from "../physics/exposure";
import { createBackground, createTestChart } from "./background";
import { createDuck, DUCK_HEAD } from "./duck";
import type { PlaneLayer, RGBA, Scene, SceneLayer } from "./types";
import { createWaterSurface, elevationOf, mirroredPlane, standingPlane, waterLayer } from "./water";

export interface StudioOptions {
  subjectDistance: number;
  backgroundDistance: number;
  /** Camera height above the water, meters. */
  cameraHeight: number;
  /** Duck swimming speed to the right, m/s. */
  subjectSpeed: number;
  showTarget: boolean;
  sky: SkyModel;
  /**
   * Validation mode: every surface (not the sky) has this radiance factor,
   * so any seam or occlusion error shows up as a deviation from uniformity.
   */
  validationRadiance?: number;
}

export const DEFAULT_STUDIO: StudioOptions = {
  subjectDistance: 30,
  backgroundDistance: 60,
  cameraHeight: 1,
  subjectSpeed: 0.15,
  showTarget: false,
  sky: { kind: "cieOvercast" },
};

/** Height of the aim point above the waterline, meters. */
const DUCK_AIM_HEIGHT = 0.12;

/** Duck head centre relative to the aim point, in object meters; detail crops centre here. */
export const DUCK_HEAD_OFFSET = { x: DUCK_HEAD.x, y: DUCK_HEAD.y - DUCK_AIM_HEIGHT } as const;

function uniformPlane(layer: PlaneLayer, value: number, opaque: boolean): PlaneLayer {
  return {
    ...layer,
    sample(x, y, fp, out) {
      if (opaque) {
        out.r = out.g = out.b = value;
        out.a = 1;
        return;
      }
      layer.sample(x, y, fp, out);
      out.r = out.g = out.b = value * out.a;
    },
  };
}

/**
 * Drawing order, back to front: reflections (virtual images below the
 * waterline), the water surface as a Fresnel screen over them, the
 * background, the test chart and the duck, each continuing below its
 * waterline as the water in front of it.
 */
export function createWildlifeStudio(options: StudioOptions): Scene {
  const H = options.cameraHeight;
  const waterY = -H;
  const subject = options.subjectDistance;
  const D = Math.max(options.backgroundDistance, subject + 0.5);
  const near = Math.min(1.5, subject / 2);
  const uniform = options.validationRadiance;
  const sky = (elevation: number): number => skyRadianceFactor(options.sky, Math.abs(elevation));
  const water = createWaterSurface(H);
  const background = createBackground(D, waterY, options.sky);

  const seen: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  /** A reflected ray from a plane at distance `from`: the background, then the sky. */
  const beyondFrom =
    (from: number) =>
    (origin: Vector3, direction: Vector3, footprint: number, out: RGBA): void => {
      const skyValue = sky(elevationOf(direction));
      const t = D - origin.z;
      background.sample(origin.x + direction.x * t, Math.max(origin.y + direction.y * t, waterY), (footprint * D) / from, seen);
      out.r = seen.r + (1 - seen.a) * skyValue;
      out.g = seen.g + (1 - seen.a) * skyValue;
      out.b = seen.b + (1 - seen.a) * skyValue;
      out.a = 1;
    };

  const duck = createDuck({
    distance: subject,
    cameraHeight: H,
    speed: options.subjectSpeed,
    sky: options.sky,
    water,
    behind: beyondFrom(subject),
    ...(uniform !== undefined ? { uniform } : {}),
  });
  const chart = options.showTarget ? createTestChart(subject, waterY, options.sky) : null;

  let layers: SceneLayer[];
  if (uniform !== undefined) {
    layers = [
      waterLayer("water", water, near, 1e5, uniform),
      uniformPlane({ ...background, contactY: waterY, bounds: { ...background.bounds, minY: waterY - D } }, uniform, true),
      ...(chart ? [uniformPlane(chart, uniform, false)] : []),
      duck.real,
    ];
  } else {
    layers = [
      mirroredPlane(background, water),
      ...(chart ? [mirroredPlane(chart, water)] : []),
      duck.reflection,
      waterLayer("water", water, near, 1e5),
      standingPlane(background, water, sky),
      ...(chart ? [standingPlane(chart, water, sky, beyondFrom(subject))] : []),
      duck.real,
    ];
  }

  return {
    layers,
    sky,
    aim: { x: 0, y: waterY + DUCK_AIM_HEIGHT, distance: subject },
  };
}
