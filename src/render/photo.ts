import type { FramedView } from "../view";
import type { RenderWorker } from "./protocol";
import type { RenderRequest, RenderResponse } from "./protocol";
import type { ViewSpec } from "./types";

export type PhotoConfig = Omit<RenderRequest, "id" | "view">;
export interface PhotoRegion { key: string; view: ViewSpec }
export interface PhotoTile<T> extends PhotoRegion { source: T; bytes: number }
const WIDTH = 0.036;
const HEIGHT = 0.024;
const TILE = 256;

export const overview = (width: number): PhotoRegion => ({
  key: `overview:${width}`,
  view: { centerX: 0, centerY: 0, width: WIDTH, height: HEIGHT, outputPixelSize: WIDTH / width, oversample: 2 },
});

/** Sensor-anchored pyramid tiles, ordered nearest the viewport centre first. */
export function visibleTiles(config: PhotoConfig, frame: FramedView): PhotoRegion[] {
  const { pixelsX, pixelsY } = config.shot.resolution;
  if (frame.zoom <= 600 / pixelsX) return [];
  const pitch = WIDTH / pixelsX;
  const bin = 2 ** Math.max(0, Math.floor(Math.log2(1 / frame.zoom)));
  const step = pitch * bin;
  const left = Math.max(0, (frame.centerX - frame.width / 2 + WIDTH / 2) / step);
  const top = Math.max(0, (HEIGHT / 2 - frame.centerY - frame.height / 2) / step);
  const right = Math.min(pixelsX / bin, left + frame.width / step);
  const bottom = Math.min(pixelsY / bin, top + frame.height / step);
  const tiles: PhotoRegion[] = [];
  for (let y = Math.floor(top / TILE); y < Math.ceil((bottom - 1e-8) / TILE); y++) {
    for (let x = Math.floor(left / TILE); x < Math.ceil((right - 1e-8) / TILE); x++) {
      const cols = Math.min(TILE, Math.ceil(pixelsX / bin) - x * TILE);
      const rows = Math.min(TILE, Math.ceil(pixelsY / bin) - y * TILE);
      const view: ViewSpec = {
        centerX: -WIDTH / 2 + (x * TILE + cols / 2) * step,
        centerY: HEIGHT / 2 - (y * TILE + rows / 2) * step,
        width: cols * step, height: rows * step, outputPixelSize: step,
      };
      if (bin >= 2) view.oversample = 2;
      tiles.push({ key: `${bin}:${x}:${y}`, view });
    }
  }
  return tiles.sort((a, b) => Math.hypot(a.view.centerX - frame.centerX, a.view.centerY - frame.centerY) - Math.hypot(b.view.centerX - frame.centerX, b.view.centerY - frame.centerY));
}

/** A photograph owns its pixels; changing the viewport only changes which tiles we need. */
export class Photo<T> {
  private worker: RenderWorker | null = null;
  private config: PhotoConfig | null = null;
  private configKey = "";
  private serial = 0;
  private flight: (PhotoRegion & { id: number }) | null = null;
  private wanted: PhotoRegion[] = [];
  private readonly tiles = new Map<string, PhotoTile<T>>();
  private bytes = 0;
  private failed = false;
  private failure = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly createWorker: () => RenderWorker,
    private readonly decode: (response: RenderResponse) => T,
    private readonly release: (source: T) => void,
    private readonly changed: () => void,
    private readonly error: (message: string) => void,
    private readonly budget = 64 * 1024 * 1024,
  ) {}

  setView(config: PhotoConfig, frame: FramedView): void {
    if (this.disposed) return;
    const key = JSON.stringify(config);
    if (key !== this.configKey) {
      // Configuration changes cancel work; panning never cancels a useful tile.
      if (this.flight) {
        this.worker?.terminate();
        this.worker = null;
        this.flight = null;
      }
      for (const tile of this.tiles.values()) this.release(tile.source);
      this.tiles.clear();
      this.bytes = 0;
      this.config = config;
      this.configKey = key;
      this.failed = false;
      this.failure = "";
    }
    this.wanted = [overview(240), ...visibleTiles(config, frame), overview(600)];
    // Touch visible entries so eviction favours areas the user has left.
    for (const region of this.wanted) {
      const tile = this.tiles.get(region.key);
      if (tile) { this.tiles.delete(region.key); this.tiles.set(region.key, tile); }
    }
    this.changed();
    clearTimeout(this.timer);
    // Paint cached pixels synchronously; start new work once movement settles.
    this.timer = setTimeout(() => this.pump(), 80);
  }

  get images(): PhotoTile<T>[] {
    const detail = this.wanted.find((r) => !r.key.startsWith("overview:"));
    // Never paste native noisy pixels over a binned overview: their noise and
    // sampling differ. Coarser levels are temporary fallbacks while refining.
    return [...this.tiles.values()].filter((tile) => tile.key.startsWith("overview:") || (detail && tile.view.outputPixelSize >= detail.view.outputPixelSize)).sort((a, b) => b.view.outputPixelSize - a.view.outputPixelSize);
  }
  get progress(): { ready: number; total: number } {
    const detail = this.wanted.filter((r) => r.key !== "overview:240" && r.key !== "overview:600");
    const required = detail.length ? detail : [overview(600)];
    return { ready: required.filter((r) => this.tiles.has(r.key)).length, total: required.length };
  }
  get errorMessage(): string { return this.failure; }
  retry(): void { this.failed = false; this.failure = ""; this.changed(); this.pump(); }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.worker?.terminate();
    for (const tile of this.tiles.values()) this.release(tile.source);
    this.tiles.clear();
  }
  private fail(message: string): void {
    this.worker?.terminate();
    this.worker = null;
    this.flight = null;
    this.failed = true;
    this.failure = message;
    this.error(message);
  }
  private pump(): void {
    if (this.disposed || this.failed || this.flight || !this.config) return;
    const region = this.wanted.find((r) => !this.tiles.has(r.key));
    if (!region) return;
    const job = { ...region, id: ++this.serial };
    this.flight = job;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = (event) => {
          if (worker !== this.worker || event.data.id !== this.flight?.id) return;
          if ("error" in event.data) return this.fail(event.data.error);
          const completed = this.flight;
          this.flight = null;
          try {
            const response = event.data;
            const tile = { ...completed, source: this.decode(response), bytes: response.width * response.height * 4 };
            this.tiles.set(tile.key, tile);
            this.bytes += tile.bytes;
            // Keep both overviews as permanent fallbacks for this configuration.
            for (const [key, old] of this.tiles) {
              if (this.bytes <= this.budget) break;
              if (key.startsWith("overview:") || this.wanted.some((r) => r.key === key)) continue;
              this.tiles.delete(key);
              this.bytes -= old.bytes;
              this.release(old.source);
            }
            this.changed();
            this.pump();
          } catch (error) { this.fail(error instanceof Error ? error.message : "Could not display image."); }
        };
        worker.onerror = (event) => { event.preventDefault(); if (worker === this.worker) this.fail(event.message || "Render worker stopped."); };
        worker.onmessageerror = () => { if (worker === this.worker) this.fail("Could not receive image."); };
      }
      this.worker.postMessage({ ...this.config, view: job.view, id: job.id });
    } catch (error) { this.fail(error instanceof Error ? error.message : "Rendering failed."); }
  }
}
