import { renderOpticalImage, type OpticalImage } from "./pipeline";
import type { RenderRequest } from "./protocol";
import { createWildlifeStudio } from "./studio";

/** Bounded worker-local LRU of optical images; ISO and noise only affect readout. */
export class OpticalCache {
  private readonly entries = new Map<string, OpticalImage>();
  private bytes = 0;
  constructor(
    private readonly budget = 32 * 1024 * 1024,
    private readonly render = renderOpticalImage,
  ) {}

  get(request: RenderRequest): OpticalImage {
    const { iso: _iso, illuminance: _illuminance, ...optics } = request.shot;
    const key = JSON.stringify({ studio: request.studio, optics, view: request.view });
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const image = this.render(createWildlifeStudio(request.studio), request.shot, request.view);
    const size = image.r.byteLength + image.g.byteLength + image.b.byteLength;
    if (size <= this.budget) {
      while (this.bytes + size > this.budget) {
        const oldest = this.entries.entries().next().value!;
        this.entries.delete(oldest[0]);
        this.bytes -= oldest[1].r.byteLength + oldest[1].g.byteLength + oldest[1].b.byteLength;
      }
      this.entries.set(key, image);
      this.bytes += size;
    }
    return image;
  }
}
