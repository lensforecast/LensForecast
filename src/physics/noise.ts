import { poisson, standardNormal, type Rng } from "./random";
import { fullWellCapacity, GENERIC_SENSOR, type SensorModel } from "./sensor";

/**
 * One noisy pixel readout in electrons: Poisson photon arrivals, clipped at
 * full well, plus Gaussian read noise.
 */
export function samplePixelElectrons(
  meanElectrons: number,
  pitch: number,
  rng: Rng,
  sensor: SensorModel = GENERIC_SENSOR,
): number {
  const collected = Math.min(poisson(meanElectrons, rng), fullWellCapacity(pitch, sensor));
  return collected + sensor.readNoise * standardNormal(rng);
}
