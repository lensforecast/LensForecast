import type { StudioOptions } from "./studio";
import type { ShotSettings, ViewSpec } from "./types";

export interface RenderRequest {
  id: number;
  studio: StudioOptions;
  shot: ShotSettings;
  view: ViewSpec;
  noise: boolean;
  seed: number;
}

export interface RenderResponse {
  id: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray<ArrayBuffer>;
  binning: number;
  elapsedMs: number;
}

export type RenderReply = RenderResponse | { id: number; error: string };

export interface RenderWorker {
  onmessage: ((event: MessageEvent<RenderReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: RenderRequest): void;
  terminate(): void;
}
