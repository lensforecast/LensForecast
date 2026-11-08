import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameView } from "../view";
import { RESOLUTION_PRESETS } from "../physics/sensor";
import { Photo, visibleTiles, overview, type PhotoConfig } from "./photo";
import type { RenderWorker } from "./protocol";
import type { RenderReply, RenderRequest } from "./protocol";
import { DEFAULT_STUDIO } from "./studio";
import { baseShot } from "./testScenes";

const config: PhotoConfig = { studio: DEFAULT_STUDIO, shot: { ...baseShot, resolution: RESOLUTION_PRESETS[3]! }, noise: true, seed: 1 };
const frame = (zoom: number | "fit", x = 0, y = 0) => frameView({ zoom, viewportWidth: 600, viewportHeight: 400, centerX: x, centerY: y, pixelsX: 9564, pixelsY: 6376, sensorWidth: 0.036, sensorHeight: 0.024 });
class FakeWorker implements RenderWorker {
  onmessage: RenderWorker["onmessage"] = null;
  onerror: RenderWorker["onerror"] = null;
  onmessageerror: RenderWorker["onmessageerror"] = null;
  postMessage = vi.fn<(request: RenderRequest) => void>();
  terminate = vi.fn();
  finish(): void {
    const request = this.postMessage.mock.calls.at(-1)![0];
    const width = Math.round(request.view.width / request.view.outputPixelSize);
    const height = Math.round(request.view.height / request.view.outputPixelSize);
    this.onmessage?.({ data: { id: request.id, width, height, pixels: new Uint8ClampedArray(width * height * 4), elapsedMs: 1, binning: 1 } } as MessageEvent<RenderReply>);
  }
}

describe("cached photograph", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function setup(budget?: number) {
    const workers: FakeWorker[] = [];
    const changed = vi.fn(); const release = vi.fn(); const error = vi.fn();
    const photo = new Photo(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }, (response) => response.id, release, changed, error, budget);
    function drain() {
      for (let i = 0; i < 100; i++) {
        const worker = workers.at(-1)!;
        const before = worker.postMessage.mock.calls.length;
        worker.finish();
        if (worker.postMessage.mock.calls.length === before) return;
      }
      throw new Error("Queue failed to drain");
    }
    return { photo, workers, changed, release, error, drain };
  }
  it("repaints immediately and reuses the full-frame image across viewport changes", () => {
    const { photo, workers, changed, drain } = setup();
    photo.setView(config, frame("fit"));
    expect(changed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(80); drain();
    expect(photo.progress).toEqual({ ready: 1, total: 1 });
    expect(workers[0]!.postMessage).toHaveBeenCalledTimes(2);
    photo.setView(config, frame("fit", 0.01));
    vi.advanceTimersByTime(80);
    expect(workers[0]!.postMessage).toHaveBeenCalledTimes(2);
    photo.dispose();
  });
  it("reuses native tiles when zooming further or revisiting a previously rendered area", () => {
    const { photo, workers, drain } = setup();
    photo.setView(config, frame(1)); vi.advanceTimersByTime(80); drain();
    const initial = workers[0]!.postMessage.mock.calls.length;
    photo.setView(config, frame(2)); vi.advanceTimersByTime(80);
    expect(workers[0]!.postMessage).toHaveBeenCalledTimes(initial);
    photo.setView(config, frame(1, 0.006)); vi.advanceTimersByTime(80); drain();
    const moved = workers[0]!.postMessage.mock.calls.length;
    expect(moved).toBeGreaterThan(initial);
    photo.setView(config, frame(1)); vi.advanceTimersByTime(80);
    expect(workers[0]!.postMessage).toHaveBeenCalledTimes(moved);
    photo.dispose();
  });
  it("finishes useful in-flight tiles when the view moves, then prioritizes the new view", () => {
    const { photo, workers, drain } = setup();
    photo.setView(config, frame(1)); vi.advanceTimersByTime(80);
    workers[0]!.finish(); // overview done, first native tile starts
    const original = workers[0]!.postMessage.mock.calls.at(-1)![0];
    photo.setView(config, frame(1, 0.01));
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    workers[0]!.finish();
    expect(photo.images.some((tile) => tile.view.centerX === original.view.centerX)).toBe(true);
    const next = workers[0]!.postMessage.mock.calls.at(-1)![0];
    expect(next.view).toEqual(visibleTiles(config, frame(1, 0.01))[0]!.view);
    drain(); photo.dispose();
  });
  it("invalidates pixels and rejects old replies after changing aperture", () => {
    const { photo, workers, release } = setup();
    photo.setView(config, frame(1)); vi.advanceTimersByTime(80);
    workers[0]!.finish();
    photo.setView({ ...config, shot: { ...config.shot, fNumber: 8 } }, frame(1));
    expect(release).toHaveBeenCalled();
    expect(photo.images).toHaveLength(0);
    expect(workers[0]!.terminate).toHaveBeenCalled();
    workers[0]!.finish();
    expect(photo.images).toHaveLength(0);
    vi.advanceTimersByTime(80);
    expect(workers[1]!.postMessage.mock.calls[0]![0].shot.fNumber).toBe(8);
    photo.dispose();
  });
  it("keeps an idle worker for optical-cache reuse after ISO changes", () => {
    const { photo, workers, drain } = setup();
    photo.setView(config, frame("fit")); vi.advanceTimersByTime(80); drain();
    photo.setView({ ...config, shot: { ...config.shot, iso: 1600 } }, frame("fit"));
    vi.advanceTimersByTime(80);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    expect(photo.images).toHaveLength(0);
    photo.dispose();
  });
  it("evicts old offscreen tiles but retains overview fallbacks", () => {
    const { photo, release, drain } = setup(1);
    photo.setView(config, frame(1)); vi.advanceTimersByTime(80); drain();
    photo.setView(config, frame(1, 0.01)); vi.advanceTimersByTime(80); drain();
    expect(release).toHaveBeenCalled();
    expect(photo.images.filter((tile) => tile.key.startsWith("overview:"))).toHaveLength(2);
    photo.dispose();
  });
  it("shows worker failure until retry and preserves cached pixels", () => {
    const { photo, workers, error } = setup();
    photo.setView(config, frame(1)); vi.advanceTimersByTime(80); workers[0]!.finish();
    workers[0]!.onerror?.({ message: "Failed", preventDefault() {} } as ErrorEvent);
    expect(error).toHaveBeenCalledWith("Failed");
    photo.setView(config, frame(2)); vi.advanceTimersByTime(80);
    expect(photo.errorMessage).toBe("Failed");
    expect(photo.images).toHaveLength(1);
    photo.retry();
    expect(photo.errorMessage).toBe("");
    expect(workers).toHaveLength(2);
    photo.dispose();
  });
});

describe("photo pyramid geometry", () => {
  it("uses the same native tile grid at 100%, 200% and 400%", () => {
    const native = new Set(visibleTiles(config, frame(1)).map((tile) => tile.key));
    for (const zoom of [2, 4]) for (const tile of visibleTiles(config, frame(zoom))) expect(native.has(tile.key)).toBe(true);
  });
  it("anchors pixels to the full 9564 × 6376 sensor, including partial edge tiles", () => {
    const pitch = 0.036 / 9564;
    for (const zoom of [0.125, 0.5, 1]) {
      const bin = 2 ** Math.max(0, Math.floor(Math.log2(1 / zoom)));
      const tiles = visibleTiles(config, frame(zoom, 1, -1));
      for (const tile of tiles) {
        const left = (tile.view.centerX - tile.view.width / 2 + 0.018) / pitch;
        const top = (0.012 - tile.view.centerY - tile.view.height / 2) / pitch;
        expect(left / (256 * bin)).toBeCloseTo(Math.round(left / (256 * bin)), 8);
        expect(top / (256 * bin)).toBeCloseTo(Math.round(top / (256 * bin)), 8);
        expect(tile.view.width / (pitch * bin)).toBeLessThanOrEqual(256.000001);
      }
      expect(tiles.length).toBeGreaterThan(0);
    }
  });
  it("covers the full sensor at fixed overview scales", () => {
    expect(visibleTiles(config, frame("fit"))).toHaveLength(0);
    expect(overview(600).view.width / overview(600).view.outputPixelSize).toBeCloseTo(600);
  });
});
