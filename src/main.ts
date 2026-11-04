import {
  EFFECT_MODELS,
  type EffectId,
  FULL_FRAME,
  imageDistance,
  LIGHTING_PRESETS,
  mm,
  pixelPitch,
  radToDeg,
  RESOLUTION_PRESETS,
  toUm,
  um,
} from "./physics";
import { computeReadouts } from "./readouts";
import { Photo } from "./render/photo";
import { DEFAULT_STUDIO, DUCK_HEAD_OFFSET, type StudioOptions } from "./render/studio";
import type { ShotSettings } from "./render/types";
import { frameView, type FramedView, type ZoomSetting } from "./view";

const APERTURES = [2.8, 4, 5.6, 8, 11, 16];
const SHUTTERS = [1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30, 1 / 15];
const ISOS = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];
/** Lightroom stops. 100% is one sensor pixel per screen pixel. */
const ZOOM_LEVELS: readonly ZoomSetting[] = ["fit", 0.125, 0.25, 0.5, 1, 2, 4];
const CIRCLE_OF_CONFUSION = um(30);
const NOISE_SEED = 1;

type Side = "A" | "B";

interface CameraConfig {
  focalMm: number;
  fNumber: number;
  focusOnSubject: boolean;
  focusDistance: number;
  shutterTime: number;
  iso: number;
  resolutionId: string;
}

const lightingOf = (id: string) => LIGHTING_PRESETS.find((p) => p.id === id)!;

const state = {
  studio: { ...DEFAULT_STUDIO, sky: lightingOf("overcast").sky } as StudioOptions,
  backgroundOffset: DEFAULT_STUDIO.backgroundDistance - DEFAULT_STUDIO.subjectDistance,
  lightingId: "overcast",
  zoom: "fit" as ZoomSetting,
  /** Object point kept under the zoom, meters from the aim point. */
  lookAt: { x: DUCK_HEAD_OFFSET.x, y: DUCK_HEAD_OFFSET.y },
  noise: true,
  cameras: {
    A: { focalMm: 600, fNumber: 5.6, focusOnSubject: true, focusDistance: 30, shutterTime: 1 / 500, iso: 800, resolutionId: "24mp" },
    B: { focalMm: 600, fNumber: 5.6, focusOnSubject: true, focusDistance: 30, shutterTime: 1 / 500, iso: 800, resolutionId: "61mp" },
  } as Record<Side, CameraConfig>,
};

const resolutionOf = (camera: CameraConfig) => RESOLUTION_PRESETS.find((r) => r.id === camera.resolutionId)!;
const illuminance = () => lightingOf(state.lightingId).illuminance;
const formatShutter = (t: number) => (t >= 1 ? `${t} s` : `1/${Math.round(1 / t)} s`);

function shotFor(camera: CameraConfig): ShotSettings {
  return {
    focalLength: mm(camera.focalMm),
    fNumber: camera.fNumber,
    focusDistance: camera.focusOnSubject ? state.studio.subjectDistance : camera.focusDistance,
    shutterTime: camera.shutterTime,
    iso: camera.iso,
    illuminance: illuminance(),
    resolution: resolutionOf(camera),
  };
}

function subjectScale(camera: CameraConfig): number {
  const shot = shotFor(camera);
  return imageDistance(shot.focalLength, shot.focusDistance) / state.studio.subjectDistance;
}

/** Both cameras share camera A's viewport so a zoom percentage is the same size on screen. */
function viewportDevicePixels(): { width: number; height: number } {
  const frame = panels.A.querySelector(".frame")!;
  const dpr = window.devicePixelRatio || 1;
  return {
    width: Math.max(1, Math.round(frame.clientWidth * dpr)),
    height: Math.max(1, Math.round(frame.clientHeight * dpr)),
  };
}

function framedFor(camera: CameraConfig): FramedView {
  const resolution = resolutionOf(camera);
  const viewport = viewportDevicePixels();
  const scale = subjectScale(camera);
  return frameView({
    zoom: state.zoom,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    pixelsX: resolution.pixelsX,
    pixelsY: resolution.pixelsY,
    sensorWidth: FULL_FRAME.width,
    sensorHeight: FULL_FRAME.height,
    centerX: state.lookAt.x * scale,
    centerY: state.lookAt.y * scale,
  });
}

function formatPercent(zoom: number): string {
  const rounded = Math.round(zoom * 1000) / 10;
  return `${Number(rounded.toFixed(1))}%`;
}

function zoomLabel(framed: FramedView): string {
  return state.zoom === "fit" ? `Fit ${formatPercent(framed.zoom)}` : formatPercent(framed.zoom);
}

const tier = (id: EffectId): string => {
  const model = EFFECT_MODELS[id];
  return `<span class="tier tier-${model.tier}" title="${model.model}">${model.tier}</span>`;
};

const row = (label: string, value: string, effect: EffectId): string =>
  `<tr><td>${label}</td><td class="value">${value}</td><td>${tier(effect)}</td></tr>`;

function options<T>(values: readonly T[], label: (v: T) => string, selected: T): string {
  return values.map((v) => `<option value="${v}" ${v === selected ? "selected" : ""}>${label(v)}</option>`).join("");
}

function cameraPanel(side: Side): string {
  const c = state.cameras[side];
  return `
    <section class="camera" data-side="${side}">
      <h2>Camera ${side}</h2>
      <div class="frame" title="Drag to pan. Scroll to zoom. Double-click toggles 100%."><canvas></canvas><span class="status"></span></div>
      <div class="controls">
        <label>Focal length <output data-out="focalMm"></output>
          <input data-key="focalMm" type="range" min="100" max="1200" step="10" value="${c.focalMm}" /></label>
        <label>Aperture <select data-key="fNumber">${options(APERTURES, (n) => `f/${n}`, c.fNumber)}</select></label>
        <label>Shutter <select data-key="shutterTime">${options(SHUTTERS, formatShutter, c.shutterTime)}</select></label>
        <label>ISO <select data-key="iso">${options(ISOS, (s) => `ISO ${s}`, c.iso)}</select></label>
        <label>Sensor <select data-key="resolutionId">${RESOLUTION_PRESETS.map((r) => `<option value="${r.id}" ${r.id === c.resolutionId ? "selected" : ""}>${r.label} (${r.pixelsX} × ${r.pixelsY})</option>`).join("")}</select></label>
        <label class="inline"><input data-key="focusOnSubject" type="checkbox" ${c.focusOnSubject ? "checked" : ""} /> Focus on duck</label>
        <label>Focus distance <output data-out="focusDistance"></output>
          <input data-key="focusDistance" type="range" min="3" max="200" step="0.5" value="${c.focusDistance}" /></label>
      </div>
      <button type="button" data-action="retry" hidden>Retry render</button>
      <div class="warning-slot"></div>
      <table class="readout"></table>
    </section>`;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <section class="scene-controls">
    <label>Zoom
      <select data-scene="zoom" title="100% is one sensor pixel per screen pixel. A 24 MP frame is 6000 × 4000 pixels. Drag a zoomed view to pan; scroll or double-click to change zoom.">
        ${ZOOM_LEVELS.map((z) => `<option value="${z}" ${z === state.zoom ? "selected" : ""}>${z === "fit" ? "Fit" : formatPercent(z)}</option>`).join("")}
      </select></label>
    <label class="inline"><input data-scene="noise" type="checkbox" checked /> Sensor noise</label>
    <label>Lighting <select data-scene="lighting">${LIGHTING_PRESETS.map((p) => `<option value="${p.id}" ${p.id === state.lightingId ? "selected" : ""}>${p.name} (${p.illuminance.toLocaleString()} lx)</option>`).join("")}</select></label>
    <label>Duck distance <output data-out="subjectDistance"></output>
      <input data-scene="subjectDistance" type="range" min="5" max="100" step="1" value="${state.studio.subjectDistance}" /></label>
    <label>Background behind duck <output data-out="backgroundOffset"></output>
      <input data-scene="backgroundOffset" type="range" min="2" max="300" step="1" value="${state.backgroundOffset}" /></label>
    <label>Camera height <output data-out="cameraHeight"></output>
      <input data-scene="cameraHeight" type="range" min="0.2" max="5" step="0.1" value="${state.studio.cameraHeight}" /></label>
    <label>Duck speed <output data-out="subjectSpeed"></output>
      <input data-scene="subjectSpeed" type="range" min="0" max="2" step="0.05" value="${state.studio.subjectSpeed}" /></label>
    <label class="inline"><input data-scene="showTarget" type="checkbox" ${state.studio.showTarget ? "checked" : ""} /> Test chart (slanted edge) beside the duck</label>
    <button type="button" data-action="copy">Copy A → B</button>
  </section>
  <details class="model-notes"><summary>Model accuracy and assumptions</summary>
    <p>These cameras use ideal lenses and a generic sensor. Color sampling omits Bayer filters and demosaicing. Highlight clipping is applied after binning, so near-clipped detail can differ from a real sensor.</p>
    ${Object.values(EFFECT_MODELS).map((model) => `<details><summary>${model.name} · ${model.tier}</summary><p>${model.model}</p><ul>${model.assumptions.map((assumption) => `<li>${assumption}</li>`).join("")}</ul></details>`).join("")}
  </details>
  <div class="cameras">${cameraPanel("A")}${cameraPanel("B")}</div>
`;

const panels = Object.fromEntries(
  (["A", "B"] as const).map((side) => [side, app.querySelector<HTMLElement>(`.camera[data-side="${side}"]`)!]),
) as Record<Side, HTMLElement>;

/** Cached photograph pixels are transformed on the UI thread, without optics work. */
function paintPhoto(side: Side): void {
  const photo = photos[side];
  const frame = framedFor(state.cameras[side]);
  const canvas = panels[side].querySelector("canvas")!;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(frame.displayWidth));
  const height = Math.max(1, Math.round(frame.displayHeight));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${frame.displayWidth / dpr}px`;
  canvas.style.height = `${frame.displayHeight / dpr}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = frame.zoom < 1;
  const left = frame.centerX - frame.width / 2;
  const top = frame.centerY + frame.height / 2;
  for (const tile of photo.images) {
    const view = tile.view;
    const x = (view.centerX - view.width / 2 - left) / frame.width * width;
    const y = (top - view.centerY - view.height / 2) / frame.height * height;
    const w = view.width / frame.width * width;
    const h = view.height / frame.height * height;
    if (x + w <= 0 || y + h <= 0 || x >= width || y >= height) continue;
    ctx.drawImage(tile.source, x, y, w, h);
  }
  const { ready, total } = photo.progress;
  panels[side].querySelector<HTMLButtonElement>('[data-action="retry"]')!.hidden = !photo.errorMessage;
  if (photo.errorMessage) {
    panels[side].querySelector(".status")!.textContent = `Render failed: ${photo.errorMessage}`;
    return;
  }
  const status = ready === total ? "Cached photo" : `Refining ${ready}/${total}`;
  panels[side].querySelector(".status")!.textContent = `${zoomLabel(frame)} · ${status}`;
}

const photos = Object.fromEntries(
  (["A", "B"] as const).map((side) => [side, new Photo<HTMLCanvasElement>(
    () => new Worker(new URL("./render/worker.ts", import.meta.url), { type: "module" }),
    (response) => {
      const canvas = document.createElement("canvas");
      canvas.width = response.width;
      canvas.height = response.height;
      canvas.getContext("2d")!.putImageData(new ImageData(response.pixels, response.width, response.height), 0, 0);
      return canvas;
    },
    (canvas) => { canvas.width = canvas.height = 0; },
    () => paintPhoto(side),
    (message) => {
      panels[side].querySelector(".status")!.textContent = `Render failed: ${message}`;
      panels[side].querySelector<HTMLButtonElement>('[data-action="retry"]')!.hidden = false;
    },
  )]),
) as Record<Side, Photo<HTMLCanvasElement>>;

app.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-action="retry"]') : null;
  const side = sideOf(button);
  if (side) {
    panels[side].querySelector<HTMLButtonElement>('[data-action="retry"]')!.hidden = true;
    photos[side].retry();
  }
});

function updateReadout(side: Side): void {
  const camera = state.cameras[side];
  const panel = panels[side];
  const shot = shotFor(camera);
  const framed = framedFor(camera);
  const r = computeReadouts(shot, state.studio, { displayPixel: framed.displayPixel, circleOfConfusion: CIRCLE_OF_CONFUSION });
  const pitch = r.pixelPitch;

  panel.querySelector('[data-out="focalMm"]')!.textContent = `${camera.focalMm} mm`;
  panel.querySelector('[data-out="focusDistance"]')!.textContent = `${shot.focusDistance} m`;
  panel.querySelector<HTMLInputElement>('[data-key="focusDistance"]')!.disabled = camera.focusOnSubject;

  const warnings: string[] = [];
  if (!r.lensEnvelope.realistic) {
    warnings.push(
      `<p class="warning">No common real lens has a ${Math.round(r.lensEnvelope.entrancePupil * 1000)} mm entrance pupil; simulating an idealized lens. ${tier("lensEnvelope")}</p>`,
    );
  }
  if (r.aimWarning) {
    warnings.push(
      `<p class="warning">The camera looks ${radToDeg(r.aimAngle).toFixed(1)}° down at the duck; aim is modeled as an image shift, which is only accurate below 5°. ${tier("cameraAim")}</p>`,
    );
  }
  panel.querySelector(".warning-slot")!.innerHTML = warnings.join("");

  const sharpnessScale = state.zoom === "fit" ? "fit" : formatPercent(state.zoom);
  panel.querySelector(".readout")!.innerHTML = [
    row("Horizontal field of view", `${radToDeg(r.fieldOfView).toFixed(2)}°`, "fieldOfView"),
    row("Depth of field", Number.isFinite(r.depthOfField) ? `${(r.depthOfField * 100).toFixed(1)} cm` : "to infinity", "defocus"),
    row("Duck blur circle", `${(r.subjectBlur / pitch).toFixed(1)} px`, "defocus"),
    row("Background blur circle", `${(r.backgroundBlur / pitch).toFixed(0)} px`, "defocus"),
    row("Working f-number", `f/${r.workingFNumber.toFixed(1)}`, "exposure"),
    row("Airy FWHM vs pixel pitch", `${toUm(r.airyFwhm).toFixed(1)} vs ${toUm(pitch).toFixed(2)} µm`, "diffraction"),
    row("Exposure vs middle grey", `${r.exposureOffsetEv >= 0 ? "+" : ""}${r.exposureOffsetEv.toFixed(1)} EV`, "exposure"),
    row(`SNR of 18% grey at ${sharpnessScale}`, r.snr.toFixed(0), "sensorModel"),
    row("Duck motion blur", `${r.motionBlurPixels.toFixed(1)} px`, "subjectMotion"),
    row(`Sharpness limited by (${sharpnessScale})`, r.limitingFactor, "blurBudget"),
  ].join("");
}

function updateFrameChrome(): void {
  for (const side of ["A", "B"] as const) {
    const frame = panels[side].querySelector(".frame")!;
    const cropped = framedFor(state.cameras[side]).cropped;
    frame.classList.toggle("can-pan", cropped);
    frame.classList.toggle("can-zoom", !cropped);
  }
}

function refresh(): void {
  state.studio.backgroundDistance = state.studio.subjectDistance + state.backgroundOffset;
  updateFrameChrome();
  app.querySelector('[data-out="subjectDistance"]')!.textContent = `${state.studio.subjectDistance} m`;
  app.querySelector('[data-out="backgroundOffset"]')!.textContent = `+${state.backgroundOffset} m (${state.studio.backgroundDistance} m)`;
  app.querySelector('[data-out="cameraHeight"]')!.textContent = `${state.studio.cameraHeight.toFixed(1)} m`;
  app.querySelector('[data-out="subjectSpeed"]')!.textContent = `${state.studio.subjectSpeed.toFixed(2)} m/s`;
  for (const side of ["A", "B"] as const) updateReadout(side);

  for (const side of ["A", "B"] as const) {
    const camera = state.cameras[side];
    const shot = shotFor(camera);
    const framed = framedFor(camera);
    photos[side].setView({ studio: { ...state.studio }, shot, noise: state.noise, seed: NOISE_SEED }, framed);
  }
}

app.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const sceneKey = target.dataset.scene;
  if (sceneKey) {
    if (sceneKey === "zoom") state.zoom = target.value === "fit" ? "fit" : Number(target.value);
    else if (sceneKey === "noise") state.noise = (target as HTMLInputElement).checked;
    else if (sceneKey === "lighting") {
      state.lightingId = target.value;
      state.studio.sky = lightingOf(target.value).sky;
    }
    else if (sceneKey === "showTarget") state.studio.showTarget = (target as HTMLInputElement).checked;
    else if (sceneKey === "backgroundOffset") state.backgroundOffset = Number(target.value);
    else (state.studio as unknown as Record<string, number>)[sceneKey] = Number(target.value);
    return refresh();
  }
  const key = target.dataset.key as keyof CameraConfig | undefined;
  const side = target.closest<HTMLElement>(".camera")?.dataset.side as Side | undefined;
  if (!key || !side) return;
  const camera = state.cameras[side] as unknown as Record<string, unknown>;
  if (key === "focusOnSubject") camera[key] = (target as HTMLInputElement).checked;
  else if (key === "resolutionId") camera[key] = target.value;
  else camera[key] = Number(target.value);
  refresh();
});

app.querySelector('[data-action="copy"]')!.addEventListener("click", () => {
  state.cameras.B = { ...state.cameras.A };
  panels.B.outerHTML = cameraPanel("B");
  panels.B = app.querySelector<HTMLElement>('.camera[data-side="B"]')!;
  refresh();
});

function sideOf(target: EventTarget | null): Side | null {
  const side = target instanceof Element ? target.closest<HTMLElement>(".camera")?.dataset.side : undefined;
  return side === "A" || side === "B" ? side : null;
}

function pointerOnSensor(side: Side, clientX: number, clientY: number): { x: number; y: number; u: number; v: number } | null {
  const canvas = panels[side].querySelector("canvas");
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  const u = (clientX - rect.left) / rect.width - 0.5;
  const v = 0.5 - (clientY - rect.top) / rect.height;
  const framed = framedFor(state.cameras[side]);
  return { x: framed.centerX + u * framed.width, y: framed.centerY + v * framed.height, u, v };
}

/** Keep the sensor point under the cursor when the magnification changes. */
function placeZoom(side: Side, zoom: number, pointer: { x: number; y: number; u: number; v: number }): void {
  const camera = state.cameras[side];
  const resolution = resolutionOf(camera);
  const viewport = viewportDevicePixels();
  const predicted = frameView({
    zoom,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    pixelsX: resolution.pixelsX,
    pixelsY: resolution.pixelsY,
    sensorWidth: FULL_FRAME.width,
    sensorHeight: FULL_FRAME.height,
    centerX: pointer.x,
    centerY: pointer.y,
  });
  const scale = subjectScale(camera);
  state.lookAt.x = (pointer.x - pointer.u * predicted.width) / scale;
  state.lookAt.y = (pointer.y - pointer.v * predicted.height) / scale;
}

function stepZoom(direction: 1 | -1, effective: number, fitZoom: number): ZoomSetting {
  const stops = ZOOM_LEVELS.filter((zoom): zoom is number => typeof zoom === "number");
  if (direction > 0) return stops.find((zoom) => zoom > effective * 1.01) ?? stops[stops.length - 1]!;
  const current = state.zoom;
  if (current === "fit") return "fit";
  return [...stops].reverse().find((zoom) => zoom < current * 0.99 && zoom > fitZoom * 1.01) ?? "fit";
}

function syncZoomSelect(): void {
  const select = app.querySelector<HTMLSelectElement>('[data-scene="zoom"]');
  if (select) select.value = String(state.zoom);
}

let pan: { id: number; x: number; y: number; side: Side } | null = null;

app.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const frame = event.target instanceof Element ? event.target.closest<HTMLElement>(".frame") : null;
  const side = sideOf(frame);
  if (!frame || !side || !framedFor(state.cameras[side]).cropped) return;
  pan = { id: event.pointerId, x: event.clientX, y: event.clientY, side };
  frame.classList.add("is-panning");
  frame.setPointerCapture(event.pointerId);
  event.preventDefault();
});

function endPan(event: PointerEvent): void {
  if (!pan || event.pointerId !== pan.id) return;
  for (const frame of app.querySelectorAll(".frame.is-panning")) frame.classList.remove("is-panning");
  pan = null;
}

app.addEventListener("pointerup", endPan);
app.addEventListener("pointercancel", endPan);

app.addEventListener("pointermove", (event) => {
  if (!pan || event.pointerId !== pan.id) return;
  const dx = event.clientX - pan.x;
  const dy = event.clientY - pan.y;
  if (dx === 0 && dy === 0) return;
  pan.x = event.clientX;
  pan.y = event.clientY;
  const camera = state.cameras[pan.side];
  const framed = framedFor(camera);
  const metersPerCss = (pixelPitch(FULL_FRAME, resolutionOf(camera)) * (window.devicePixelRatio || 1)) / framed.zoom;
  const scale = subjectScale(camera);
  state.lookAt.x -= (dx * metersPerCss) / scale;
  state.lookAt.y += (dy * metersPerCss) / scale;
  const clamped = framedFor(camera);
  const maxX = Math.max(0, (FULL_FRAME.width - clamped.width) / 2) / scale;
  const maxY = Math.max(0, (FULL_FRAME.height - clamped.height) / 2) / scale;
  state.lookAt.x = Math.min(Math.max(state.lookAt.x, -maxX), maxX);
  state.lookAt.y = Math.min(Math.max(state.lookAt.y, -maxY), maxY);
  refresh();
});

app.addEventListener("dblclick", (event) => {
  const frame = event.target instanceof Element ? event.target.closest(".frame") : null;
  const side = sideOf(frame);
  if (!side) return;
  event.preventDefault();
  const atNative = typeof state.zoom === "number" && Math.abs(state.zoom - 1) < 1e-6;
  if (atNative) state.zoom = "fit";
  else {
    const pointer = pointerOnSensor(side, event.clientX, event.clientY);
    if (pointer) placeZoom(side, 1, pointer);
    state.zoom = 1;
  }
  syncZoomSelect();
  refresh();
});

let lastWheel = 0;
app.addEventListener(
  "wheel",
  (event) => {
    const frame = event.target instanceof Element ? event.target.closest(".frame") : null;
    const side = sideOf(frame);
    if (!side) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheel < 160) return;
    lastWheel = now;
    const camera = state.cameras[side];
    const viewport = viewportDevicePixels();
    const fitZoom = frameView({
      zoom: "fit",
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      pixelsX: resolutionOf(camera).pixelsX,
      pixelsY: resolutionOf(camera).pixelsY,
      sensorWidth: FULL_FRAME.width,
      sensorHeight: FULL_FRAME.height,
      centerX: 0,
      centerY: 0,
    }).zoom;
    const next = stepZoom(event.deltaY < 0 ? 1 : -1, framedFor(camera).zoom, fitZoom);
    if (next === state.zoom) return;
    if (typeof next === "number") {
      const pointer = pointerOnSensor(side, event.clientX, event.clientY);
      if (pointer) placeZoom(side, next, pointer);
    }
    state.zoom = next;
    syncZoomSelect();
    refresh();
  },
  { passive: false },
);

new ResizeObserver(() => refresh()).observe(panels.A.querySelector(".frame")!);

refresh();
