import { describe, expect, it } from "vitest";
import { FULL_FRAME, pixelPitch, RESOLUTION_PRESETS } from "./physics";
import { frameView } from "./view";

const res24 = RESOLUTION_PRESETS[0]!;
const res61 = RESOLUTION_PRESETS[3]!;
const pitch24 = pixelPitch(FULL_FRAME, res24);

const sensor = {
  pixelsX: res24.pixelsX,
  pixelsY: res24.pixelsY,
  sensorWidth: FULL_FRAME.width,
  sensorHeight: FULL_FRAME.height,
};

describe("frameView", () => {
  const viewport = { viewportWidth: 600, viewportHeight: 400 };

  it("shows one sensor pixel per screen pixel at 100%", () => {
    const view = frameView({ ...sensor, ...viewport, zoom: 1, centerX: 0, centerY: 0 });
    expect(view.outputWidth).toBe(600);
    expect(view.outputHeight).toBe(400);
    expect(view.outputPixelSize).toBeCloseTo(pitch24);
    expect(view.width).toBeCloseTo(600 * pitch24);
    expect(view.zoom).toBe(1);
    expect(view.pixelated).toBe(false);
    expect(view.displayPixel).toBe(0);
    expect(view.cropped).toBe(true);
    expect(view.displayWidth).toBe(600);
    expect(view.displayHeight).toBe(400);
  });

  it("covers twice as many sensor pixels at 50%", () => {
    const view = frameView({ ...sensor, ...viewport, zoom: 0.5, centerX: 0, centerY: 0 });
    expect(view.outputWidth).toBe(600);
    expect(view.outputHeight).toBe(400);
    expect(view.outputPixelSize).toBeCloseTo(2 * pitch24);
    expect(view.width).toBeCloseTo(1200 * pitch24);
    expect(view.height).toBeCloseTo(800 * pitch24);
    expect(view.displayPixel).toBeCloseTo(2 * pitch24);
  });

  it("enlarges native pixels at 200%", () => {
    const view = frameView({ ...sensor, ...viewport, zoom: 2, centerX: 0, centerY: 0 });
    expect(view.outputWidth).toBe(300);
    expect(view.outputHeight).toBe(200);
    expect(view.outputPixelSize).toBeCloseTo(pitch24);
    expect(view.width).toBeCloseTo(300 * pitch24);
    expect(view.pixelated).toBe(true);
    expect(view.displayWidth).toBe(600);
    expect(view.displayPixel).toBe(0);
  });

  it("fits the whole 6000 × 4000 frame into the viewport", () => {
    const view = frameView({ ...sensor, ...viewport, zoom: "fit", centerX: 1, centerY: 1 });
    expect(view.zoom).toBeCloseTo(600 / 6000);
    expect(view.outputWidth).toBe(600);
    expect(view.outputHeight).toBe(400);
    expect(view.width).toBeCloseTo(FULL_FRAME.width);
    expect(view.height).toBeCloseTo(FULL_FRAME.height);
    expect(view.centerX).toBe(0);
    expect(view.centerY).toBe(0);
    expect(view.cropped).toBe(false);
    expect(view.displayPixel).toBeCloseTo(FULL_FRAME.width / 600);
  });

  it("letterboxes a zoom that is coarser than fit", () => {
    const view = frameView({ ...sensor, ...viewport, zoom: 0.05, centerX: 0, centerY: 0 });
    expect(view.displayWidth).toBeCloseTo(6000 * 0.05);
    expect(view.displayHeight).toBeCloseTo(4000 * 0.05);
    expect(view.width).toBeCloseTo(FULL_FRAME.width);
    expect(view.cropped).toBe(false);
  });

  it("keeps the window inside the sensor", () => {
    const view = frameView({ ...sensor, ...viewport, zoom: 1, centerX: 1, centerY: -1 });
    const maxX = (FULL_FRAME.width - view.width) / 2;
    const maxY = (FULL_FRAME.height - view.height) / 2;
    expect(view.centerX).toBeCloseTo(maxX);
    expect(view.centerY).toBeCloseTo(-maxY);
    expect(view.centerX + view.width / 2).toBeLessThanOrEqual(FULL_FRAME.width / 2 + pitch24);
    expect(view.centerY - view.height / 2).toBeGreaterThanOrEqual(-FULL_FRAME.height / 2 - pitch24);
  });

  it("shows a smaller piece of the scene on a finer sensor at the same percentage", () => {
    const pitch61 = pixelPitch(FULL_FRAME, res61);
    const fine = frameView({
      ...viewport,
      zoom: 1,
      centerX: 0,
      centerY: 0,
      pixelsX: res61.pixelsX,
      pixelsY: res61.pixelsY,
      sensorWidth: FULL_FRAME.width,
      sensorHeight: FULL_FRAME.height,
    });
    const coarse = frameView({ ...sensor, ...viewport, zoom: 1, centerX: 0, centerY: 0 });
    expect(fine.outputWidth).toBe(coarse.outputWidth);
    expect(fine.width).toBeCloseTo(600 * pitch61);
    expect(fine.width).toBeLessThan(coarse.width);
  });
});

describe("native sensor lattice", () => {
  it.each([1, 2, 4])("keeps fractional pans and odd crop widths on existing sensor pixels at %s×", (zoom) => {
    for (const width of [599, 600, 601]) {
      for (const center of [0, 0.25 * pitch24, -0.7 * pitch24, 1]) {
        const view = frameView({ ...sensor, zoom, viewportWidth: width, viewportHeight: 399, centerX: center, centerY: center });
        const column = (view.centerX - view.width / 2 + sensor.sensorWidth / 2) / pitch24;
        const row = (sensor.sensorHeight / 2 - view.centerY - view.height / 2) / pitch24;
        expect(column).toBeCloseTo(Math.round(column), 8);
        expect(row).toBeCloseTo(Math.round(row), 8);
      }
    }
  });
});
