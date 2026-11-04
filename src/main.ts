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
import type { RenderRequest, RenderResponse } from "./render/protocol";
import { DEFAULT_STUDIO, DUCK_HEAD_OFFSET, type StudioOptions } from "./render/studio";
import type { ShotSettings, ViewSpec } from "./render/types";

const APERTURES = [2.8, 4, 5.6, 8, 11, 16];
const SHUTTERS = [1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30, 1 / 15];
const ISOS = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];
const FULL_VIEW = { width: 480, height: 320 };
const DETAIL_VIEW = { width: 448, height: 296 };
const PREVIEW_BINNING = 4;
/** Overview renders carry aliasing only up to 1 cycle per output pixel; detail crops use the adaptive default. */
const OVERVIEW_OVERSAMPLE = 2;
const CIRCLE_OF_CONFUSION = um(30);
const NOISE_SEED = 1;

type Side = "A" | "B";
type ViewMode = "full" | "detail";

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
  mode: "full" as ViewMode,
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

/** Full frame: whole sensor at a common output size. Detail: same sensor region, native pixels. */
function viewsFor(camera: CameraConfig): ViewSpec[] {
  const pitch = pixelPitch(FULL_FRAME, resolutionOf(camera));
  let base: ViewSpec;
  if (state.mode === "full") {
    base = {
      centerX: 0,
      centerY: 0,
      width: FULL_FRAME.width,
      height: FULL_FRAME.height,
      outputPixelSize: FULL_FRAME.width / FULL_VIEW.width,
      oversample: OVERVIEW_OVERSAMPLE,
    };
  } else {
    const finest = Math.min(...(["A", "B"] as const).map((s) => pixelPitch(FULL_FRAME, resolutionOf(state.cameras[s]))));
    const shot = shotFor(camera);
    const scale = imageDistance(shot.focalLength, shot.focusDistance) / state.studio.subjectDistance;
    base = {
      centerX: DUCK_HEAD_OFFSET.x * scale,
      centerY: DUCK_HEAD_OFFSET.y * scale,
      width: DETAIL_VIEW.width * finest,
      height: DETAIL_VIEW.height * finest,
      outputPixelSize: pitch,
    };
  }
  const preview = { ...base, outputPixelSize: Math.max(base.outputPixelSize, pitch) * PREVIEW_BINNING, oversample: OVERVIEW_OVERSAMPLE };
  return [preview, base];
}

class RenderChannel {
  private readonly worker = new Worker(new URL("./render/worker.ts", import.meta.url), { type: "module" });
  private queue: { generation: number; final: boolean; request: Omit<RenderRequest, "id"> }[] = [];
  private inFlight: { generation: number; final: boolean } | null = null;
  private generation = 0;
  private shown = -1;

  constructor(private readonly onImage: (response: RenderResponse, final: boolean) => void) {
    this.worker.onmessage = (event: MessageEvent<RenderResponse>) => {
      const job = this.inFlight!;
      this.inFlight = null;
      if (job.generation >= this.shown) {
        this.shown = job.generation;
        this.onImage(event.data, job.final && job.generation === this.generation);
      }
      this.pump();
    };
  }

  schedule(requests: Omit<RenderRequest, "id">[]): void {
    this.generation++;
    this.queue = requests.map((request, i) => ({ generation: this.generation, final: i === requests.length - 1, request }));
    this.pump();
  }

  private pump(): void {
    if (this.inFlight) return;
    const job = this.queue.shift();
    if (!job) return;
    this.inFlight = job;
    this.worker.postMessage({ ...job.request, id: job.generation });
  }
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
      <div class="frame"><canvas></canvas><span class="status"></span></div>
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
      <div class="warning-slot"></div>
      <table class="readout"></table>
    </section>`;
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <section class="scene-controls">
    <label>View
      <select data-scene="mode">
        <option value="full">Full frame</option>
        <option value="detail">Detail crop (native pixels)</option>
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
  <div class="cameras">${cameraPanel("A")}${cameraPanel("B")}</div>
`;

const panels = Object.fromEntries(
  (["A", "B"] as const).map((side) => [side, app.querySelector<HTMLElement>(`.camera[data-side="${side}"]`)!]),
) as Record<Side, HTMLElement>;

function drawImage(side: Side, response: RenderResponse, final: boolean): void {
  const panel = panels[side];
  const canvas = panel.querySelector("canvas")!;
  canvas.width = response.width;
  canvas.height = response.height;
  canvas.classList.toggle("pixelated", state.mode === "detail" && final);
  canvas.getContext("2d")!.putImageData(new ImageData(response.pixels, response.width, response.height), 0, 0);
  const status = panel.querySelector(".status")!;
  status.textContent = final
    ? `${response.width} × ${response.height} px · ${response.binning > 1.01 ? `${response.binning.toFixed(1)} sensor px per output px · ` : ""}${response.elapsedMs.toFixed(0)} ms`
    : "Refining…";
}

const channels = Object.fromEntries(
  (["A", "B"] as const).map((side) => [side, new RenderChannel((res, final) => drawImage(side, res, final))]),
) as Record<Side, RenderChannel>;

function updateReadout(side: Side): void {
  const camera = state.cameras[side];
  const panel = panels[side];
  const shot = shotFor(camera);
  const displayPixel = state.mode === "full" ? FULL_FRAME.width / FULL_VIEW.width : 0;
  const r = computeReadouts(shot, state.studio, { displayPixel, circleOfConfusion: CIRCLE_OF_CONFUSION });
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

  const sharpnessScale = state.mode === "full" ? "full-frame view" : "native pixels";
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

let renderTimer = 0;
function refresh(): void {
  state.studio.backgroundDistance = state.studio.subjectDistance + state.backgroundOffset;
  app.querySelector('[data-out="subjectDistance"]')!.textContent = `${state.studio.subjectDistance} m`;
  app.querySelector('[data-out="backgroundOffset"]')!.textContent = `+${state.backgroundOffset} m (${state.studio.backgroundDistance} m)`;
  app.querySelector('[data-out="cameraHeight"]')!.textContent = `${state.studio.cameraHeight.toFixed(1)} m`;
  app.querySelector('[data-out="subjectSpeed"]')!.textContent = `${state.studio.subjectSpeed.toFixed(2)} m/s`;
  for (const side of ["A", "B"] as const) updateReadout(side);

  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    for (const side of ["A", "B"] as const) {
      const camera = state.cameras[side];
      const shot = shotFor(camera);
      channels[side].schedule(
        viewsFor(camera).map((view) => ({ studio: { ...state.studio }, shot, view, noise: state.noise, seed: NOISE_SEED })),
      );
    }
  }, 120);
}

app.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const sceneKey = target.dataset.scene;
  if (sceneKey) {
    if (sceneKey === "mode") state.mode = target.value as ViewMode;
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

refresh();
