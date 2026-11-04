/**
 * Accuracy tiers for every simulated effect. The UI surfaces these so users
 * can tell exact calculations from modeled approximations and heuristics.
 * See PHYSICS.md for the full derivations.
 */
export type AccuracyTier = "exact" | "approximation" | "heuristic";

export interface EffectModel {
  id: string;
  name: string;
  tier: AccuracyTier;
  model: string;
  assumptions: string[];
}

export const EFFECT_MODELS = {
  fieldOfView: {
    id: "fieldOfView",
    name: "Field of view",
    tier: "exact",
    model: "Rectilinear projection through the thin-lens image distance",
    assumptions: ["Distortion-free rectilinear lens", "No focus breathing beyond the thin-lens image distance"],
  },
  perspective: {
    id: "perspective",
    name: "Perspective",
    tier: "exact",
    model: "Pinhole projection from the camera position",
    assumptions: ["Perspective depends only on camera position, never on focal length"],
  },
  defocus: {
    id: "defocus",
    name: "Defocus / depth of field",
    tier: "approximation",
    model: "Thin-lens blur circle; rendered with the exact defocused-pupil OTF (Hopkins) including diffraction",
    assumptions: [
      "Thin lens with pupil magnification 1; real multi-element lenses differ, especially at close focus",
      "Depth of field uses a conventional 30 µm circle of confusion",
    ],
  },
  diffraction: {
    id: "diffraction",
    name: "Diffraction",
    tier: "exact",
    model: "Fraunhofer diffraction of an aberration-free circular aperture at the working f-number N(1 + m)",
    assumptions: ["Unobstructed circular pupil (real lenses have polygonal apertures)"],
  },
  exposure: {
    id: "exposure",
    name: "Exposure",
    tier: "approximation",
    model: "Camera equation H = q·L·t / (N²(1 + m)²) with natural vignetting cos⁴θ",
    assumptions: [
      "Ratios between settings are exact for an aplanatic lens (sine condition) with pupil magnification 1",
      "Absolute level uses the ISO 2720 lens factor q = 0.65",
    ],
  },
  lighting: {
    id: "lighting",
    name: "Lighting and sky",
    tier: "approximation",
    model: "Subject illuminance on camera-facing surfaces; CIE overcast sky or fixed clear-sky horizon luminance",
    assumptions: [
      "Lambertian surfaces",
      "Sky is neutral grey",
      "Overcast sky normalized with its specular reflection in calm water; the water body's upwelling (≈ 1%) is neglected",
      "No shadows or interreflections",
    ],
  },
  shotNoise: {
    id: "shotNoise",
    name: "Photon shot noise",
    tier: "exact",
    model: "Poisson statistics of photon arrival",
    assumptions: [],
  },
  sensorModel: {
    id: "sensorModel",
    name: "Sensor response",
    tier: "approximation",
    model: "Generic sensor: quantum efficiency, full well per area, constant read noise, ISO as gain",
    assumptions: [
      "Effective photon flux of a green-filtered pixel, roughly ±50%",
      "ISO-invariant read noise; real sensors vary (dual conversion gain)",
      "Full-well capacity scales with pixel area",
      "Saturation-based ISO: an 18% card at metered exposure renders at 12.8% linear (sRGB 100/255)",
    ],
  },
  sampling: {
    id: "sampling",
    name: "Pixel sampling",
    tier: "approximation",
    model: "Box integration over each output pixel, with aliasing; the scene's tent prefilter is divided out analytically",
    assumptions: [
      "100% fill factor, no optical low-pass filter",
      "Native-pitch views oversample up to 4×, carrying aliases to 2 cycles/pixel (edge MTF within 0.01)",
      "Full-frame overview oversamples 2×, so aliases from above 1 cycle per output pixel are under-weighted (identical for every camera, since all share the overview pixel)",
    ],
  },
  colorSampling: {
    id: "colorSampling",
    name: "Color sampling",
    tier: "approximation",
    model: "Every pixel samples three bands (420–490, 500–580, 580–650 nm) with flat spectral response",
    assumptions: ["No Bayer color filter array or demosaicing yet", "Equal effective photon flux per channel"],
  },
  subjectMotion: {
    id: "subjectMotion",
    name: "Subject motion blur",
    tier: "exact",
    model: "Image displacement = (v_f / s) × subject displacement during the exposure",
    assumptions: ["Constant velocity during the exposure", "Instantaneous global shutter"],
  },
  cameraShake: {
    id: "cameraShake",
    name: "Camera shake",
    tier: "heuristic",
    model: "Angular motion of the camera; magnitude is not derivable from first principles",
    assumptions: ["Shake magnitude depends on the photographer, support and stabilization"],
  },
  layeredOcclusion: {
    id: "layeredOcclusion",
    name: "Occlusion and depth-varying blur",
    tier: "approximation",
    model: "Planes blurred individually and composited front over back; the water surface is a true ground plane whose points each blur by their own depth",
    assumptions: [
      "Exact for motion over a static background",
      "Approximate at defocused occlusion edges (no partial view around foreground objects)",
      "Objects standing in the water continue opaquely below the waterline, so blurred contact lines show no far water",
      "Water blur blends depth slices ≤ 15% apart in blur diameter, normalized so a uniform surface renders uniformly",
      "The slight brightness gradient across each ground point's blur disk (relative size A/H) is neglected",
    ],
  },
  cameraAim: {
    id: "cameraAim",
    name: "Camera aim",
    tier: "approximation",
    model: "Aim modeled as an image shift instead of a camera tilt",
    assumptions: ["Errors stay near 1% below a 5° aim angle; the app warns beyond that"],
  },
  waterReflection: {
    id: "waterReflection",
    name: "Water reflection",
    tier: "approximation",
    model: "Exact unpolarized Fresnel reflectance (n = 1.333) of the sky at the mirror elevation",
    assumptions: [
      "Ripple slope amplitude is a heuristic",
      "Facets tilted away from the camera are not masked by the wave crests in front of them",
      "Elongated footprints are integrated with up to 8 sub-samples in depth (within 4% of a brute-force area average)",
      "Water reflects the sky only; no reflections of the duck or background",
    ],
  },
  blurBudget: {
    id: "blurBudget",
    name: "Limiting-factor summary",
    tier: "heuristic",
    model: "Each blur reduced to one width and combined in quadrature",
    assumptions: ["UI guidance only; rendered images use full transfer functions"],
  },
  lensEnvelope: {
    id: "lensEnvelope",
    name: "Realistic lens envelope",
    tier: "heuristic",
    model: "Warning when the entrance pupil exceeds commercially typical sizes",
    assumptions: ["Threshold reflects the existing market, not a physical limit"],
  },
} as const satisfies Record<string, EffectModel>;

export type EffectId = keyof typeof EFFECT_MODELS;
