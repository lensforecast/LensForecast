/**
 * Lightroom-style framing of a sensor image.
 * 100% (zoom = 1) maps one sensor pixel to one screen pixel. The 24 MP
 * frame is 6000 × 4000 of those pixels; other resolutions use their own grid.
 * Fit scales the whole sensor into the viewport.
 */

export type ZoomSetting = "fit" | number;

export interface FrameRequest {
  zoom: ZoomSetting;
  /** Viewport size in screen pixels. */
  viewportWidth: number;
  viewportHeight: number;
  pixelsX: number;
  pixelsY: number;
  /** Sensor size, meters. */
  sensorWidth: number;
  sensorHeight: number;
  /** Requested centre, meters on the sensor. Ignored for fit. */
  centerX: number;
  centerY: number;
}

export interface FramedView {
  centerX: number;
  centerY: number;
  /** Region of the sensor covered by the view, meters. */
  width: number;
  height: number;
  /** Meters on the sensor per rendered output pixel. Never finer than the pitch. */
  outputPixelSize: number;
  /** Screen pixels per sensor pixel. */
  zoom: number;
  outputWidth: number;
  outputHeight: number;
  /** Screen-pixel size of the image. Smaller than the viewport when letterboxed. */
  displayWidth: number;
  displayHeight: number;
  /** Each sensor pixel covers more than one screen pixel. */
  pixelated: boolean;
  /** Output pixel when it is coarser than the sensor pitch, otherwise 0. */
  displayPixel: number;
  /** The view shows only part of the sensor, so it can be panned. */
  cropped: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function frameView(req: FrameRequest): FramedView {
  const viewportWidth = Math.max(1, req.viewportWidth);
  const viewportHeight = Math.max(1, req.viewportHeight);
  const pitch = req.sensorWidth / req.pixelsX;
  const fitZoom = Math.min(viewportWidth / req.pixelsX, viewportHeight / req.pixelsY);
  const zoom = req.zoom === "fit" ? fitZoom : req.zoom;
  if (!(zoom > 0) || !Number.isFinite(zoom)) throw new RangeError("Zoom must be a positive number");

  const displayWidth = Math.min(viewportWidth, req.pixelsX * zoom);
  const displayHeight = Math.min(viewportHeight, req.pixelsY * zoom);

  let outputWidth: number;
  let outputHeight: number;
  let outputPixelSize: number;
  if (zoom >= 1) {
    outputWidth = Math.min(req.pixelsX, Math.max(1, Math.round(displayWidth / zoom)));
    outputHeight = Math.min(req.pixelsY, Math.max(1, Math.round(displayHeight / zoom)));
    outputPixelSize = pitch;
  } else {
    outputWidth = Math.max(1, Math.round(displayWidth));
    outputHeight = Math.max(1, Math.round(displayHeight));
    const sensorPixelsX = Math.min(req.pixelsX, displayWidth / zoom);
    outputPixelSize = Math.max(pitch, (sensorPixelsX * pitch) / outputWidth);
  }

  let width = outputWidth * outputPixelSize;
  let height = outputHeight * outputPixelSize;
  if (width > req.sensorWidth) {
    outputWidth = Math.max(1, Math.floor(req.sensorWidth / outputPixelSize));
    width = outputWidth * outputPixelSize;
  }
  if (height > req.sensorHeight) {
    outputHeight = Math.max(1, Math.floor(req.sensorHeight / outputPixelSize));
    height = outputHeight * outputPixelSize;
  }

  const maxX = Math.max(0, (req.sensorWidth - width) / 2);
  const maxY = Math.max(0, (req.sensorHeight - height) / 2);
  let centerX = req.zoom === "fit" ? 0 : clamp(req.centerX, -maxX, maxX);
  let centerY = req.zoom === "fit" ? 0 : clamp(req.centerY, -maxY, maxY);
  // A native crop selects existing sensor pixels; it must never shift their lattice.
  if (zoom >= 1) {
    const column = clamp(Math.round((centerX + maxX) / pitch), 0, req.pixelsX - outputWidth);
    const row = clamp(Math.round((maxY - centerY) / pitch), 0, req.pixelsY - outputHeight);
    centerX = column * pitch - maxX;
    centerY = maxY - row * pitch;
  }
  const cropped = req.sensorWidth - width > outputPixelSize * 1.5 || req.sensorHeight - height > outputPixelSize * 1.5;

  return {
    centerX,
    centerY,
    width,
    height,
    outputPixelSize,
    zoom,
    outputWidth,
    outputHeight,
    displayWidth,
    displayHeight,
    pixelated: zoom > 1.001,
    displayPixel: outputPixelSize > pitch * 1.001 ? outputPixelSize : 0,
    cropped,
  };
}
