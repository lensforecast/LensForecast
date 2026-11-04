import { describe, expect, it } from "vitest";
import { samplePixelElectrons } from "./noise";
import { logGamma, mulberry32, poisson, standardNormal } from "./random";
import { GENERIC_SENSOR } from "./sensor";

function stats(samples: number[]): { mean: number; variance: number } {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples.length - 1);
  return { mean, variance };
}

describe("seeded RNG", () => {
  it("is reproducible for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("produces a standard normal distribution", () => {
    const rng = mulberry32(7);
    const { mean, variance } = stats(Array.from({ length: 100_000 }, () => standardNormal(rng)));
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(variance).toBeCloseTo(1, 1);
  });
});

describe("Poisson sampling", () => {
  it("matches ln Γ at integers", () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(logGamma(11)).toBeCloseTo(Math.log(3628800), 9);
  });

  it.each([2.5, 30, 5000])("has mean ≈ variance ≈ λ for λ = %f", (lambda) => {
    const rng = mulberry32(1234);
    const n = 100_000;
    const { mean, variance } = stats(Array.from({ length: n }, () => poisson(lambda, rng)));
    const standardError = Math.sqrt(lambda / n);
    expect(Math.abs(mean - lambda)).toBeLessThan(4 * standardError);
    expect(variance / lambda).toBeGreaterThan(0.97);
    expect(variance / lambda).toBeLessThan(1.03);
  });
});

describe("pixel readout", () => {
  it("has variance equal to signal plus read noise squared", () => {
    const rng = mulberry32(99);
    const meanE = 400;
    const pitch = 6e-6;
    const { mean, variance } = stats(
      Array.from({ length: 100_000 }, () => samplePixelElectrons(meanE, pitch, rng)),
    );
    const expected = meanE + GENERIC_SENSOR.readNoise ** 2;
    expect(mean).toBeCloseTo(meanE, 0);
    expect(variance / expected).toBeGreaterThan(0.97);
    expect(variance / expected).toBeLessThan(1.03);
  });
});
