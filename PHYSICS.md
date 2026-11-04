# LensForecast physics specification

This document is the source of truth for every simulated photographic effect.
Each effect lists its model, its equations, its accuracy tier, the code that
implements it, and the tests that verify it. If code and this document
disagree, one of them is a bug.

## Principles

1. Every visible effect follows an established physical model, never an arbitrary visual adjustment.
2. Every approximation is named and documented here.
3. Every simulation is reproducible: all randomness uses seeded generators (`src/physics/random.ts`).
4. Every effect is verified by automated tests that measure outputs, not just restate formulas.
5. Physics-based does not mean real-world accurate. The tiers below make that distinction visible in the UI.

## Accuracy tiers

| Tier | Meaning |
|---|---|
| **exact** | Correct within the stated idealized model (e.g. an aberration-free thin lens). |
| **approximation** | Based on established physics but with named simplifications or generic parameters. |
| **heuristic** | No first-principles model exists; based on empirical rules. Off by default or clearly flagged. |

The registry of effects and their tiers lives in `src/physics/accuracy.ts`.

## Conventions

- SI units everywhere internally: meters, seconds, lux, cd/m². Helpers `mm()`, `um()`, `nm()` in `units.ts`.
- Distances are measured from the lens (thin-lens model: entrance pupil, exit pupil and principal planes coincide).
- Sensor: generic full frame, 36 × 24 mm.
- Colour bands for rendering, each sampled at 5 wavelengths with flat response (approximation): blue 420–490 nm, green 500–580 nm, red 580–650 nm. Single-wavelength formulas below use 550 nm.

## Image formation pipeline

Target design (3D studio):

1. **Scene** in physical units: geometry in meters, illumination in lux, Lambertian reflectances.
2. **Geometric optics** (renderer): a thin-lens path tracer samples rays across the aperture (defocus, partial occlusion) and across the shutter interval (motion blur). Perspective follows from the camera position.
3. **Wave optics**: defocus and diffraction together through the defocused-pupil OTF, per colour band, at the working f-number.
4. **Sampling**: the oversampled irradiance image is integrated over each pixel aperture.
5. **Sensor**: exposure → photoelectrons → Poisson shot noise → full-well clip → read noise → ISO gain → output.
6. **Comparison**: outputs from different resolutions are compared at equal output size by default.

The current 2.5D prototype implements steps 1 and 3–6 fully and step 2 with layers, as described next.

## 2.5D prototype renderer — `src/render/`

### Scene — `studio.ts`

Radiance factors are in units of a white Lambertian surface under the subject illuminance \(E\) (\(L = E/\pi\)). Layers, back to front:

- **Water** (`water`): a true horizontal ground plane at \(Y = -H\) out to the horizon. Each image row sees it at its own depth \(Z = H v_f / (-y')\), so ripples, perspective and defocus follow the real geometry.
- **Background**: rocks and foliage on a plane at the background distance, ending at the waterline. Gaps in the foliage show the sky.
- **Water in front of the background** and **water in front of the duck**: the same surface again, kept only within blur reach of the background's and the duck's waterline, so the nearer water occludes their blurred bottom edges. Because the full water surface lies behind every partly transparent edge, seams cannot leak sky: a scene whose every surface has one radiance renders uniformly within 0.5% (tested).
- **Contact lines**: rock and water at the same depth form one continuous surface, so the water hidden behind the rock must never show through the rock's blurred waterline. The background and the duck therefore continue opaquely below their waterlines (the duck as its waterline cross-section), and the renderer keeps that submerged part exactly as deep as the blur reaches. The water in front keeps enough rows to stay opaque over it. A wall and a moving box standing in water render within 0.005 of a reference in which both are opaque all the way down (tested, three lens settings).
- **Slanted-edge target**: 5° edge card beside the duck.
- **Duck**: shapes with scalloped feathers whose barbs and barbules run over seven octaves down to 12–20 µm, plus mottling down to 10 µm. At 1200 mm and 10 m the 61 MP Nyquist period on the duck is 55 µm; more than 1% of the head's texture variance lies beyond 1.25× that frequency (tested), so the scene never limits a resolution comparison.

**Sky** (approximation): CIE standard overcast sky \(L(\gamma) = L_z(1 + 2\sin\gamma)/3\), normalized so that the illuminance on a vertical surface facing the camera equals the preset illuminance. That surface sees the sky above, \(\tfrac23(\tfrac\pi4 + \tfrac23)L_z = 0.968\,L_z\), and the sky mirrored by calm water below, \(2\int_0^{\pi/2} R(\sin\delta)L(\delta)\cos^2\delta\,d\delta = 0.148\,L_z\) with Fresnel reflectance \(R\); the horizon radiance factor is then 0.938. The water body's own upwelling light (about 1%) is neglected. Clear-sky presets use a fixed horizon luminance (8 kcd/m² sunny, 6 kcd/m² hazy) with the sun behind the photographer. The sky is neutral grey and a function of elevation only.

**Water reflection** (approximation): a facet tilted by \(\alpha\) towards the camera, seen at depression \(\delta = \arctan(H/Z)\), reflects the sky at elevation \(\delta + 2\alpha\) with exact unpolarized Fresnel reflectance (\(n = 1.333\)) at \(\cos\theta_i = \sin(\delta + \alpha)\), plus the water body's upwelling radiance weighted by \(1 - R\). Ripple slopes (RMS-scale 0.04 rad) are a heuristic, and facets tilted away from the camera are not masked by the crests in front of them. Water reflects only the sky, not the duck or background. Footprints elongated in depth (ratio \(Z/H\)) are integrated with up to 8 sub-samples along \(Z\), matching a brute-force area average to within 5% of the texture's standard deviation at 30 and 60 m (tested).

**Prefiltering**: every sample is the scene prefiltered by a separable tent of half-width equal to the sample footprint (box ⊗ box, transfer \(\mathrm{sinc}^2(f w)\)). Outlines use the exact tent-integrated step on their signed distance; sinusoids use the exact factor \(\mathrm{sinc}^2(w/p)\); fractal noise drops octaves finer than the footprint (approximately band-limiting). The tent's sidelobes fall as \(1/f^2\), which keeps aliasing of sharp outlines on the fine grid below 0.01 of edge MTF.

### Projection

A point \((X, Y)\) at distance \(s\) images at \(x = X v_f/s\), with \(v_f\) the image distance at the focus distance: the chief ray through the pupil centre, which is the centre of a defocused blur circle (tested at 0.1 pixel). Camera aim is modeled as an image shift instead of a camera tilt (approximation). The position error is of order (aim angle × field angle) and reaches about 1% of the field at a 5° aim; the app warns when the aim angle exceeds 5°.

### Optics — `pipeline.ts`, `otf.ts`

Every blur is an analytic transfer function applied in the frequency domain:

| Effect | Transfer function | Tier |
|---|---|---|
| Defocus with diffraction (per layer, per colour band) | Hopkins defocused-pupil OTF \(H(s) = \tfrac4\pi\int_0^{\arccos s}\sin^2\varphi\cos(\pi c f(\cos\varphi - s))\,d\varphi\), \(s = f\lambda N_w\), averaged over 5 wavelengths per band | exact for a thin, aberration-free lens |
| Subject motion (per layer) | \(\mathrm{sinc}(\mathbf b\cdot\mathbf f)\), streak \(\mathbf b = \mathbf v\,t\,v_f/s\); at Nyquist rows and columns the ± signs are averaged so the filter stays Hermitian | exact for constant velocity |
| Diffraction (system, per colour band) | Circular-aperture MTF at the working f-number \(N_w = N(1+m)\), averaged over the band | exact (aberration-free) |
| Pixel integration | \(\mathrm{sinc}(P f_x)\,\mathrm{sinc}(P f_y)\), output pixel size \(P\), followed by sampling (with aliasing) | exact transfer; aliasing approximated by finite oversampling (below) |
| Relative illumination | \(\cos^4\theta\) about the optical axis | exact for an aplanatic lens without mechanical vignetting |

Layers apply the ratio (defocused OTF / diffraction MTF) per band; the system applies the band diffraction MTF once. The product is exactly the Hopkins OTF for defocused layers and the diffraction MTF for in-focus ones. Measured edge MTFs match the Hopkins OTF at \(c = 4\lambda N_w\) and the diffraction MTF at \(N(1+m)\) (1200 mm at 5 m) within 0.01 (tested).

Layers are blurred individually (premultiplied colour, and coverage filtered per colour band) and composited front over back. This is exact for a moving object over a static background, but approximate for defocused occlusion edges: a real lens partially sees around a blurred foreground edge.

**Water depth blur** (approximation): the ground's blur circle \(c(y') = A\,|y'/H + v_f/s_f|\) is piecewise linear in image height. Blur levels are spaced by \(\max(0.15\,c, P/2)\); each ground point's content is split between the two nearest levels with tent weights, every level is blurred with its own exact OTF, and the results are summed. This is a scatter model: each point blurs by its own depth (a line on the water at 25, 30, 40 m blurs by its own \(c\) within 10%, tested). The sum is divided by the same operator applied to the weights alone, which restores radiance invariance (a uniform surface images uniformly) and neglects the slight brightness gradient, of relative size \(A/H\), across each ground point's blur disk.

Numerical choices (each verified by tests):

- Fine grid oversampling: native-pitch views use up to 4 samples per output pixel, enough to carry every alias up to 2 cycles/pixel (higher aliases are suppressed by \(\mathrm{sinc}^2 < 0.02\)). The full-frame overview and previews use 2×, which under-weights aliases from above 1 cycle per output pixel (a grating at 1.3 cycles/pixel aliases with about half its true amplitude). Every camera shares the same overview pixel, so this does not bias comparisons.
- The tent prefilter \(\mathrm{sinc}^2(f h)\) of the fine grid is divided out in the system stage, so no resolution gets an artificial advantage: the same grating renders with contrast equal to diffraction × its own pixel aperture on 24 and 61 MP, within 0.5% of each other (tested).
- Strongly defocused layers are sampled on coarser grids with ≥ 12 samples across the blur circle; the coarse sampling and bilinear upsampling transfer is replaced analytically by the fine-grid transfer.
- FFT grids (sizes \(2^k\) or \(3\cdot2^k\)) are padded with real scene content plus a diffraction margin of \(16\lambda N_w\). The Airy pattern carries about 1% of its energy beyond that radius, so a faint wrap-around remains at the frame edges. Thin in-focus water slices are filtered periodically across the grid width when their blur fits in the margin.

### Readout

Per output pixel: \(\bar n = H\,\Phi\,p^2\,QE \cdot k\) electrons with \(k = (P/p)^2\) sensor pixels binned and \(H\) from the camera equation including the bellows factor. The sum of \(k\) Poisson variables is Poisson, so binned shot noise is exact; read noise adds \(\sigma_r\sqrt{k}\). The full-well clip is applied to the binned sum (approximation; matters only near clipping). Output level \(= n / n_{white}(S)\), then standard sRGB encoding for display. The sRGB encoding is a display convention, not physics; no tone curve is applied.

Approximations still open: no Bayer colour filter array or demosaicing (every pixel sees all three bands); equal effective photon flux per band.

### Readouts — `src/readouts.ts`

The numbers beside each image use the renderer's own models: exposure with the bellows factor, Airy FWHM and the limiting-factor summary at the working f-number, subject motion at the chief-ray scale \(v_f/s\), SNR at the displayed pixel size, and the aim-angle warning. A test checks that the reported EV offset equals the EV of a rendered 18% grey card.

### Views

- **Full frame**: the whole sensor at a common 480 × 320 output size (binning varies per sensor): the fair "same print size" comparison.
- **Detail crop**: the same sensor area around the duck's head at each sensor's native pixel pitch, displayed at equal size with visible pixels: the resolution comparison.
- Rendering is progressive: a 4× binned preview first, then the full result, each camera in its own Web Worker.

---

## Geometric optics — `optics.ts`

### Thin-lens equation (exact within the model)

\[ \frac{1}{f} = \frac{1}{s} + \frac{1}{v}, \qquad m = \frac{v}{s} = \frac{f}{s - f} \]

### Field of view (exact)

\[ \theta = 2\arctan\frac{d}{2v} \]

where \(d\) is the sensor dimension and \(v\) the image distance at the focus distance. At infinity \(v = f\):
100 mm gives 20.4° horizontal, 1200 mm gives 1.72°. Focusing closer narrows the field slightly (focus breathing of an ideal thin lens).

### Perspective (exact)

Perspective depends only on camera position. Changing focal length from the same position only crops or enlarges the same perspective. Camera height and subject-to-background distance change perspective.

### Defocus blur circle (approximation: thin lens)

\[ c = A\,\frac{|s - s_f|}{s}\cdot\frac{f}{s_f - f}, \qquad A = \frac{f}{N} \]

For a background at infinity: \(c_\infty = A\,f/(s_f - f)\).

### Depth of field (approximation: thin lens, chosen circle of confusion)

\[ H = \frac{f^2}{N c} + f, \qquad s_{near} = \frac{s(H - f)}{H + s - 2f}, \qquad s_{far} = \frac{s(H - f)}{H - s}\ (s < H) \]

Depth of field depends on the viewing assumption \(c\) (default 30 µm, a convention, not physics). The renderer itself does not use \(c\): it renders the true blur at every depth.

Example: 1200 mm f/2.8 focused at 30 m gives ≈ 10 cm total depth of field, so a duck's body is not fully sharp.

### Realistic lens envelope (heuristic)

The app allows any focal length and aperture combination. It warns when the entrance pupil \(f/N\) exceeds 160 mm, roughly the largest in common commercial lenses (600 mm f/4 ≈ 150 mm). Example: 1200 mm f/2.8 would need a 429 mm pupil. The threshold reflects the market, not physics.

## Diffraction — `diffraction.ts`

### Airy pattern (exact for an aberration-free circular aperture)

\[ \frac{I(r)}{I_0} = \left[\frac{2 J_1(x)}{x}\right]^2, \qquad x = \frac{\pi r}{\lambda N} \]

- First dark ring diameter: \(2.44\,\lambda N\) (21.5 µm at f/16, 550 nm).
- Full width at half maximum: \(1.029\,\lambda N\).
- \(J_1\) uses the Numerical Recipes rational approximation (error < 1e-8).

### Diffraction MTF (exact)

\[ \text{MTF}(\nu) = \frac{2}{\pi}\left(\arccos\nu - \nu\sqrt{1 - \nu^2}\right), \qquad \nu = \frac{f_{spatial}}{f_c}, \qquad f_c = \frac{1}{\lambda N} \]

No detail finer than \(f_c\) reaches the sensor, regardless of pixel count.

### Pixel sampling

- Nyquist frequency: \(1/(2p)\) for pixel pitch \(p\).
- Pixel aperture MTF (100% fill factor): \(|\mathrm{sinc}(f p)|\).

| Resolution | Pixels | Pitch | Nyquist |
|---|---|---|---|
| 24 MP | 6000 × 4000 | 6.00 µm | 83 cycles/mm |
| 33 MP | 7008 × 4672 | 5.14 µm | 97 cycles/mm |
| 61 MP | 9564 × 6376 | 3.76 µm | 133 cycles/mm |

The diffraction cutoff at 550 nm is 114 cycles/mm at f/16. Averaged over the green band (500–580 nm), the MTF at the 61 MP Nyquist frequency (133 cycles/mm) is exactly 0, and at 111 cycles/mm, beyond 24 MP Nyquist, it is about 1%: a grating there renders with under 1.5% modulation on 61 MP, matching the band-averaged prediction (tested). The extra pixels cannot add detail that diffraction has already removed. All diffraction uses the working f-number \(N_w = N(1+m)\), which at 1200 mm focused at 5 m is 32% larger than the marked aperture.

### Defocus and diffraction together (exact within the thin, aberration-free model)

Defocus and diffraction both come from the pupil function, so they are combined through the Hopkins (1955) defocused-pupil OTF, parameterized by the geometric blur diameter \(c\) (peak defocus wavefront error \(W_{020} = c/(8N_w)\)):

\[ H(s) = \frac{4}{\pi}\int_0^{\arccos s}\sin^2\varphi\,\cos\big(\pi c f(\cos\varphi - s)\big)\,d\varphi, \qquad s = f\lambda N_w \]

It reduces to the diffraction MTF at \(c = 0\) and approaches the product of the geometric disk OTF and the diffraction MTF only for large defocus. At \(c = 4\lambda N\) the product differs from it by more than 0.15. Simpson quadrature is verified against a brute-force 2D pupil autocorrelation (`wave.test.ts`).

### Known limitations

- Real apertures are polygonal; this changes the PSF shape slightly (approximation).
- No lens aberrations: the lens is ideal at every aperture.

## Exposure — `exposure.ts`

### Camera equation (approximation: generic lens factor)

\[ E = \frac{q\,L}{N^2 (1 + m)^2}\cos^4\theta, \qquad H = E\,t \]

- The geometric factor \(\pi/(4N_w^2)\) is exact for an aplanatic lens obeying the sine condition (pupil magnification 1). A planar-pupil thin lens would give \(\pi/(1 + 4N_w^2)\) instead, 3.1% dimmer at f/2.8; the aplanatic form describes real photographic lenses better.
- \(q = 0.65\) (ISO 2720) bundles \(\pi/4\) with typical transmission; absolute brightness is therefore an approximation, while ratios between settings are exact within the model.
- \((1 + m)^2\) is the bellows factor: 0.79 EV at 1200 mm focused at 5 m, 0.12 EV at 30 m. Renderer and readouts share one implementation (`sensorExposure`).
- \(\cos^4\theta\) is natural relative illumination about the optical axis (no mechanical vignetting): 0.91 in the corner at 100 mm, 0.9994 at 1200 mm.

### Scene luminance (approximation: Lambertian surfaces)

\[ L = \frac{\rho\,E_{scene}}{\pi} \]

### Metering and ISO (exact definitions)

- Reflected meter: \(t = K N^2 / (L S)\), \(K = 12.5\).
- Incident meter: \(t = C N^2 / (E S)\), \(C = 250\).
- ISO 12232 standard output sensitivity: middle grey at \(H_m = 10/S\).
- ISO 12232 saturation sensitivity: clipping at \(H_{sat} = 78/S\).
- The sensor maps white to \(H_{sat}\) (saturation-based ISO), so an 18% card at metered exposure lands at 12.8% linear, sRGB 100/255. Readouts report exposure relative to \(H_m = 10/S\); the two definitions differ by design and are both standard.

Validation: the "sunny 16" rule (f/16, 1/ISO s in bright sun) is reproduced within one stop at 100,000 lux.

### Lighting presets (approximation)

Illuminance on camera-facing (vertical) subject surfaces, i.e. what an incident meter pointed at the camera reads: sun behind the photographer 75,000 lx · hazy 30,000 · overcast 5,000 · heavy overcast 1,000 · dusk 50. Overcast and dusk use the CIE overcast sky; sun and hazy use a fixed horizon luminance of 8 and 6 kcd/m². Real conditions vary widely.

## Sensor — `sensor.ts`, `noise.ts`, `random.ts`

### Photon conversion (approximation)

\[ n_{e^-} = H \cdot \Phi \cdot p^2 \cdot QE, \qquad \Phi = \frac{1}{683 \cdot hc/\lambda_{555}} \approx 4.09\times10^{15}\ \text{photons}/(\text{m}^2\,\text{lx}\,\text{s}) \]

This is the effective photon flux of a green-filtered pixel under daylight, roughly ±50%. Generic parameters: \(QE = 0.5\), full well 1700 e⁻/µm² (≈61k e⁻ at 6 µm), read noise 2 e⁻ RMS. These give a base ISO near 100, consistent with real full-frame sensors without copying any of them.

### ISO is a gain (exact within the model)

ISO sets which electron count maps to white (\(H_{sat} = 78/S\)). It never changes how many photons are collected. A raised-ISO image looks noisier because it was given less light, not because of the ISO setting itself. Read noise is modeled as ISO-invariant (approximation; real sensors often use dual conversion gain).

### Noise (shot noise exact, read noise approximation)

- Photon arrivals: Poisson, sampled exactly (Knuth for λ < 10, Hörmann PTRS above).
- Clip at full-well capacity, then add Gaussian read noise.
- Per-pixel SNR: \(n / \sqrt{n + \sigma_r^2}\).

### Fair resolution comparison (exact)

Smaller pixels have lower per-pixel SNR, but at equal output size \(k = (p_{out}/p)^2\) pixels combine:

\[ \text{SNR}_{out} = \text{SNR}_{pixel}\sqrt{k} \]

With shot noise only, all resolutions are identical at equal output size. Read noise adds a small penalty for more pixels (< 2% in good light). The UI therefore compares at equal output size by default and offers 100% crops as a secondary view.

## Motion — `motion.ts`

### Subject motion (exact for constant velocity)

\[ b = v\,t\,\frac{v_f}{s} \]

the chief-ray scale at the subject distance \(s\) with focus at \(s_f\); it equals \(v\,t\,m\) when the subject is in focus. Example: a duck swimming 0.5 m/s at 30 m, 1200 mm, 1/250 s gives 83 µm ≈ 14 pixels on 24 MP. Focused at 10 m instead, the streak is 9% longer.

### Camera rotation (formula exact; magnitude heuristic)

\[ b = v_f \tan(\omega t) \]

The angular speed \(\omega\) of a handheld camera depends on the photographer, support and stabilization. The traditional "1/focal length" shutter rule is a heuristic and will be labeled as such.

## Limiting-factor summary — `sharpness.ts` (heuristic)

For UI guidance only, each blur is reduced to a single width on the sensor (diffraction FWHM at the working f-number, defocus diameter, motion length, and the larger of the pixel pitch and the displayed pixel), combined in quadrature, and the largest is reported as the limiting factor. Quadrature addition of unlike PSF widths is an empirical rule; rendered images use full transfer functions.

## Scene detail requirement

At 1200 mm and 30 m, one 61 MP pixel covers about 0.09 mm of the subject; at 10 m, about 0.03 mm. Scene textures must contain detail finer than this. Otherwise texture resolution, not the camera, limits sharpness and resolution comparisons become meaningless. Duck feathers carry detail down to 10–20 µm and the background down to 0.1 mm (tested at 1200 mm, 10 m). A slanted-edge target (ISO 12233) sits beside the duck for MTF measurement.

## Validation plan

| Check | Status |
|---|---|
| Closed-form optics, diffraction, exposure, lighting, sensor and motion formulas | Done, `src/physics/*.test.ts` |
| Hopkins OTF against a brute-force pupil autocorrelation; colour-band MTFs | Done, `wave.test.ts` |
| CIE sky integrals including the sky mirrored by water, horizon factor; exact Fresnel against the textbook form | Done, `lighting.test.ts` |
| Poisson and Gaussian sampler statistics, seeded reproducibility | Done |
| Rendered edge MTF = band diffraction × pixel, with aliasing, within 0.01 (f/16 at 2 µm; f/4 at 6 µm) | Done, `src/render/pipeline.test.ts` |
| Edge MTF at the working f-number (1200 mm, 5 m) and with small defocus (Hopkins), within 0.01 | Done, `fidelity.test.ts` |
| Defocused edge equals the analytic uniform-disk edge spread, within 1% | Done |
| Defocused planes land at the chief-ray position \(X v_f / s\), within 0.1 pixel | Done |
| Moving edge renders as a linear ramp of length \(v t v_f/s\) | Done |
| Uniform surface: output equals the closed-form sensor model (with cos⁴); one stop of aperture halves the signal | Done |
| Electron variance = mean + read noise², native and binned | Done |
| Grating beyond 24 MP Nyquist: predicted contrast at f/4 within 1%; band residue < 1.5% at f/16 | Done |
| Same grating on 24 and 61 MP agrees with diffraction × own pixel aperture within 0.5% | Done |
| Uniform-radiance studio renders uniformly within 0.5% (four lens settings) | Done |
| Objects standing in water (static wall, moving box) match an occlusion-correct reference within 0.005 | Done |
| A line on the water blurs by the blur circle of its own depth, within 10% | Done |
| Red and green stay independent through packed FFTs, also with diagonal motion | Done |
| Sky rows follow the sky model by elevation | Done |
| Readout EV equals a rendered grey card; aim warning; chief-ray motion readout | Done |
| Duck texture has detail beyond 61 MP Nyquist at 1200 mm, 10 m | Done |
| Water footprint filtering matches a brute-force area average within 5% σ at 30 and 60 m | Done |
| FFT (2^k and 3·2^k) against a naive DFT; restricted row passes; analytic OTF zeros | Done, `fft.test.ts` |
| Measure MTF from the in-scene slanted-edge target in UI renders | Planned |

## Roadmap

1. **Physics core and spec** (done).
2. **2.5D prototype**: textured planes at known distances through the full image pipeline (done; current app).
3. **3D wildlife studio**: progressive WebGPU path tracer with a fast approximate preview that refines to the accurate result.
4. **Comparison UX**: equal-output-size side-by-side and split views, exposure trade-off panel, limiting-factor readout, accuracy badges.
5. **Uploaded photographs**: EXIF extraction, monocular depth estimation (approximation), physically sound changes only.
