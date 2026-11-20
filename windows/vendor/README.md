# Vendored runtime binaries

These binaries are committed so a fresh clone can build a working Windows
installer without extra downloads. Each component's license and origin:

| Path | Component | License | Origin |
| --- | --- | --- | --- |
| `adb/` | Android Debug Bridge (platform-tools) | Apache-2.0 | https://developer.android.com/tools/releases/platform-tools |
| `models/blaze_face_short_range.tflite` | MediaPipe BlazeFace (short-range) | Apache-2.0 | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite |
| `models/selfie_segmenter.tflite` | MediaPipe Selfie Segmenter | Apache-2.0 | https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite |
| `softcam/x64/softcam.dll`, `softcam/Win32/softcam.dll` | softcam DirectShow virtual camera (Windows 10 / legacy fallback) | MIT | https://github.com/tshino/softcam |
| `vcam/x64/CamDroidVCam.dll`, `vcam/Win32/CamDroidVCam.dll` | CamDroid Media Foundation virtual camera (Windows 11) | MIT | Built from `windows/native/vcam/` (derived from the MIT-licensed Microsoft Windows-Camera VirtualCamera sample) |

The MediaPipe WASM runtime is not vendored here; it is restored by `npm install`
(`@mediapipe/tasks-vision`, Apache-2.0) and copied into the renderer bundle by
`build.mjs`.

To rebuild the CamDroid virtual-camera DLLs from source (requires VS 2022 C++
Build Tools and the Windows 11 SDK):

```bat
cd windows\native\vcam
build.bat all
```

Outputs land in `windows\vendor\vcam\{x64,Win32}\`.