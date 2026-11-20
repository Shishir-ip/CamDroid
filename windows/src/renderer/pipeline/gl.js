// Single-pass WebGL2 uber-shader: orientation + face-zoom crop + full color
// suite + sharpness + masked background blur + vignette/grain.
import { pipeline } from '../store.js';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uFrame;
uniform sampler2D uMask;
uniform vec2 uFit;
uniform vec2 uCropCenter;
uniform float uCropScale;
uniform float uMirror;
uniform int uRotate;
uniform vec2 uTexel;
uniform float uAspect;

uniform float uExposure, uBrightness, uContrast;
uniform float uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uHue, uSaturation, uVibrance, uGamma, uSharp;
uniform float uBlurOn, uVignette, uGrain, uTime, uBypass;
uniform vec2 uBlurRad;
uniform float uFlipY;

vec2 mapUv(vec2 uv) {
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  vec2 p = uv - 0.5;
  if (uRotate == 1) p = vec2(-p.y, p.x);
  else if (uRotate == 2) p = -p;
  else if (uRotate == 3) p = vec2(p.y, -p.x);
  uv = p * uFit + 0.5;
  uv = (uv - 0.5) * uCropScale + uCropCenter;
  return uv;
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 hueShift(vec3 c, float a) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float i = dot(c, vec3(0.596, -0.274, -0.322));
  float q = dot(c, vec3(0.211, -0.523, 0.312));
  float ca = cos(a), sa = sin(a);
  float i2 = i * ca - q * sa;
  float q2 = i * sa + q * ca;
  return vec3(y + 0.956 * i2 + 0.621 * q2,
              y - 0.272 * i2 - 0.647 * q2,
              y - 1.106 * i2 + 1.703 * q2);
}

vec3 blurSample(vec2 uv) {
  vec2 r = uBlurRad;
  vec3 b = texture(uFrame, uv).rgb * 4.0;
  b += texture(uFrame, uv + vec2( r.x, 0.0)).rgb * 2.0;
  b += texture(uFrame, uv + vec2(-r.x, 0.0)).rgb * 2.0;
  b += texture(uFrame, uv + vec2(0.0,  r.y)).rgb * 2.0;
  b += texture(uFrame, uv + vec2(0.0, -r.y)).rgb * 2.0;
  b += texture(uFrame, uv + vec2( r.x,  r.y)).rgb;
  b += texture(uFrame, uv + vec2(-r.x,  r.y)).rgb;
  b += texture(uFrame, uv + vec2( r.x, -r.y)).rgb;
  b += texture(uFrame, uv + vec2(-r.x, -r.y)).rgb;
  b += texture(uFrame, uv + vec2( r.x * 2.0, 0.0)).rgb;
  b += texture(uFrame, uv + vec2(-r.x * 2.0, 0.0)).rgb;
  b += texture(uFrame, uv + vec2(0.0,  r.y * 2.0)).rgb;
  b += texture(uFrame, uv + vec2(0.0, -r.y * 2.0)).rgb;
  return b / 20.0;
}

void main() {
  vec2 uv = mapUv(vUv);
  // When rendering for virtual-camera readback, flip vertically so that the
  // bottom-up gl.readPixels result is already top-down (no CPU flip needed).
  if (uFlipY > 0.5) uv.y = 1.0 - uv.y;
  vec3 c = texture(uFrame, uv).rgb;

  if (uBypass > 0.5) {
    outColor = vec4(c, 1.0);
    return;
  }

  // --- exposure / white balance
  c *= pow(2.0, uExposure);
  c.r += uTemp * 0.12;
  c.b -= uTemp * 0.12;
  c.g += uTint * 0.10;

  // --- tone
  float l = luma(c);
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  c += uShadows * (1.0 - smoothstep(0.0, 0.5, l)) * 0.55;
  c -= uHighlights * smoothstep(0.5, 1.0, l) * 0.55;
  c += uWhites * smoothstep(0.72, 1.0, l) * 0.4;
  c -= uBlacks * (1.0 - smoothstep(0.0, 0.28, l)) * 0.4;
  c += uBrightness * 0.5;

  // --- color
  l = luma(c);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1.0 + uVibrance * (1.0 - sat));
  c = mix(vec3(l), c, 1.0 + uSaturation);
  if (abs(uHue) > 0.001) c = hueShift(c, uHue);
  c = clamp(c, 0.0, 1.0);
  c = pow(c, vec3(1.0 / max(uGamma, 0.05)));

  // --- sharpness (unsharp mask)
  if (uSharp > 0.001) {
    vec3 n = (texture(uFrame, uv + vec2(uTexel.x, 0.0)).rgb
            + texture(uFrame, uv - vec2(uTexel.x, 0.0)).rgb
            + texture(uFrame, uv + vec2(0.0, uTexel.y)).rgb
            + texture(uFrame, uv - vec2(0.0, uTexel.y)).rgb) * 0.25;
    c += (c - n) * uSharp * 2.2;
  }

  // --- background blur (person mask)
  if (uBlurOn > 0.5) {
    float m = texture(uMask, uv).r;
    float person = smoothstep(0.30, 0.70, m);
    vec3 blurred = blurSample(uv);
    c = mix(blurred, c, person);
  }

  // --- vignette / grain
  if (uVignette > 0.001) {
    float d = length((vUv - 0.5) * vec2(uAspect, 1.0));
    c *= 1.0 - uVignette * smoothstep(0.35, 1.0, d);
  }
  if (uGrain > 0.001) {
    float g = fract(sin(dot(gl_FragCoord.xy + mod(uTime, 10.0) * 61.0, vec2(12.9898, 78.233))) * 43758.5453);
    c += (g - 0.5) * uGrain * 0.16;
  }

  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

export class GlPipeline {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Link: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    const names = [
      'uFrame', 'uMask', 'uFit', 'uCropCenter', 'uCropScale', 'uMirror', 'uRotate',
      'uTexel', 'uAspect', 'uExposure', 'uBrightness', 'uContrast', 'uHighlights',
      'uShadows', 'uWhites', 'uBlacks', 'uTemp', 'uTint', 'uHue', 'uSaturation',
      'uVibrance', 'uGamma', 'uSharp', 'uBlurOn', 'uVignette', 'uGrain', 'uTime',
      'uBypass', 'uBlurRad', 'uFlipY'
    ];
    for (const n of names) this.u[n] = gl.getUniformLocation(prog, n);

    this.frameTex = this.makeTexture();
    this.maskTex = this.makeTexture();
    gl.uniform1i(this.u.uFrame, 0);
    gl.uniform1i(this.u.uMask, 1);

    this.srcW = 0;
    this.srcH = 0;
    this.hasFrame = false;
    this.hasMask = false;
    this.readFlip = false;
    this.startTime = performance.now();
    gl.clearColor(0.086, 0.086, 0.102, 1);
  }

  makeTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  }

  setFrame(bitmap) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    this.srcW = bitmap.width;
    this.srcH = bitmap.height;
    this.hasFrame = true;
  }

  setMask(bytes, w, h) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    this.hasMask = true;
  }

  render() {
    const gl = this.gl;
    const { adj, fx } = pipeline;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (!this.hasFrame || cw === 0 || ch === 0) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.viewport(0, 0, cw, ch);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);

    // aspect fit (contain) accounting for rotation
    const srcAspect = this.srcW / this.srcH;
    const rotated = fx.rotate % 2 === 1;
    const effAspect = rotated ? 1 / srcAspect : srcAspect;
    const dispAspect = cw / ch;
    const fitX = Math.min(1, effAspect / dispAspect);
    const fitY = Math.min(1, dispAspect / effAspect);

    // smoothed face crop
    let targetScale = 1;
    let targetCx = 0.5;
    let targetCy = 0.5;
    if (fx.faceZoom && pipeline.faceTarget) {
      targetScale = 1 / Math.max(1, fx.faceZoomLevel);
      targetCx = pipeline.faceTarget[0];
      targetCy = pipeline.faceTarget[1];
      const half = targetScale / 2;
      targetCx = Math.min(1 - half, Math.max(half, targetCx));
      targetCy = Math.min(1 - half, Math.max(half, targetCy));
    }
    const k = 0.03 + (1 - fx.faceSmooth / 100) * 0.28;
    pipeline.faceScale += (targetScale - pipeline.faceScale) * k;
    pipeline.faceCenter[0] += (targetCx - pipeline.faceCenter[0]) * k;
    pipeline.faceCenter[1] += (targetCy - pipeline.faceCenter[1]) * k;

    const blurPx = (fx.blurAmount / 100) * 26;
    const u = this.u;
    gl.uniform2f(u.uFit, fitX, fitY);
    gl.uniform2f(u.uCropCenter, pipeline.faceCenter[0], pipeline.faceCenter[1]);
    gl.uniform1f(u.uCropScale, pipeline.faceScale);
    gl.uniform1f(u.uMirror, fx.mirror ? 1 : 0);
    gl.uniform1i(u.uRotate, fx.rotate | 0);
    gl.uniform2f(u.uTexel, 1 / this.srcW, 1 / this.srcH);
    gl.uniform1f(u.uAspect, dispAspect);
    gl.uniform1f(u.uExposure, adj.exposure);
    gl.uniform1f(u.uBrightness, adj.brightness);
    gl.uniform1f(u.uContrast, adj.contrast);
    gl.uniform1f(u.uHighlights, adj.highlights);
    gl.uniform1f(u.uShadows, adj.shadows);
    gl.uniform1f(u.uWhites, adj.whites);
    gl.uniform1f(u.uBlacks, adj.blacks);
    gl.uniform1f(u.uTemp, adj.temperature);
    gl.uniform1f(u.uTint, adj.tint);
    gl.uniform1f(u.uHue, (adj.hue * Math.PI) / 180);
    gl.uniform1f(u.uSaturation, adj.saturation);
    gl.uniform1f(u.uVibrance, adj.vibrance);
    gl.uniform1f(u.uGamma, adj.gamma);
    gl.uniform1f(u.uSharp, adj.sharpness);
    gl.uniform1f(u.uBlurOn, fx.blurBg && this.hasMask ? 1 : 0);
    gl.uniform2f(u.uBlurRad, blurPx / this.srcW, blurPx / this.srcH);
    gl.uniform1f(u.uVignette, fx.vignette);
    gl.uniform1f(u.uGrain, fx.grain);
    gl.uniform1f(u.uTime, (performance.now() - this.startTime) / 1000);
    gl.uniform1f(u.uBypass, pipeline.bypass ? 1 : 0);
    // ImageBitmap uploads ignore UNPACK_FLIP_Y_WEBGL on this Chromium, so the
    // texture arrives top-down (v=0 = image top). Flip sampling here so the
    // on-screen preview is upright; readRgba()'s CPU flip then yields a
    // top-down upright buffer for the virtual camera, recordings and snapshots.
    gl.uniform1f(u.uFlipY, 1);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  readRgba() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const n = w * h * 4;
    if (!this._readBuf || this._readBuf.length !== n) {
      this._readBuf = new Uint8Array(n);
      this._flipBuf = new Uint8Array(n);
    }
    const buf = this._readBuf;
    const out = this._flipBuf;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // readPixels is bottom-up; flip to top-down for the virtual camera.
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      out.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    }
    return out;
  }
}