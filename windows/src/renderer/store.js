// Shared mutable pipeline state (read every frame by the GL loop, written by React).

export const DEFAULT_ADJ = {
  exposure: 0,        // -2..2 stops
  brightness: 0,      // -1..1
  contrast: 0,        // -1..1
  highlights: 0,      // -1..1 (positive = recover)
  shadows: 0,         // -1..1 (positive = lift)
  whites: 0,          // -1..1
  blacks: 0,          // -1..1
  temperature: 0,     // -1..1 (warm+)
  tint: 0,            // -1..1 (green+)
  hue: 0,             // -180..180 deg
  saturation: 0,      // -1..1
  vibrance: 0,        // -1..1
  gamma: 1,           // 0.5..2
  sharpness: 0        // 0..1
};

export const DEFAULT_FX = {
  blurBg: false,
  blurAmount: 50,     // 0..100
  faceZoom: false,
  faceZoomLevel: 1.6, // 1..3
  faceSmooth: 60,     // 0..100
  vignette: 0,        // 0..1
  grain: 0,           // 0..1
  mirror: false,
  rotate: 0,          // 0..3 (x90deg)
  grid: false
};

export const PRESETS = {
  Natural: {},
  Vivid: { vibrance: 0.45, contrast: 0.12, saturation: 0.1 },
  Warm: { temperature: 0.35, tint: -0.05, shadows: 0.1 },
  Cool: { temperature: -0.35, tint: 0.05, contrast: 0.08 },
  Cinematic: { contrast: 0.22, shadows: 0.18, highlights: 0.15, saturation: -0.12, temperature: 0.12, vignette: 0.35 },
  Mono: { saturation: -1, contrast: 0.15 },
  'Low light': { exposure: 0.7, shadows: 0.4, brightness: 0.12, sharpness: 0.25 }
};

export const pipeline = {
  adj: { ...DEFAULT_ADJ },
  fx: { ...DEFAULT_FX },
  bypass: false,
  // face crop (source-space center + scale), smoothed by the GL loop
  faceCenter: [0.5, 0.5],
  faceScale: 1,
  faceTarget: null, // [cx, cy] normalized or null
  // stats written by the pipeline
  stats: { fps: 0, decodeMs: 0, width: 0, height: 0 },
  // output
  vcamActive: false,
  recording: false
};

export function applyPreset(name) {
  const p = PRESETS[name] || {};
  pipeline.adj = { ...DEFAULT_ADJ, ...p };
  if (p.vignette !== undefined) pipeline.fx = { ...pipeline.fx, vignette: p.vignette };
  return { adj: { ...pipeline.adj }, fx: { ...pipeline.fx } };
}