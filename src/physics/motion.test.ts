import { describe, expect, it } from "vitest";
import { cameraRotationBlur, subjectMotionBlur } from "./motion";
import { FULL_FRAME, pixelPitch, RESOLUTION_PRESETS } from "./sensor";
import { blurBudget } from "./sharpness";
import { mm, nm, toUm } from "./units";

const [res24, , res61] = RESOLUTION_PRESETS as [
  (typeof RESOLUTION_PRESETS)[number],
  (typeof RESOLUTION_PRESETS)[number],
  (typeof RESOLUTION_PRESETS)[number],
];

describe("motion blur", () => {
  it("smears a duck swimming 0.5 m/s at 30 m by ~83 µm at 1200 mm, 1/250 s", () => {
    const blur = subjectMotionBlur(0.5, 30, mm(1200), 1 / 250);
    expect(toUm(blur)).toBeCloseTo(83.33, 2);
    expect(blur / pixelPitch(FULL_FRAME, res24)).toBeCloseTo(13.9, 1);
  });

  it("scales linearly with shutter time", () => {
    const fast = subjectMotionBlur(0.5, 30, mm(600), 1 / 2000);
    const slow = subjectMotionBlur(0.5, 30, mm(600), 1 / 500);
    expect(slow / fast).toBeCloseTo(4, 12);
  });

  it("computes camera rotation blur from angular speed", () => {
    expect(cameraRotationBlur(0.001, mm(1000), 0.01)).toBeCloseTo(1e-5, 12);
  });

  it("uses the image distance for rotation blur at close focus", () => {
    const atInfinity = cameraRotationBlur(0.001, mm(1200), 0.01);
    const atFive = cameraRotationBlur(0.001, mm(1200), 0.01, 5);
    expect(atFive / atInfinity).toBeCloseTo(1 + 1.2 / 3.8, 9);
  });

  it("uses the chief-ray scale v_f / s when the subject is out of focus", () => {
    const blur = subjectMotionBlur(0.5, 30, mm(1200), 1 / 250, 10);
    expect(blur).toBeCloseTo((0.5 / 250) * ((1.2 * 10) / 8.8 / 30), 12);
    expect(blur / subjectMotionBlur(0.5, 30, mm(1200), 1 / 250)).toBeCloseTo((10 / 8.8) * (28.8 / 30), 9);
  });
});

describe("blur budget", () => {
  const green = nm(550);

  it("identifies diffraction as the limit at f/16 on 61 MP", () => {
    const budget = blurBudget({
      wavelength: green,
      workingFNumber: 16,
      defocusDiameter: 0,
      motionLength: 0,
      pixelPitch: pixelPitch(FULL_FRAME, res61),
    });
    expect(budget.limitingFactor).toBe("diffraction");
  });

  it("identifies pixels as the limit at f/4 on 24 MP with a static subject in focus", () => {
    const budget = blurBudget({
      wavelength: green,
      workingFNumber: 4,
      defocusDiameter: 0,
      motionLength: 0,
      pixelPitch: pixelPitch(FULL_FRAME, res24),
    });
    expect(budget.limitingFactor).toBe("pixel");
  });
});
