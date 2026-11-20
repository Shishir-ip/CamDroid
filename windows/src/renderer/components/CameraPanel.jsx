import React from 'react';
import { Card, Slider, Toggle, Select, Segmented } from './controls.jsx';
import Icon from './icons.jsx';
import { sendSet } from '../pipeline/mjpeg.js';

export default function CameraPanel({ device, info, refreshInfo }) {
  if (!device || !info) {
    return (
      <div>
        <div className="panel-title">Phone camera</div>
        <Card><div className="hint">Connect your phone to control its camera from here.</div></Card>
      </div>
    );
  }
  const send = async (obj) => {
    await sendSet(device.host, device.port, obj);
    setTimeout(refreshInfo, 400);
  };
  const lenses = (info.lenses || []).map((l) => ({ value: l.key, label: l.label }));
  const presetOptions = [
    { value: 'sd', label: 'SD (640)' },
    { value: 'hd', label: 'HD (1280)' },
    { value: 'fhd', label: 'Full HD (1920)' },
    { value: 'qhd', label: 'QHD (2560)' },
    { value: 'uhd', label: 'UHD / 4K (3840)' }
  ];
  const zoomMin = info.zoomMin ?? 1;
  const zoomMax = info.zoomMax ?? 1;
  const expMin = info.exposureMin ?? 0;
  const expMax = info.exposureMax ?? 0;
  const mode = info.latencyMode || 'normal';
  const managed = mode !== 'normal';
  const capW = info.captureWidth ?? info.width;
  const capH = info.captureHeight ?? info.height;

  return (
    <div>
      <div className="panel-title">Phone camera</div>

      <Card title="Lens" icon={<Icon name="camera" size={14} />}>
        <Select value={info.lens || ''} options={lenses} onChange={(v) => send({ lens: v })} />
        <div className="hint">Every camera on your phone — ultra-wide, main, tele, front.</div>
        {info.torchAvailable && (
          <Toggle label="Torch / flash" checked={!!info.torchOn} onChange={(v) => send({ torch: v })} />
        )}
      </Card>

      <Card title="Optics" icon={<Icon name="focus" size={14} />}>
        {zoomMax > zoomMin && (
          <Slider
            label="Zoom" value={info.zoom ?? 1} min={zoomMin} max={zoomMax}
            display={`${(info.zoom ?? 1).toFixed(1)}×`}
            onChange={(v) => send({ zoom: v })}
          />
        )}
        {expMax > expMin && (
          <Slider
            label="Exposure compensation" value={info.exposure ?? 0} min={expMin} max={expMax} step={1}
            display={`${info.exposure > 0 ? '+' : ''}${info.exposure ?? 0}`}
            onChange={(v) => send({ exposure: Math.round(v) })}
          />
        )}
        <div className="hint">Tip: click anywhere on the video to focus there.</div>
      </Card>

      <Card title="Stream" icon={<Icon name="video" size={14} />}>
        <div className="ctl">
          <div className="ctl-head"><label>Latency mode</label></div>
          <Segmented
            value={mode}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'minimal', label: 'Minimal' },
              { value: 'auto', label: 'Auto' }
            ]}
            onChange={(v) => send({ mode: v })}
          />
        </div>
        <div className="hint">
          {mode === 'minimal' && 'Lowest latency & heat: 640×480 · 24 fps · quality 55.'}
          {mode === 'auto' && 'Normal quality; steps down when the phone heats up or battery is low.'}
          {mode === 'normal' && 'Your chosen resolution, frame rate and quality.'}
        </div>

        <div className="ctl">
          <div className="ctl-head"><label>Orientation</label></div>
          <Segmented
            value={info.orientation || 'auto'}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' }
            ]}
            onChange={(v) => send({ orientation: v })}
          />
        </div>
        <div className="hint">
          {(info.orientation || 'auto') === 'auto' && 'Follows how you hold the phone — upright gives vertical video.'}
          {info.orientation === 'portrait' && 'Output is always vertical.'}
          {info.orientation === 'landscape' && 'Output is always horizontal.'}
        </div>

        <div className="ctl">
          <div className="ctl-head"><label>Resolution</label></div>
          <Select
            value={info.preset || 'fhd'} options={presetOptions} disabled={managed}
            onChange={(v) => send({ preset: v })}
          />
        </div>
        <div className="ctl">
          <div className="ctl-head"><label>Aspect ratio</label></div>
          <Segmented
            value={info.aspect || '16:9'}
            options={[
              { value: '16:9', label: '16:9' },
              { value: '4:3', label: '4:3' }
            ]}
            onChange={(v) => send({ aspect: v })}
          />
        </div>
        <div className="hint">
          Capturing {capW}×{capH} from the phone{managed ? ' (set by ' + mode + ' mode)' : ''}.
          Orientation flips this to portrait when selected.
        </div>
        <div className="ctl">
          <div className="ctl-head"><label>Frame rate</label></div>
          <Select
            value={String(info.fpsTarget ?? 30)} disabled={managed}
            options={[15, 24, 30, 60].map((f) => ({ value: String(f), label: `${f} fps` }))}
            onChange={(v) => send({ fps: parseInt(v) })}
          />
        </div>
        <Slider
          label="JPEG quality" value={info.quality ?? 70} min={10} max={95} step={1}
          display={`${info.quality ?? 70}%`} disabled={managed}
          onChange={(v) => send({ quality: Math.round(v) })}
        />
        {managed && <div className="hint">Managed by {mode} mode — changing a value switches back to Normal.</div>}
      </Card>

      <Card title="Phone status" icon={<Icon name="phone" size={14} />}>
        <div className="kv"><span>Device</span><b>{info.model}</b></div>
        <div className="kv"><span>Android</span><b>{info.android}</b></div>
        <div className="kv"><span>Battery</span><b>{info.battery >= 0 ? `${info.battery}%${info.charging ? ' ⚡' : ''}` : '—'}</b></div>
        <div className="kv"><span>Stream</span><b>{info.width}×{info.height} @ {info.fps} fps</b></div>
        <div className="kv"><span>Bitrate</span><b>{((info.kbps ?? 0) / 1000).toFixed(1)} Mbit/s</b></div>
        <div className="kv"><span>Viewers</span><b>{info.clients}</b></div>
      </Card>
    </div>
  );
}