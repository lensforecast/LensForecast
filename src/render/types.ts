import type { SensorResolution } from "../physics/sensor";

/**
 * Premultiplied radiance factor and coverage. Radiance factor 1 is the
 * luminance of a perfect white Lambertian surface: L = E / π.
 */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
  /** Depth of the sampled point relative to its layer's distance, meters (relief layers only). */
  z?: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * A fronto-parallel plane at a fixed distance from the camera. Object
 * coordinates are meters: X to the right, Y up, with the optical axis at
 * X = Y = 0 before aiming.
 */
export interface PlaneLayer {
  kind: "plane";
  id: string;
  distance: number;
  bounds: Bounds;
  /** Constant velocity in the object plane, m/s. */
  velocity?: { x: number; y: number };
  /**
   * Height where the plane stands on a ground layer. `sample` must continue
   * opaquely below it (a submerged part); an occluder-only ground layer whose
   * far cut is this distance hides it, and the renderer keeps only the part
   * within blur reach. Such planes must not move vertically.
   */
  contactY?: number;
  /**
   * A layer with depth: `sample` reports each point's depth offset `z` from
   * `distance`, within [near, far]. Coordinates stay those of the reference
   * plane at `distance` (the sample function handles its own perspective);
   * each point blurs by the blur circle of its own depth.
   */
  relief?: { near: number; far: number };
  /**
   * Writes the premultiplied radiance factor prefiltered by a separable tent
   * of half-width `footprint` (box ⊗ box of width `footprint`) centred on
   * (x, y). Outlines must be prefiltered too.
   */
  sample(x: number, y: number, footprint: number, out: RGBA): void;
}

/**
 * A horizontal surface at Y = −cameraHeight (relative to the lens), visible
 * between ground distances `nearDistance` and `farDistance`. Every image row
 * sees it at its own depth, so defocus varies continuously down the frame.
 */
export interface GroundLayer {
  kind: "ground";
  id: string;
  cameraHeight: number;
  nearDistance: number;
  farDistance: number;
  /**
   * The layer only matters where it occludes the blurred edges and submerged
   * parts of layers standing at its far cut (an identical surface is drawn
   * behind everything); the renderer may drop rows beyond that blur reach.
   */
  occluderOnly?: boolean;
  /**
   * Writes the premultiplied radiance factor prefiltered over a footprint of
   * `footprintX` × `footprintZ` meters (tent half-widths) centred on ground point (X, Z).
   */
  sample(groundX: number, groundZ: number, footprintX: number, footprintZ: number, out: RGBA): void;
}

export type SceneLayer = PlaneLayer | GroundLayer;

export interface Scene {
  /** Layers in drawing order, back to front. */
  layers: SceneLayer[];
  /** Radiance factor of the (neutral) sky as a function of elevation angle, radians. */
  sky: (elevation: number) => number;
  /** Object point placed at the frame centre (camera aim, modeled as image shift). */
  aim: { x: number; y: number; distance: number };
}

export interface ShotSettings {
  focalLength: number;
  fNumber: number;
  focusDistance: number;
  shutterTime: number;
  iso: number;
  /** Illuminance on camera-facing subject surfaces, lux. */
  illuminance: number;
  resolution: SensorResolution;
}

/** A rectangle on the sensor to render, and the output pixel size. */
export interface ViewSpec {
  /** Centre relative to the frame centre, meters on the sensor. */
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  /** Output pixel size on the sensor; clamped to at least the sensor pitch (binning). */
  outputPixelSize: number;
  /** Fine-grid samples per output pixel along each axis. */
  oversample?: number;
}
