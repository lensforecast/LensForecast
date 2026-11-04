/// <reference lib="webworker" />
import { encodeSrgb, readOut, renderOpticalImage } from "./pipeline";
import type { RenderRequest, RenderResponse } from "./protocol";
import { createWildlifeStudio } from "./studio";

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const { id, studio, shot, view, noise, seed } = event.data;
  const start = performance.now();
  const image = renderOpticalImage(createWildlifeStudio(studio), shot, view);
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
};
