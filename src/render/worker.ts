/// <reference lib="webworker" />
import { encodeSrgb, readOut } from "./pipeline";
import type { RenderRequest, RenderResponse } from "./protocol";
import { OpticalCache } from "./cache";

const optics = new OpticalCache();

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const { id, shot, noise, seed } = event.data;
  try {
    const start = performance.now();
    const image = optics.get(event.data);
    const levels = readOut(image, shot, { noise, seed });
    const pixels = encodeSrgb(levels, image.width, image.height);
    const response: RenderResponse = {
      id,
      width: image.width,
      height: image.height,
      pixels,
      binning: image.binning,
      elapsedMs: performance.now() - start,
    };
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(response, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Rendering failed." });
  }
};
