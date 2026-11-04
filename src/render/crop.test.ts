import { describe, expect, it } from "vitest";
import { readOut, renderOpticalImage } from "./pipeline";
import { baseShot, planeScene } from "./testScenes";

describe("crop consistency", () => {
  it("preserves overlapping native pixels and their noise after a whole-pixel pan", () => {
    const pitch = 0.036 / baseShot.resolution.pixelsX;
    const scene = planeScene(20, () => 0.18);
    const view = { centerX: 0, centerY: 0, width: 24 * pitch, height: 24 * pitch, outputPixelSize: pitch };
    const a = renderOpticalImage(scene, baseShot, view);
    const b = renderOpticalImage(scene, baseShot, { ...view, centerX: 3 * pitch, centerY: -2 * pitch });
    const na = readOut(a, baseShot, { seed: 42 });
    const nb = readOut(b, baseShot, { seed: 42 });
    for (let y = 0; y < 22; y++) for (let x = 0; x < 21; x++) {
      const ia = (y + 2) * a.width + x + 3;
      const ib = y * b.width + x;
      expect(a.r[ia]).toBeCloseTo(b.r[ib]!, 10);
      for (let c = 0; c < 3; c++) expect(na[ia * 3 + c]).toBe(nb[ib * 3 + c]);
    }
  });
  it("rejects oversized FFT grids before allocation", () => {
    expect(() => renderOpticalImage(planeScene(20, () => 0.18), baseShot, {
      centerX: 0, centerY: 0, width: 1, height: 1, outputPixelSize: 0,
    })).toThrow("too large");
  });
});

it("keeps adjoining wildlife tiles consistent with a single native crop", async () => {
  const { createWildlifeStudio, DEFAULT_STUDIO, DUCK_HEAD_OFFSET } = await import("./studio");
  const shot = { ...baseShot, focalLength: 0.6, focusDistance: 30, fNumber: 5.6 };
  const pitch = 0.036 / shot.resolution.pixelsX;
  const scale = 0.6 / (30 - 0.6);
  const scene = createWildlifeStudio(DEFAULT_STUDIO);
  const view = { centerX: DUCK_HEAD_OFFSET.x * scale, centerY: DUCK_HEAD_OFFSET.y * scale, width: 128 * pitch, height: 64 * pitch, outputPixelSize: pitch };
  const whole = renderOpticalImage(scene, shot, view);
  const left = renderOpticalImage(scene, shot, { ...view, centerX: view.centerX - 32 * pitch, width: 64 * pitch });
  const right = renderOpticalImage(scene, shot, { ...view, centerX: view.centerX + 32 * pitch, width: 64 * pitch });
  let maxError = 0;
  for (const channel of ["r", "g", "b"] as const) for (let y = 8; y < 56; y++) for (let x = 60; x < 68; x++) {
    const tile = x < 64 ? left : right;
    const value = tile[channel][y * 64 + x % 64]!;
    maxError = Math.max(maxError, Math.abs(value - whole[channel][y * 128 + x]!));
  }
  expect(maxError).toBeLessThan(0.005);
});
