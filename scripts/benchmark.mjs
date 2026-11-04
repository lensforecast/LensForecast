// Run with Node 22.15+: npm run benchmark. Optional: node --cpu-prof --cpu-prof-dir=.scratch scripts/benchmark.mjs
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.')) return nextResolve(specifier + '.ts', context);
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    return nextLoad(url, context);
  },
});
const source = process.env.BENCH_SOURCE ?? '../src/';
const { readOut, encodeSrgb } = await import(source + 'render/pipeline.ts');
const { OpticalCache } = await import(source + 'render/cache.ts');
const { DEFAULT_STUDIO, DUCK_HEAD_OFFSET } = await import(source + 'render/studio.ts');
const { RESOLUTION_PRESETS } = await import(source + 'physics/sensor.ts');
const cache = new OpticalCache();
const shot = { focalLength: 0.6, fNumber: 5.6, focusDistance: 30, shutterTime: 1/500, iso: 800, illuminance: 5000, resolution: RESOLUTION_PRESETS[0] };
const scale = (0.6 * 30 / (30 - 0.6)) / 30;
const scenarios = [
  ['fit 600×400', { centerX: 0, centerY: 0, width: 0.036, height: 0.024, outputPixelSize: 0.036/600, oversample: 2 }],
  ['native 600×400', { centerX: DUCK_HEAD_OFFSET.x*scale, centerY: DUCK_HEAD_OFFSET.y*scale, width: 600*6e-6, height:400*6e-6, outputPixelSize:6e-6 }],
];
for (const [name, view] of scenarios) {
  const start=performance.now();
  const request = {id:1,studio:DEFAULT_STUDIO,shot,view,noise:true,seed:1};
  const image=cache.get(request);
  const optics=performance.now();
  encodeSrgb(readOut(image,shot), image.width, image.height);
  console.log(JSON.stringify({name,opticsMs:Math.round(optics-start),sensorMs:Math.round(performance.now()-optics),grid:image.grid}));
  const changed={...request,shot:{...shot,iso:1600}};
  const reuseStart=performance.now();
  const reused=cache.get(changed);
  encodeSrgb(readOut(reused,changed.shot), reused.width, reused.height);
  console.log(JSON.stringify({name:name+" ISO change",elapsedMs:Math.round(performance.now()-reuseStart),reused:reused===image}));
}
