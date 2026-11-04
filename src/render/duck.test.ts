import { describe, expect, it } from "vitest";
import { imageDistance } from "../physics/optics";
import { mm, um } from "../physics/units";
import { renderOpticalImage } from "./pipeline";
import { createWildlifeStudio, DEFAULT_STUDIO, DUCK_HEAD_OFFSET } from "./studio";
import { baseShot, resolutionForPitch } from "./testScenes";
import type { PlaneLayer, RGBA, ShotSettings } from "./types";

const H = DEFAULT_STUDIO.cameraHeight;

function duckAt(distance: number): PlaneLayer {
  const scene = createWildlifeStudio({ ...DEFAULT_STUDIO, subjectDistance: distance, subjectSpeed: 0 });
  const duck = scene.layers.find((l) => l.id === "duck");
  if (!duck || duck.kind !== "plane") throw new Error("duck layer missing");
  return duck;
}

describe("3D duck", () => {
  it("reports the true depth of the surface each ray hits", () => {
    const s = 10;
    const duck = duckAt(s);
    const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    // Ray through the head centre (on the reference plane): hits the head's near side, 4 cm in front.
    duck.sample(0.165, -H + 0.235, 1e-5, out);
    expect(out.a).toBeCloseTo(1, 6);
    expect(out.z!).toBeCloseTo(-0.04, 3);
    // The eye (6 mm sphere at z = −3.3 cm) seen in perspective: its centre projects to X·s/(s + z).
    const k = s / (s - 0.033);
    duck.sample(0.183 * k, (-H + 0.245) * k, 1e-5, out);
    expect(out.z!).toBeCloseTo(-0.039, 3);
    // The flank, nearer still.
    duck.sample(-0.05, -H + 0.06, 1e-5, out);
    expect(out.z!).toBeLessThan(-0.08);
  });

  it("is opaque from the back to the waterline: the hull meets the water in front of it", () => {
    const duck = duckAt(30);
    const out: RGBA = { r: 0, g: 0, b: 0, a: 0 };
    for (const X of [-0.1, 0, 0.1]) {
      for (const Y of [-H + 0.02, -H + 0.001, -H - 0.002, -H - 0.05]) {
        duck.sample(X, Y, 1e-4, out);
        expect(out.a).toBeCloseTo(1, 6);
      }
    }
  });

  it("is sharp where it is in focus and soft elsewhere (1200 mm f/2.8 at 10 m: DOF ≈ 1.2 cm)", () => {
    const s = 10;
    const scene = createWildlifeStudio({ ...DEFAULT_STUDIO, subjectDistance: s, subjectSpeed: 0 });
    const pitch = um(4);
    const detail = (focus: number, x: number, y: number): number => {
      const shot: ShotSettings = { ...baseShot, focalLength: mm(1200), fNumber: 2.8, focusDistance: focus, resolution: resolutionForPitch(pitch) };
      const m = imageDistance(shot.focalLength, focus) / s;
      const n = 48;
      const image = renderOpticalImage(scene, shot, { centerX: x * m, centerY: y * m, width: n * pitch, height: n * pitch, outputPixelSize: pitch });
      let energy = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 1; j < n; j++) energy += (image.g[i * n + j]! - image.g[i * n + j - 1]!) ** 2;
      }
      return energy;
    };
    const head = { x: DUCK_HEAD_OFFSET.x, y: DUCK_HEAD_OFFSET.y };
    const flank = { x: -0.05, y: 0.06 - 0.12 };
    const onHead = s - 0.04;
    const onFlank = s - 0.09;
    expect(detail(onHead, head.x, head.y)).toBeGreaterThan(3 * detail(onFlank, head.x, head.y));
    expect(detail(onFlank, flank.x, flank.y)).toBeGreaterThan(3 * detail(onHead, flank.x, flank.y));
  }, 30_000);
});
