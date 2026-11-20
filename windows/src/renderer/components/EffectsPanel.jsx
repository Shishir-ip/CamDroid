import React from 'react';
import { Card, Slider, Toggle, Segmented, pct } from './controls.jsx';
import Icon from './icons.jsx';

export default function EffectsPanel({ fx, setFx }) {
  const set = (key) => (v) => setFx({ [key]: v });
  return (
    <div>
      <div className="panel-title">Effects</div>

      <Card title="Background blur" icon={<Icon name="droplet" size={14} />}>
        <Toggle
          label="Blur background"
          sub="AI person segmentation — keeps you sharp"
          checked={fx.blurBg}
          onChange={set('blurBg')}
        />
        {fx.blurBg && (
          <Slider label="Blur strength" value={fx.blurAmount} min={0} max={100} step={1} display={`${fx.blurAmount}%`} onChange={set('blurAmount')} onReset={() => set('blurAmount')(50)} />
        )}
        <div className="hint">Runs on your GPU. Works best with even lighting.</div>
      </Card>

      <Card title="Face zoom" icon={<Icon name="face" size={14} />}>
        <Toggle
          label="Auto face zoom"
          sub="Detects your face and keeps it framed"
          checked={fx.faceZoom}
          onChange={set('faceZoom')}
        />
        {fx.faceZoom && (
          <>
            <Slider label="Zoom level" value={fx.faceZoomLevel} min={1} max={3} display={`${fx.faceZoomLevel.toFixed(1)}×`} onChange={set('faceZoomLevel')} onReset={() => set('faceZoomLevel')(1.6)} />
            <Slider label="Smoothing" value={fx.faceSmooth} min={0} max={100} step={1} display={`${fx.faceSmooth}%`} onChange={set('faceSmooth')} onReset={() => set('faceSmooth')(60)} />
          </>
        )}
        <div className="hint">The crop glides smoothly — no jitter when you move.</div>
      </Card>

      <Card title="Framing" icon={<Icon name="grid" size={14} />}>
        <Toggle label="Mirror" sub="Flip horizontally" checked={fx.mirror} onChange={set('mirror')} />
        <div className="ctl">
          <div className="ctl-head"><label>Rotation</label><span className="val">{fx.rotate * 90}°</span></div>
          <Segmented
            value={String(fx.rotate)}
            options={[
              { value: '0', label: '0°' },
              { value: '1', label: '90°' },
              { value: '2', label: '180°' },
              { value: '3', label: '270°' }
            ]}
            onChange={(v) => set('rotate')(parseInt(v))}
          />
        </div>
        <Toggle label="Rule-of-thirds grid" checked={fx.grid} onChange={set('grid')} />
        <div className="hint">Use 90° / 270° for portrait (vertical) video.</div>
      </Card>

      <Card title="Film look" icon={<Icon name="sparkles" size={14} />}>
        <Slider label="Vignette" value={fx.vignette} min={0} max={1} display={pct(fx.vignette)} onChange={set('vignette')} onReset={() => set('vignette')(0)} />
        <Slider label="Grain" value={fx.grain} min={0} max={1} display={pct(fx.grain)} onChange={set('grain')} onReset={() => set('grain')(0)} />
      </Card>
    </div>
  );
}