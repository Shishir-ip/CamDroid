import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Icon from './components/icons.jsx';
import ColorPanel from './components/ColorPanel.jsx';
import EffectsPanel from './components/EffectsPanel.jsx';
import CameraPanel from './components/CameraPanel.jsx';
import OutputPanel from './components/OutputPanel.jsx';
import ConnectPanel from './components/ConnectPanel.jsx';
import { GlPipeline } from './pipeline/gl.js';
import { startStream, fetchInfo, sendSet } from './pipeline/mjpeg.js';
import { initVision, processFrame } from './pipeline/vision.js';
import { pipeline, DEFAULT_ADJ, DEFAULT_FX, applyPreset } from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABS = [
  { id: 'color', label: 'Color', icon: 'sliders' },
  { id: 'effects', label: 'Effects', icon: 'layers' },
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'output', label: 'Output', icon: 'monitor' },
  { id: 'connect', label: 'Link', icon: 'wifi' }
];

export default function App() {
  const [settings, setSettings] = useState(null);
  const [theme, setTheme] = useState('dark');
  const [tab, setTab] = useState('color');
  const [devices, setDevices] = useState([]);
  const [current, setCurrent] = useState(null);
  const [status, setStatus] = useState('scanning'); // scanning | connecting | live | reconnecting
  const [info, setInfo] = useState(null);
  const [adb, setAdb] = useState({ devices: [] });
  const [adj, setAdjState] = useState({ ...DEFAULT_ADJ });
  const [fx, setFxState] = useState({ ...DEFAULT_FX });
  const [preset, setPresetState] = useState('Natural');
  const [vcam, setVcam] = useState({ active: false, registered: false, connected: false, available: true });
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [toast, setToast] = useState(null);
  const [stats, setStats] = useState({ fps: 0, decodeMs: 0 });

  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const glRef = useRef(null);
  const busyRef = useRef(false);
  const currentRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const camFramesRef = useRef(0);
  const toastTimer = useRef(null);

  currentRef.current = current;

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // ---------------------------------------------------------------- settings & devices

  useEffect(() => {
    window.camdroid.getSettings().then((s) => {
      setSettings(s);
      setTheme(s.theme || 'dark');
      setAutoStart(!!s.autoStart);
    });
    const off = window.camdroid.onDevices((list) => setDevices(list));
    window.camdroid.adbStatus().then(setAdb);
    const adbTimer = setInterval(() => window.camdroid.adbStatus().then(setAdb), 6000);
    initVision();
    return () => { off(); clearInterval(adbTimer); };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const patchSettings = (patch) => window.camdroid.setSettings(patch);

  // ---------------------------------------------------------------- connection

  const connect = useCallback(async (device) => {
    setStatus('connecting');
    try {
      const inf = await fetchInfo(device.host, device.port);
      if (inf.app !== 'CamDroid') throw new Error('not CamDroid');
      setCurrent(device);
      setInfo(inf);
      patchSettings({ lastDevice: device.id });
    } catch {
      showToast('Could not reach that device');
      setStatus('scanning');
    }
  }, [showToast]);

  const disconnect = useCallback(() => {
    setCurrent(null);
    setInfo(null);
    setStatus('scanning');
  }, []);

  // auto-connect: prefer last used device, else first discovered
  useEffect(() => {
    if (!settings || !settings.autoConnect || current || devices.length === 0) return;
    const last = devices.find((d) => d.id === settings.lastDevice);
    connect(last || devices[0]);
  }, [devices, settings, current, connect]);

  // ---------------------------------------------------------------- frame handling

  const handleFrame = useCallback(async (jpeg) => {
    if (busyRef.current) return; // drop frames rather than build latency
    busyRef.current = true;
    const t0 = performance.now();
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      const gl = glRef.current;
      const canvas = canvasRef.current;
      if (gl && canvas) {
        const mask = processFrame(bmp, t0);
        gl.setFrame(bmp);
        if (mask) gl.setMask(mask.bytes, mask.w, mask.h);
        pipeline.stats.width = bmp.width;
        pipeline.stats.height = bmp.height;
        // Virtual camera: push THIS frame immediately (frame-driven, no extra
        // timer delay). The canvas is the output buffer at source resolution.
        if (pipeline.vcamActive) {
          const sw = Math.min(3840, bmp.width);
          const sh = Math.min(2160, bmp.height);
          if (sw >= 64 && sh >= 64 && (canvas.width !== sw || canvas.height !== sh)) {
            canvas.width = sw;
            canvas.height = sh;
          }
          gl.readFlip = false;
          gl.render();
          const rgba = gl.readRgba();
          window.camdroid.vcamFrame({ data: rgba.buffer, width: canvas.width, height: canvas.height });
          camFramesRef.current++;
        }
      }
      bmp.close();
      pipeline.stats.decodeMs = Math.round(performance.now() - t0);
    } catch {}
    busyRef.current = false;
  }, []);

  const handleFrameRef = useRef(handleFrame);
  handleFrameRef.current = handleFrame;

  useEffect(() => {
    if (!current) return;
    const ctrl = new AbortController();
    let cancelled = false;
    let delayMs = 800;
    (async () => {
      while (!cancelled) {
        try {
          await startStream(`http://${current.host}:${current.port}/stream`, {
            onOpen: () => { setStatus('live'); delayMs = 800; },
            onFrame: (j) => handleFrameRef.current(j)
          }, ctrl.signal);
        } catch {}
        if (cancelled) break;
        setStatus('reconnecting');
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 5000);
      }
    })();
    return () => { cancelled = true; ctrl.abort(); };
  }, [current?.id, current?.host, current?.port]);

  // Refresh the endpoint when discovery sees the same device at a new address.
  useEffect(() => {
    const updated = devices.find((d) => d.id === current?.id);
    if (updated && (updated.host !== current.host || updated.port !== current.port)) setCurrent(updated);
  }, [devices, current]);

  // phone info polling
  const refreshInfo = useCallback(async () => {
    const d = currentRef.current;
    if (!d) return;
    try { setInfo(await fetchInfo(d.host, d.port)); } catch {}
  }, []);

  useEffect(() => {
    if (!current) return;
    const t = setInterval(refreshInfo, 3000);
    return () => clearInterval(t);
  }, [current?.id, refreshInfo]);

  // ---------------------------------------------------------------- GL + render loop

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gl;
    try { gl = new GlPipeline(canvas); } catch (e) { showToast(e.message); return; }
    glRef.current = gl;

    let raf = 0;
    let timer = 0;
    let stopped = false;
    let frameCount = 0;
    let lastStat = performance.now();

    const tick = () => {
      if (stopped) return;
      const g = glRef.current;
      if (g) {
        if (!pipeline.vcamActive) {
          // Preview mode: animate effects (face-zoom smoothing, grain) at display rate.
          g.readFlip = false;
          g.render();
          frameCount++;
        } else {
          // Virtual-camera mode: frames are rendered + pushed in handleFrame.
          frameCount += camFramesRef.current;
          camFramesRef.current = 0;
        }
      }
      const now = performance.now();
      if (now - lastStat >= 1000) {
        pipeline.stats.fps = frameCount;
        setStats({ fps: frameCount, decodeMs: pipeline.stats.decodeMs });
        frameCount = 0;
        lastStat = now;
      }
      schedule();
    };

    // requestAnimationFrame is paused by Chromium when the window is hidden, so
    // fall back to a timer when hidden. Background throttling is disabled in the
    // main process, so the timer keeps firing and the virtual camera stays live.
    const schedule = () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') raf = requestAnimationFrame(tick);
      else timer = setTimeout(tick, 33);
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Recover from GPU context loss instead of freezing.
    const onLost = (e) => { e.preventDefault(); glRef.current = null; };
    const onRestored = () => {
      try { glRef.current = new GlPipeline(canvas); } catch (e) { showToast(e.message); }
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    schedule();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      glRef.current = null;
    };
  }, [showToast]);

  // canvas sizing
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const apply = () => {
      if (pipeline.vcamActive) {
        const sw = Math.min(3840, pipeline.stats.width || 1280);
        const sh = Math.min(2160, pipeline.stats.height || 720);
        canvas.width = sw;
        canvas.height = sh;
      } else {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const r = wrap.getBoundingClientRect();
        canvas.width = Math.max(320, Math.min(2560, Math.round(r.width * dpr)));
        canvas.height = Math.max(180, Math.min(1440, Math.round(r.height * dpr)));
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [vcam.active]);

  // ---------------------------------------------------------------- state sync helpers

  const setAdj = (patch) => {
    pipeline.adj = { ...pipeline.adj, ...patch };
    setAdjState({ ...pipeline.adj });
  };
  const setFx = (patch) => {
    pipeline.fx = { ...pipeline.fx, ...patch };
    setFxState({ ...pipeline.fx });
  };
  const setPreset = (name) => {
    if (name === 'Custom') { setPresetState('Custom'); return; }
    const { adj: a, fx: f } = applyPreset(name);
    setAdjState(a);
    setFxState(f);
    setPresetState(name);
  };

  // ---------------------------------------------------------------- virtual camera

  const refreshVcam = useCallback(async () => {
    const s = await window.camdroid.vcamStatus();
    setVcam(s);
    pipeline.vcamActive = s.active;
    return s;
  }, []);

  useEffect(() => {
    refreshVcam();
    const t = setInterval(refreshVcam, 2500);
    return () => clearInterval(t);
  }, [refreshVcam]);

  const onVcamToggle = async (on) => {
    if (on) {
      const canvas = canvasRef.current;
      const w = canvas?.width || 1280;
      const h = canvas?.height || 720;
      showToast('Enabling virtual camera… (admin prompt may appear)');
      const s = await window.camdroid.vcamEnable({ width: w, height: h, fps: 30 });
      setVcam(s);
      pipeline.vcamActive = s.active;
      if (s.active) {
        showToast(s.backend === 'mf'
          ? 'Virtual camera is live — pick “CamDroid” in your app'
          : 'Virtual camera is live — pick “DirectShow Softcam” in your app');
      } else if (s.error) {
        showToast(s.error);
      }
    } else {
      const s = await window.camdroid.vcamDisable();
      setVcam(s);
      pipeline.vcamActive = false;
    }
  };

  // ---------------------------------------------------------------- recording / snapshot

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const onRecordToggle = () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || status !== 'live') { showToast('Connect your phone first'); return; }
    try {
      const stream = canvas.captureStream(30);
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const data = await blob.arrayBuffer();
        const name = `CamDroid_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`;
        const res = await window.camdroid.saveFile({ name, data, filters: [{ name: 'WebM video', extensions: ['webm'] }] });
        if (res.ok) showToast('Recording saved');
      };
      rec.start(1000);
      recorderRef.current = rec;
      setRecSeconds(0);
      setRecording(true);
    } catch (e) {
      showToast('Recording failed: ' + e.message);
    }
  };

  const onSnapshot = async () => {
    const canvas = canvasRef.current;
    if (!canvas || status !== 'live') { showToast('Connect your phone first'); return; }
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const data = await blob.arrayBuffer();
    const name = `CamDroid_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    const res = await window.camdroid.saveFile({ name, data, filters: [{ name: 'PNG image', extensions: ['png'] }] });
    if (res.ok) showToast('Snapshot saved');
  };

  // ---------------------------------------------------------------- misc UI handlers

  const onVideoClick = (e) => {
    const d = currentRef.current;
    if (!d || status !== 'live') return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    sendSet(d.host, d.port, { focus: { x, y } });
    showToast('Focusing…');
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    patchSettings({ theme: next });
  };

  const togglePin = async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(await window.camdroid.setAlwaysOnTop(next));
  };

  const onAutoStart = async (on) => setAutoStart(await window.camdroid.setAutoStart(on));
  const onAutoConnect = (on) => patchSettings({ autoConnect: on }).then((s) => setSettings(s));

  const live = status === 'live';
  const pillText = live
    ? `${current?.name || 'Phone'} · ${current?.transport === 'usb' ? 'USB' : 'Wi-Fi'}`
    : status === 'connecting' ? 'Connecting…'
    : status === 'reconnecting' ? 'Reconnecting…'
    : 'Looking for your phone…';

  // ---------------------------------------------------------------- render

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo">
          <span className="logo-mark"><Icon name="aperture" size={16} /></span>
          CamDroid
        </div>
        <div className={'device-pill' + (live ? ' live' : '')}>
          <span className="dot" />
          {live && <Icon name={current?.transport === 'usb' ? 'usb' : 'wifi'} size={13} />}
          {pillText}
        </div>
        <div className="spacer" />
        <button className="icon-btn" title="Toggle theme" onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <button className={'icon-btn' + (alwaysOnTop ? ' on' : '')} title="Always on top" onClick={togglePin}>
          <Icon name="pin" size={16} />
        </button>
        <button className="icon-btn" title="Minimize" onClick={() => window.camdroid.minimize()}>
          <Icon name="minimize" size={16} />
        </button>
      </div>

      <div className="main">
        <div className="stage">
          <div className="video-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} onClick={onVideoClick} />
            {fx.grid && live && (
              <div className="grid-overlay">
                <div className="gl" style={{ left: '33.3%', top: 0, bottom: 0, width: 1 }} />
                <div className="gl" style={{ left: '66.6%', top: 0, bottom: 0, width: 1 }} />
                <div className="gl" style={{ top: '33.3%', left: 0, right: 0, height: 1 }} />
                <div className="gl" style={{ top: '66.6%', left: 0, right: 0, height: 1 }} />
              </div>
            )}
            {live && (
              <>
                <div className="video-overlay-tl">
                  <span className="chip">{pipeline.stats.width}×{pipeline.stats.height}</span>
                  <span className="chip">{stats.fps} fps</span>
                  {fx.faceZoom && <span className="chip"><Icon name="face" size={12} />face zoom</span>}
                  {fx.blurBg && <span className="chip"><Icon name="droplet" size={12} />blur</span>}
                </div>
                {recording && (
                  <div className="video-overlay-tr">
                    <span className="chip rec"><span className="rec-dot" />REC {String(Math.floor(recSeconds / 60)).padStart(2, '0')}:{String(recSeconds % 60).padStart(2, '0')}</span>
                  </div>
                )}
              </>
            )}
            <AnimatePresence>
              {!live && (
                <motion.div
                  className="empty-state"
                  style={{ position: 'absolute' }}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 26 }}
                >
                  <div className="radar"><Icon name="phone" size={30} /></div>
                  <h2>{status === 'reconnecting' ? 'Reconnecting to your phone' : 'Looking for your phone'}</h2>
                  <p>CamDroid connects automatically over Wi-Fi or USB — no pairing codes.</p>
                  <div className="steps">
                    <div><b>1.</b> Install & open CamDroid on your Android phone</div>
                    <div><b>2.</b> Same Wi-Fi network, or plug in USB (USB debugging on)</div>
                    <div><b>3.</b> It appears here and connects instantly</div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="sidebar">
          <div className="tabrail">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={17} />
                {t.label}
              </button>
            ))}
          </div>
          <div className="panel">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, x: 14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -14 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              >
                {tab === 'color' && <ColorPanel adj={adj} setAdj={setAdj} preset={preset} setPreset={setPreset} />}
                {tab === 'effects' && <EffectsPanel fx={fx} setFx={setFx} />}
                {tab === 'camera' && <CameraPanel device={current} info={info} refreshInfo={refreshInfo} />}
                {tab === 'output' && (
                  <OutputPanel
                    vcam={vcam} onVcamToggle={onVcamToggle}
                    recording={recording} recSeconds={recSeconds}
                    onRecordToggle={onRecordToggle} onSnapshot={onSnapshot}
                    alwaysOnTop={alwaysOnTop} setAlwaysOnTop={togglePin}
                    autoStart={autoStart} setAutoStart={onAutoStart}
                  />
                )}
                {tab === 'connect' && (
                  <ConnectPanel
                    devices={devices} current={current} status={status}
                    onConnect={connect} onDisconnect={disconnect}
                    autoConnect={settings?.autoConnect ?? true} setAutoConnect={onAutoConnect}
                    onRefresh={() => window.camdroid.refreshDevices()}
                    adb={adb}
                    onManual={(ip, port) => connect({ id: `manual:${ip}:${port}`, name: ip, host: ip, port, transport: 'wifi' })}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="statusbar">
        <span><b>{stats.fps}</b> fps</span>
        <span><b>{pipeline.stats.width}×{pipeline.stats.height}</b></span>
        <span>decode <b>{stats.decodeMs} ms</b></span>
        <span>phone <b>{((info?.kbps ?? 0) / 1000).toFixed(1)} Mbit/s</b></span>
        <span>viewers <b>{info?.clients ?? 0}</b></span>
        {vcam.active && <span style={{ color: 'var(--live)' }}>virtual cam {vcam.connected ? '· in use' : '· ready'}</span>}
        <div className="spacer" />
        <span>Designed & built by <b>Shishir</b></span>
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}