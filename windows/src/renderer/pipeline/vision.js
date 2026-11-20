// MediaPipe face detection (face zoom) + selfie segmentation (background blur).
// Models + wasm are bundled locally — works fully offline.
import { FaceDetector, ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';
import { pipeline } from '../store.js';

let faceDetector = null;
let segmenter = null;
let initPromise = null;
let lastFaceTs = 0;
let lastSegTs = 0;
let maskBuf = null;

export function visionReady() {
  return !!(faceDetector && segmenter);
}

export function initVision() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks('app://bundle/wasm');
    const make = async (delegate) => {
      faceDetector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: 'app://bundle/models/blaze_face_short_range.tflite', delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5
      });
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: 'app://bundle/models/selfie_segmenter.tflite', delegate },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true
      });
    };
    try {
      await make('GPU');
    } catch {
      await make('CPU');
    }
  })().catch((e) => {
    console.warn('vision init failed', e);
    initPromise = null;
  });
  return initPromise;
}

/**
 * Run vision on a fresh frame bitmap. Called from the frame loop.
 * Face detection throttled to ~8Hz; segmentation every frame when blur is on.
 */
export function processFrame(bitmap, now) {
  const fx = pipeline.fx;

  if (fx.faceZoom && faceDetector && now - lastFaceTs > 120) {
    lastFaceTs = now;
    try {
      const res = faceDetector.detectForVideo(bitmap, now);
      const det = res.detections?.[0];
      if (det?.boundingBox) {
        const b = det.boundingBox;
        const cx = (b.originX + b.width / 2) / bitmap.width;
        const cyTop = (b.originY + b.height / 2) / bitmap.height;
        pipeline.faceTarget = [cx, 1 - cyTop];
      } else {
        pipeline.faceTarget = null;
      }
    } catch {}
  } else if (!fx.faceZoom) {
    pipeline.faceTarget = null;
  }

  if (fx.blurBg && segmenter && now - lastSegTs > 30) {
    lastSegTs = now;
    try {
      const res = segmenter.segmentForVideo(bitmap, now);
      const mask = res.confidenceMasks?.[0];
      if (mask) {
        const f32 = mask.getAsFloat32Array();
        const w = mask.width;
        const h = mask.height;
        if (!maskBuf || maskBuf.length !== w * h) maskBuf = new Uint8Array(w * h);
        for (let i = 0; i < f32.length; i++) {
          maskBuf[i] = Math.max(0, Math.min(255, (f32[i] * 255) | 0));
        }
        const out = { bytes: maskBuf, w, h };
        mask.close();
        return out;
      }
    } catch {}
  }
  return null;
}