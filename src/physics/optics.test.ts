import { describe, expect, it } from "vitest";
import {
  aimAngle,
  blurCircleDiameter,
  checkLensEnvelope,
  chiefRayScale,
  MAX_SHIFT_AIM_ANGLE,
  workingFNumber,
  depthOfField,
  fieldOfView,
  frameCoverageAt,
  imageDistance,
  magnification,
} from "./optics";
import { FULL_FRAME } from "./sensor";
import { mm, radToDeg, um } from "./units";

describe("field of view", () => {
  it("matches the rectilinear formula across the proposed focal range", () => {
    expect(radToDeg(fieldOfView(mm(100), FULL_FRAME.width))).toBeCloseTo(20.41, 2);
    expect(radToDeg(fieldOfView(mm(1200), FULL_FRAME.width))).toBeCloseTo(1.719, 3);
  });

  it("narrows slightly when focusing closer (image distance grows)", () => {
    const atInfinity = fieldOfView(mm(400), FULL_FRAME.width);
    const atThreeMeters = fieldOfView(mm(400), FULL_FRAME.width, 3);
    expect(atThreeMeters).toBeLessThan(atInfinity);
  });

  it("covers about 0.9 m of scene width at 30 m with 1200 mm", () => {
    expect(frameCoverageAt(mm(1200), FULL_FRAME.width, 30)).toBeCloseTo(0.864, 3);
  });
});

describe("thin lens", () => {
  it("satisfies 1/f = 1/s + 1/v", () => {
    const f = mm(500);
    const s = 12;
    const v = imageDistance(f, s);
    expect(1 / s + 1 / v).toBeCloseTo(1 / f, 12);
  });

  it("images infinity at the focal length", () => {
    expect(imageDistance(mm(300), Infinity)).toBe(mm(300));
  });

  it("computes magnification f / (s − f)", () => {
    expect(magnification(mm(1200), 30)).toBeCloseTo(1.2 / 28.8, 12);
  });

  it("rejects objects inside the focal length", () => {
    expect(() => imageDistance(mm(100), 0.05)).toThrow(RangeError);
  });
});

describe("defocus", () => {
  const lens = { focalLength: mm(600), fNumber: 4 };

  it("is zero for an object at the focus distance", () => {
    expect(blurCircleDiameter(lens, 20, 20)).toBe(0);
  });

  it("approaches the infinity limit A·m for distant backgrounds", () => {
    const atInfinity = blurCircleDiameter(lens, 20, Infinity);
    expect(blurCircleDiameter(lens, 20, 1e9)).toBeCloseTo(atInfinity, 9);
  });

  it("grows with aperture diameter: one stop wider is √2× more blur", () => {
    const wide = blurCircleDiameter({ ...lens, fNumber: 4 }, 20, 60);
    const narrow = blurCircleDiameter({ ...lens, fNumber: 4 * Math.SQRT2 }, 20, 60);
    expect(wide / narrow).toBeCloseTo(Math.SQRT2, 9);
  });
});

describe("depth of field", () => {
  const coc = um(30);

  it("is about 10 cm for 1200 mm f/2.8 at 30 m", () => {
    const dof = depthOfField({ focalLength: mm(1200), fNumber: 2.8 }, 30, coc);
    expect(dof.total).toBeCloseTo(0.1008, 3);
  });

  it("agrees with the blur-circle formula at its near and far limits", () => {
    const lens = { focalLength: mm(400), fNumber: 5.6 };
    const dof = depthOfField(lens, 15, coc);
    expect(blurCircleDiameter(lens, 15, dof.near)).toBeCloseTo(coc, 9);
    expect(blurCircleDiameter(lens, 15, dof.far)).toBeCloseTo(coc, 9);
  });

  it("extends to infinity beyond the hyperfocal distance", () => {
    const dof = depthOfField({ focalLength: mm(100), fNumber: 16 }, 1000, coc);
    expect(dof.far).toBe(Infinity);
  });
});

describe("working f-number", () => {
  it("grows by (1 + m): 31.6% at 1200 mm focused at 5 m", () => {
    const lens = { focalLength: mm(1200), fNumber: 5.6 };
    expect(workingFNumber(lens, 5) / 5.6).toBeCloseTo(1 + 1.2 / 3.8, 12);
  });

  it("equals the chief-ray scale relation v_f = f (1 + m)", () => {
    const f = mm(400);
    expect(chiefRayScale(f, 10, 10)).toBeCloseTo(magnification(f, 10), 12);
    expect(chiefRayScale(f, 10, 40)).toBeCloseTo(imageDistance(f, 10) / 40, 12);
  });
});

describe("aim angle", () => {
  it("flags steep aims beyond the image-shift approximation", () => {
    expect(aimAngle(-0.88, 30)).toBeLessThan(MAX_SHIFT_AIM_ANGLE);
    expect(aimAngle(-4.88, 5)).toBeGreaterThan(MAX_SHIFT_AIM_ANGLE);
  });
});

describe("lens envelope", () => {
  it("flags 1200 mm f/2.8 (≈429 mm entrance pupil) as unrealistic", () => {
    const check = checkLensEnvelope({ focalLength: mm(1200), fNumber: 2.8 });
    expect(check.realistic).toBe(false);
    expect(check.entrancePupil).toBeCloseTo(0.4286, 4);
  });

  it("accepts a typical 600 mm f/4", () => {
    expect(checkLensEnvelope({ focalLength: mm(600), fNumber: 4 }).realistic).toBe(true);
  });
});
