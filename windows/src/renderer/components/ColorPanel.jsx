import React from 'react';
import { Card, Slider, pct, signed } from './controls.jsx';
import Icon from './icons.jsx';
import { PRESETS, DEFAULT_ADJ, pipeline } from '../store.js';

export default function ColorPanel({ adj, setAdj, preset, setPreset }) {
  const set = (key) => (v) => { setAdj({ [key]: v }); setPreset('Custom'); };
  const resetAll = () => { setAdj({ ...DEFAULT_ADJ }); setPreset('Natural'); };

  return (
    <div>
      <div className="panel-title">Color studio</div>

      <Card title="Presets" icon={<Icon name="sparkles" size={14} />}>
        <div className="preset-grid">
          {Object.keys(PRESETS).map((name) => (
            <button key={name} className={preset === name ? 'active' : ''} onClick={() => setPreset(name)}>
              {name}
            </button>
          ))}
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={resetAll}><Icon name="refresh" size={13} />Reset</button>
          <button
            className="btn"
            onPointerDown={() => { pipeline.bypass = true; }}
            onPointerUp={() => { pipeline.bypass = false; }}
            onPointerLeave={() => { pipeline.bypass = false; }}
            title="Hold to see the original"
          >
            <Icon name="eye" size={13} />Hold: original
          </button>
        </div>
      </Card>

      <Card title="Light" icon={<Icon name="sun" size={14} />}>
        <Slider label="Exposure" value={adj.exposure} min={-2} max={2} display={`${signed(adj.exposure)} EV`} onChange={set('exposure')} onReset={() => set('exposure')(0)} />
        <Slider label="Brightness" value={adj.brightness} min={-1} max={1} display={pct(adj.brightness)} onChange={set('brightness')} onReset={() => set('brightness')(0)} />
        <Slider label="Contrast" value={adj.contrast} min={-1} max={1} display={pct(adj.contrast)} onChange={set('contrast')} onReset={() => set('contrast')(0)} />
        <Slider label="Highlights" value={adj.highlights} min={-1} max={1} display={pct(adj.highlights)} onChange={set('highlights')} onReset={() => set('highlights')(0)} />
        <Slider label="Shadows" value={adj.shadows} min={-1} max={1} display={pct(adj.shadows)} onChange={set('shadows')} onReset={() => set('shadows')(0)} />
        <Slider label="Whites" value={adj.whites} min={-1} max={1} display={pct(adj.whites)} onChange={set('whites')} onReset={() => set('whites')(0)} />
        <Slider label="Blacks" value={adj.blacks} min={-1} max={1} display={pct(adj.blacks)} onChange={set('blacks')} onReset={() => set('blacks')(0)} />
        <Slider label="Gamma" value={adj.gamma} min={0.5} max={2} display={adj.gamma.toFixed(2)} onChange={set('gamma')} onReset={() => set('gamma')(1)} />
      </Card>

      <Card title="Color" icon={<Icon name="droplet" size={14} />}>
        <Slider label="Temperature" value={adj.temperature} min={-1} max={1} display={pct(adj.temperature)} onChange={set('temperature')} onReset={() => set('temperature')(0)} />
        <Slider label="Tint" value={adj.tint} min={-1} max={1} display={pct(adj.tint)} onChange={set('tint')} onReset={() => set('tint')(0)} />
        <Slider label="Hue" value={adj.hue} min={-180} max={180} step={1} display={`${Math.round(adj.hue)}°`} onChange={set('hue')} onReset={() => set('hue')(0)} />
        <Slider label="Saturation" value={adj.saturation} min={-1} max={1} display={pct(adj.saturation)} onChange={set('saturation')} onReset={() => set('saturation')(0)} />
        <Slider label="Vibrance" value={adj.vibrance} min={-1} max={1} display={pct(adj.vibrance)} onChange={set('vibrance')} onReset={() => set('vibrance')(0)} />
      </Card>

      <Card title="Detail" icon={<Icon name="focus" size={14} />}>
        <Slider label="Sharpness" value={adj.sharpness} min={0} max={1} display={pct(adj.sharpness)} onChange={set('sharpness')} onReset={() => set('sharpness')(0)} />
        <div className="hint">Double-click any slider label to reset it.</div>
      </Card>
    </div>
  );
}