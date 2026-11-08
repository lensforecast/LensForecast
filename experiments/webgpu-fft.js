/** Experimental full-grid, radix-2/radix-3 WebGPU FFT. Not used by the photo renderer. */
const shader = /* wgsl */ `
struct Params { width:u32, height:u32, axis:u32, stage:u32, inverse:u32, bits:u32, padding0:u32, padding1:u32 };
@group(0) @binding(0) var<storage,read_write> data: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> p: Params;
@group(0) @binding(2) var<storage,read_write> scratch: array<vec2<f32>>;
fn offset(line:u32, position:u32) -> u32 {
  if (p.axis == 0u) { return line * p.width + position; }
  return position * p.width + line;
}
@compute @workgroup_size(128)
fn reorder(@builtin(global_invocation_id) gid:vec3<u32>) {
  let length = select(p.width, p.height, p.axis == 1u);
  let lines = select(p.height, p.width, p.axis == 1u);
  let i = gid.x;
  if (i >= length * lines) { return; }
  let pos = i % length;
  let line = i / length;
  let rev = reverseBits(pos) >> (32u - p.bits);
  if (pos < rev) {
    let a = offset(line, pos);
    let b = offset(line, rev);
    let t = data[a]; data[a] = data[b]; data[b] = t;
  }
}
@compute @workgroup_size(128)
fn split3(@builtin(global_invocation_id) gid:vec3<u32>) {
  let length = select(p.width, p.height, p.axis == 1u);
  let i = gid.x; if (i >= p.width*p.height) { return; }
  let line = i / length; let pos = i % length; let m = length / 3u;
  let lane = pos / m; let k = pos % m;
  let rev = select(0u, reverseBits(k) >> (32u - p.bits), p.bits > 0u);
  scratch[offset(line,pos)] = data[offset(line,3u*rev+lane)];
}
@compute @workgroup_size(128)
fn merge3(@builtin(global_invocation_id) gid:vec3<u32>) {
  let length = select(p.width, p.height, p.axis == 1u); let m = length / 3u;
  let i = gid.x; if (i >= p.width*p.height/3u) { return; }
  let k = i % m; let line = i / m;
  let sign = select(-1.0, 1.0, p.inverse == 1u);
  let angle = sign * 6.283185307179586 * f32(k) / f32(length);
  let w1=vec2<f32>(cos(angle),sin(angle)); let w2=vec2<f32>(cos(2.0*angle),sin(2.0*angle));
  let a=data[offset(line,k)]; let b=data[offset(line,k+m)]; let c=data[offset(line,k+2u*m)];
  let t1=vec2<f32>(b.x*w1.x-b.y*w1.y,b.x*w1.y+b.y*w1.x);
  let t2=vec2<f32>(c.x*w2.x-c.y*w2.y,c.x*w2.y+c.y*w2.x);
  let sum=t1+t2; let diff=t1-t2;
  let cross=vec2<f32>(-sign*0.8660254037844386*diff.y,sign*0.8660254037844386*diff.x);
  let scale=select(1.0,1.0/f32(length),p.inverse==1u);
  data[offset(line,k)]=(a+sum)*scale;
  data[offset(line,k+m)]=(a-0.5*sum+cross)*scale;
  data[offset(line,k+2u*m)]=(a-0.5*sum-cross)*scale;
}
@compute @workgroup_size(128)
fn butterfly(@builtin(global_invocation_id) gid:vec3<u32>) {
  let length = select(p.width, p.height, p.axis == 1u);
  let lines = select(p.height, p.width, p.axis == 1u);
  let i = gid.x;
  if (i >= (length / 2u) * lines) { return; }
  let m = select(length, length / 3u, p.padding0 == 1u);
  let pair = i % (length / 2u);
  let line = i / (length / 2u);
  let lane = pair / (m / 2u);
  let localPair = pair % (m / 2u);
  let half = p.stage / 2u;
  let j = localPair % half;
  let pos = lane * m + (localPair / half) * p.stage + j;
  let angle = select(-1.0, 1.0, p.inverse == 1u) * 6.283185307179586 * f32(j) / f32(p.stage);
  let w = vec2<f32>(cos(angle), sin(angle));
  let a = offset(line, pos); let b = offset(line, pos + half);
  let v = data[b]; let t = vec2<f32>(v.x*w.x-v.y*w.y, v.x*w.y+v.y*w.x);
  let u = data[a];
  let scale = select(1.0, 1.0/f32(length), p.inverse == 1u && p.stage == length && p.padding0 == 0u);
  data[a] = (u+t)*scale; data[b] = (u-t)*scale;
}
`;

export async function createGpuFft() {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: shader });
  const messages = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
  if (messages.length) throw new Error(messages.map((m) => m.message).join('; '));
  const reverse = await device.createComputePipelineAsync({layout:'auto', compute:{module,entryPoint:'reorder'}});
  const butterfly = await device.createComputePipelineAsync({layout:'auto', compute:{module,entryPoint:'butterfly'}});
  const split = await device.createComputePipelineAsync({layout:'auto', compute:{module,entryPoint:'split3'}});
  const merge = await device.createComputePipelineAsync({layout:'auto', compute:{module,entryPoint:'merge3'}});
  return {
    info: adapter.info,
    destroy() { device.destroy(); },
    async transform(re, im, width, height, inverse = false) {
      if (width < 2 || height < 2 || ![width,height].every((n) => Number.isInteger(Math.log2(n)) || (n % 3 === 0 && Number.isInteger(Math.log2(n / 3)))) || re.length !== width * height || im.length !== re.length) throw new RangeError('Dimensions must be 2^k or 3·2^k, at least 2, and match input arrays.');
      const data = new Float32Array(re.length * 2);
      for (let i = 0; i < re.length; i++) { data[2*i] = re[i]; data[2*i+1] = im[i]; }
      let storage = device.createBuffer({size:data.byteLength, usage:GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
      let spare = device.createBuffer({size:data.byteLength, usage:GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
      const result = device.createBuffer({size:data.byteLength, usage:GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      const params = [];
      try {
        device.queue.writeBuffer(storage,0,data);
        const encoder = device.createCommandEncoder();
        for (const axis of [0,1]) {
          const size = axis === 0 ? width : height;
          const mixed = !Number.isInteger(Math.log2(size));
          const m = mixed ? size / 3 : size;
          const run = (pipeline, stage, count, includeScratch = false) => {
            const values = new Uint32Array([width,height,axis,stage,inverse ? 1 : 0,Math.log2(m),mixed ? 1 : 0,0]);
            const uniform = device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
            params.push(uniform); device.queue.writeBuffer(uniform,0,values);
            const entries = [{binding:0,resource:{buffer:storage}},{binding:1,resource:{buffer:uniform}}];
            if (includeScratch) entries.push({binding:2,resource:{buffer:spare}});
            const bind = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
            const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0,bind);
            pass.dispatchWorkgroups(Math.ceil(count/128)); pass.end();
          };
          if (mixed) { run(split,0,re.length,true); [storage,spare] = [spare,storage]; }
          else run(reverse,0,re.length);
          for (let stage = 2; stage <= m; stage *= 2) run(butterfly,stage,re.length/2);
          if (mixed) run(merge,0,re.length/3);
        }
        encoder.copyBufferToBuffer(storage,0,result,0,data.byteLength);
        device.queue.submit([encoder.finish()]);
        await result.mapAsync(GPUMapMode.READ);
        const values = new Float32Array(result.getMappedRange());
        for (let i = 0; i < re.length; i++) { re[i] = values[2*i]; im[i] = values[2*i+1]; }
        result.unmap();
      } finally { for (const buffer of params) buffer.destroy(); storage.destroy(); spare.destroy(); result.destroy(); }
    },
  };
}
