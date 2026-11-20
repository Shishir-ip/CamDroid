// Virtual webcam output.
//
// Primary: Windows 11 Media Foundation virtual camera (CamDroidVCam.dll,
// adapted from Microsoft's Windows-Camera sample, MIT). It appears as
// "CamDroid" in ALL modern apps (Windows Camera, Chrome, Edge, Teams, Zoom,
// OBS, Discord...) because they enumerate Media Foundation cameras.
// Frames are pushed into a shared-memory mapping read by the media source —
// no per-frame IPC copies.
//
// Fallback: MIT-licensed softcam DirectShow filter ("DirectShow Softcam")
// for legacy DirectShow-only apps and Windows 10 (no MF virtual camera API).
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const MF_CLSID = '{7B3E9A21-C4D5-4F6E-8A1B-2C9D0E5F7A3B}';
const SC_CLSID = '{AEF3B972-5FA5-4647-9571-358EB472BC9E}';

let appRef = null;
let koffi = null;

// MF backend
let mfLib = null;
let mfCreate = null;
let mfDestroy = null;
let mfIsActive = null;
let mfWrite = null;
let mfCloseFrame = null;
let mfUnavailable = false; // API missing (Windows 10) or DLL load failure

// softcam backend
let scLib = null;
let scCreate = null;
let scDelete = null;
let scSend = null;
let scIsConnected = null;
let scCam = null;
let scBuf = null;

let backend = null; // 'mf' | 'softcam'
let frameW = 0;
let frameH = 0;
let lastError = null;

function vendorDir() {
  return appRef && appRef.isPackaged
    ? path.join(process.resourcesPath, 'vendor')
    : path.join(__dirname, '..', '..', 'vendor');
}
// The Frame Server service (LocalService) loads the registered media source DLL.
// It cannot read the per-user app folder, so the DLL is deployed to an
// all-users-readable location and THAT path is registered.
const DEPLOY_DIR = 'C:\\ProgramData\\CamDroid';
const mfSrc64 = () => path.join(vendorDir(), 'vcam', 'x64', 'CamDroidVCam.dll');
const mfSrc32 = () => path.join(vendorDir(), 'vcam', 'Win32', 'CamDroidVCam.dll');
const mfDll64 = () => path.join(DEPLOY_DIR, 'CamDroidVCam.dll');
const mfDll32 = () => path.join(DEPLOY_DIR, 'CamDroidVCam32.dll');
const scDll64 = () => path.join(vendorDir(), 'softcam', 'x64', 'softcam.dll');
const scDll32 = () => path.join(vendorDir(), 'softcam', 'Win32', 'softcam.dll');

// Copy the media source DLLs to the service-readable deploy dir. If a DLL is
// locked by the Frame Server, keep the existing deployed copy (still functional).
function deployMf() {
  try { fs.mkdirSync(DEPLOY_DIR, { recursive: true }); } catch {}
  const pairs = [[mfSrc64(), mfDll64()], [mfSrc32(), mfDll32()]];
  for (const [src, dst] of pairs) {
    try {
      if (!fs.existsSync(src)) continue;
      const s = fs.statSync(src);
      const d = fs.existsSync(dst) ? fs.statSync(dst) : null;
      if (d && d.size === s.size && d.mtimeMs >= s.mtimeMs) continue; // up to date
      fs.copyFileSync(src, dst);
    } catch {}
  }
  return fs.existsSync(mfDll64());
}

function regQuery(key) {
  const r = spawnSync('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 5000 });
  return r.status === 0;
}
function regValue(key) {
  const r = spawnSync('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = (r.stdout || '').match(/REG_SZ\s+(.+)/);
  return m ? m[1].trim() : null;
}
const mfRegKey = `HKCR\\CLSID\\${MF_CLSID}\\InprocServer32`;
const mfRegistered = () => regQuery(mfRegKey);
// Registration must point at the service-readable deployed DLL, not an old path.
const mfRegistrationOk = () => {
  const p = regValue(mfRegKey);
  return !!p && p.toLowerCase() === mfDll64().toLowerCase();
};
const scRegistered64 = () => regQuery(`HKCR\\CLSID\\${SC_CLSID}\\InprocServer32`);
const scRegistered32 = () => regQuery(`HKCR\\WOW6432Node\\CLSID\\${SC_CLSID}\\InprocServer32`);

// One UAC prompt registers every missing DLL (MF + softcam, both architectures).
function registerAllElevated() {
  const jobs = [];
  if (fs.existsSync(mfDll64()) && !mfRegistrationOk()) jobs.push(['regsvr32.exe', mfDll64()]);
  if (fs.existsSync(mfDll32())) jobs.push(['C:\\Windows\\SysWOW64\\regsvr32.exe', mfDll32()]);
  if (fs.existsSync(scDll64()) && !scRegistered64()) jobs.push(['regsvr32.exe', scDll64()]);
  if (fs.existsSync(scDll32()) && !scRegistered32()) jobs.push(['C:\\Windows\\SysWOW64\\regsvr32.exe', scDll32()]);
  if (jobs.length === 0) return true;
  const q = (v) => v.replace(/'/g, "''");
  // Inner script runs elevated; each regsvr32 is silent. Fail fast on first error.
  const inner = jobs.map(([exe, dll]) =>
    `& '${q(exe)}' /s '${q(dll)}'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`).join('; ');
  const ps = `$p = Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-Command','${q(inner)}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 120000 });
  return r.status === 0;
}

function loadMf() {
  if (mfLib) return true;
  if (mfUnavailable) return false;
  deployMf();
  if (!fs.existsSync(mfDll64())) { mfUnavailable = true; return false; }
  try {
    koffi = koffi || require('koffi');
    mfLib = koffi.load(mfDll64());
    mfCreate = mfLib.func('int __cdecl CdVcamCreate(const wchar_t* friendlyName)');
    mfDestroy = mfLib.func('void __cdecl CdVcamDestroy()');
    mfIsActive = mfLib.func('int __cdecl CdVcamIsActive()');
    mfWrite = mfLib.func('int __cdecl CdVcamWriteFrame(const void* rgba, uint32_t width, uint32_t height)');
    mfCloseFrame = mfLib.func('void __cdecl CdVcamCloseFrame()');
    return true;
  } catch (e) {
    lastError = 'Failed to load CamDroid virtual camera: ' + e.message;
    mfLib = null;
    mfUnavailable = true;
    return false;
  }
}

function loadSc() {
  if (scLib) return true;
  if (!fs.existsSync(scDll64())) return false;
  try {
    koffi = koffi || require('koffi');
    scLib = koffi.load(scDll64());
    scCreate = scLib.func('void* __cdecl scCreateCamera(int width, int height, float framerate)');
    scDelete = scLib.func('void __cdecl scDeleteCamera(void* camera)');
    scSend = scLib.func('void __cdecl scSendFrame(void* camera, const void* image_bits)');
    scIsConnected = scLib.func('bool __cdecl scIsConnected(void* camera)');
    return true;
  } catch (e) {
    lastError = 'Failed to load softcam: ' + e.message;
    scLib = null;
    return false;
  }
}

function init(app) {
  appRef = app;
}

function status() {
  const mfActive = backend === 'mf' && mfIsActive ? !!mfIsActive() : false;
  return {
    available: fs.existsSync(mfSrc64()) || fs.existsSync(scDll64()),
    registered: mfRegistrationOk() || scRegistered64(),
    backend,
    active: mfActive || !!scCam,
    connected: scCam ? !!scIsConnected(scCam) : false,
    width: frameW,
    height: frameH,
    error: lastError
  };
}

const clampDim = (value, fallback, max) => Number.isFinite(value)
  ? Math.max(64, Math.min(max, Math.round(value / 2) * 2)) : fallback;

function enable(opts) {
  lastError = null;
  if (backend) return status();
  const w = clampDim(opts?.width, 1280, 3840);
  const h = clampDim(opts?.height, 720, 2160);

  // ---- Primary: Media Foundation virtual camera (Windows 11) ----
  if (loadMf()) {
    if (!mfRegistrationOk()) {
      registerAllElevated();
      if (!mfRegistrationOk()) {
        lastError = 'Virtual camera registration was cancelled or failed (admin required).';
        return status();
      }
    }
    let hr;
    try { hr = mfCreate('CamDroid'); } catch (e) { hr = -1; lastError = e.message; }
    if (hr === 0) {
      backend = 'mf';
      frameW = w;
      frameH = h;
      return status();
    }
    // 0x8007007F = ERROR_PROC_NOT_FOUND: MFCreateVirtualCamera absent (Win10).
    if (hr !== -2147024769) {
      lastError = `Virtual camera could not start (0x${(hr >>> 0).toString(16)}).`;
    }
    try { mfDestroy(); } catch {}
  }

  // ---- Fallback: softcam DirectShow filter ----
  if (!fs.existsSync(scDll64())) {
    lastError = lastError || 'No virtual camera backend available. Reinstall CamDroid.';
    return status();
  }
  if (!scRegistered64()) {
    registerAllElevated();
    if (!scRegistered64()) {
      lastError = 'Virtual camera registration was cancelled or failed (admin required).';
      return status();
    }
  }
  if (!loadSc()) return status();
  try {
    scCam = scCreate(w, h, 0);
  } catch (e) {
    lastError = e.message;
    scCam = null;
  }
  if (!scCam) {
    lastError = lastError || 'Could not create the virtual camera (another app may be using it).';
    return status();
  }
  backend = 'softcam';
  frameW = w;
  frameH = h;
  scBuf = Buffer.alloc(w * h * 3);
  return status();
}

function disable() {
  if (backend === 'mf') {
    try { mfCloseFrame(); } catch {}
    try { mfDestroy(); } catch {}
  }
  if (scCam && scDelete) {
    try { scDelete(scCam); } catch {}
  }
  scCam = null;
  scBuf = null;
  backend = null;
  frameW = 0;
  frameH = 0;
  return status();
}

function sendFrame(payload) {
  if (!backend || !payload) return;
  const { data, width, height } = payload;
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return;
  if (width < 2 || height < 2 || width > 3840 || height > 2160) return;

  if (backend === 'mf') {
    // RGBA goes straight into shared memory; the media source reads it.
    try {
      if (mfWrite(data, width, height)) {
        frameW = width;
        frameH = height;
      }
    } catch {}
    return;
  }

  // softcam: BGR24 top-down, fixed size.
  if (!scCam || width !== frameW || height !== frameH) return;
  const rgba = data instanceof ArrayBuffer ? Buffer.from(data)
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (rgba.length !== width * height * 4) return;
  const out = scBuf;
  const n = width * height;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const k = i * 4;
    out[j] = rgba[k + 2];
    out[j + 1] = rgba[k + 1];
    out[j + 2] = rgba[k];
  }
  try { scSend(scCam, out); } catch {}
}

function shutdown() {
  disable();
}

module.exports = { init, status, enable, disable, sendFrame, shutdown };