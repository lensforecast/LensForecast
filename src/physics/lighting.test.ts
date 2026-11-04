import { describe, expect, it } from "vitest";
import {
  CIE_OVERCAST_VERTICAL_ILLUMINANCE_PER_ZENITH_LUMINANCE,
  focalPlaneExposure,
  LIGHTING_PRESETS,
  sensorExposure,
  skyRadianceFactor,
} from "./exposure";
import { fresnelReflectance } from "./reflection";
import { mm } from "./units";

/** CIE overcast luminance relative to the zenith. */
const cie = (gamma: number): number => (1 + 2 * Math.sin(gamma)) / 3;

function integrate(fn: (x: number) => number, a: number, b: number, n = 20000): number {
  const h = (b - a) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += fn(a + (i + 0.5) * h);
  return sum * h;
}

describe("CIE overcast sky", () => {
  it("gives E_h = 7πL_z/9 on a horizontal surface (numeric check of the model)", () => {
    const eh = 2 * Math.PI * integrate((g) => cie(g) * Math.sin(g) * Math.cos(g), 0, Math.PI / 2);
    expect(eh).toBeCloseTo((7 * Math.PI) / 9, 6);
  });

  it("gives E_v = (2/3)(π/4 + 2/3) L_z on a vertical surface", () => {
    const ev = 2 * integrate((g) => cie(g) * Math.cos(g) ** 2, 0, Math.PI / 2);
    expect(ev).toBeCloseTo(CIE_OVERCAST_VERTICAL_ILLUMINANCE_PER_ZENITH_LUMINANCE, 6);
  });

  it("counts the sky reflected by calm water in the subject's vertical illuminance", () => {
    const sky = 2 * integrate((g) => cie(g) * Math.cos(g) ** 2, 0, Math.PI / 2);
    const water = 2 * integrate((d) => fresnelReflectance(Math.sin(d)) * cie(d) * Math.cos(d) ** 2, 0, Math.PI / 2);
    expect(water / sky).toBeGreaterThan(0.14);
    expect(water / sky).toBeLessThan(0.17);
    const horizon = Math.PI / 3 / (sky + water);
    expect(skyRadianceFactor({ kind: "cieOvercast" }, 0)).toBeCloseTo(horizon, 6);
    expect(skyRadianceFactor({ kind: "cieOvercast" }, Math.PI / 2)).toBeCloseTo(3 * horizon, 6);
  });

  it("keeps clear-sky horizon luminance at 6–8 kcd/m² in the sunny presets", () => {
    for (const id of ["sun", "hazy"]) {
      const preset = LIGHTING_PRESETS.find((p) => p.id === id)!;
      const luminance = (skyRadianceFactor(preset.sky, 0) * preset.illuminance) / Math.PI;
      expect(luminance).toBeGreaterThanOrEqual(5000);
      expect(luminance).toBeLessThanOrEqual(10000);
    }
  });
});

describe("Fresnel reflectance of water", () => {
  it("is ≈ 2% at normal incidence", () => {
    expect(fresnelReflectance(1)).toBeCloseTo(((1.333 - 1) / (1.333 + 1)) ** 2, 10);
  });

  it("matches the textbook angle form at 2°, 5° and 10° grazing", () => {
    for (const [grazingDeg, expected] of [
      [2, 0.804],
      [5, 0.584],
      [10, 0.348],
    ] as const) {
      const i = ((90 - grazingDeg) * Math.PI) / 180;
      const t = Math.asin(Math.sin(i) / 1.333);
      const rs = (Math.sin(i - t) / Math.sin(i + t)) ** 2;
      const rp = (Math.tan(i - t) / Math.tan(i + t)) ** 2;
      expect(fresnelReflectance(Math.cos(i))).toBeCloseTo((rs + rp) / 2, 10);
      expect(fresnelReflectance(Math.cos(i))).toBeCloseTo(expected, 3);
    }
  });

  it("tends to total reflection at grazing incidence", () => {
    expect(fresnelReflectance(0)).toBeCloseTo(1, 10);
  });
});

describe("shared sensor exposure", () => {
  it("includes the bellows factor at the focus distance", () => {
    const f = mm(1200);
    const m = f / (5 - f);
    expect(sensorExposure(1000, f, 5.6, 5, 1 / 500)).toBeCloseTo(
      focalPlaneExposure(1000, 5.6, 1 / 500, { magnification: m }),
      15,
    );
    expect(Math.log2(focalPlaneExposure(1000, 5.6, 1 / 500) / sensorExposure(1000, f, 5.6, 5, 1 / 500))).toBeCloseTo(
      0.79,
      2,
    );
  });
});
