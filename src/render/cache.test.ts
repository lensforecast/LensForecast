import { describe, expect, it, vi } from "vitest";
import { OpticalCache } from "./cache";
import { renderOpticalImage } from "./pipeline";
import type { RenderRequest } from "./protocol";
import { DEFAULT_STUDIO } from "./studio";
import { baseShot, planeScene } from "./testScenes";

const request: RenderRequest = { id: 1, studio: DEFAULT_STUDIO, shot: baseShot, view: { centerX: 0, centerY: 0, width: 0.0001, height: 0.0001, outputPixelSize: 0.000025 }, noise: true, seed: 1 };
const makeImage = () => renderOpticalImage(planeScene(20, () => 0.18), baseShot, request.view);

describe("optical image reuse", () => {
  it("reuses optics for ISO, noise and illumination readout changes", () => {
    const render = vi.fn(makeImage);
    const cache = new OpticalCache(undefined, render);
    const first = cache.get(request);
    expect(cache.get({ ...request, id: 2, seed: 7, noise: false, shot: { ...baseShot, iso: 6400, illuminance: 50 } })).toBe(first);
    expect(render).toHaveBeenCalledTimes(1);
  });
  it.each(["aperture", "focus", "motion", "scene", "crop", "resolution"])("invalidates changed %s", (change) => {
    const render = vi.fn(makeImage);
    const cache = new OpticalCache(undefined, render);
    cache.get(request);
    const next = structuredClone(request);
    if (change === "aperture") next.shot.fNumber = 8;
    if (change === "focus") next.shot.focusDistance = 40;
    if (change === "motion") next.shot.shutterTime *= 2;
    if (change === "scene") next.studio.subjectSpeed *= 2;
    if (change === "crop") next.view.centerX += 0.001;
    if (change === "resolution") next.shot.resolution.pixelsX *= 2;
    cache.get(next);
    expect(render).toHaveBeenCalledTimes(2);
  });
  it("evicts least recently used images within its byte budget", () => {
    const render = vi.fn(makeImage);
    const bytes = makeImage().r.byteLength * 3;
    const cache = new OpticalCache(bytes * 2, render);
    const second = { ...request, view: { ...request.view, centerX: 0.001 } };
    const third = { ...request, view: { ...request.view, centerX: 0.002 } };
    const first = cache.get(request);
    cache.get(second);
    expect(cache.get(request)).toBe(first);
    cache.get(third);
    expect(cache.get(request)).toBe(first);
    cache.get(second);
    expect(render).toHaveBeenCalledTimes(4);
  });
  it("does not retain an image larger than the budget", () => {
    const render = vi.fn(makeImage);
    const cache = new OpticalCache(1, render);
    cache.get(request);
    cache.get(request);
    expect(render).toHaveBeenCalledTimes(2);
  });
});
