import React from 'react';
import { Card, Toggle } from './controls.jsx';
import Icon from './icons.jsx';

export default function OutputPanel({
  vcam, onVcamToggle,
  recording, recSeconds, onRecordToggle, onSnapshot,
  alwaysOnTop, setAlwaysOnTop, autoStart, setAutoStart
}) {
  const mm = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const ss = String(recSeconds % 60).padStart(2, '0');
  const isMf = vcam.backend === 'mf';

  return (
    <div>
      <div className="panel-title">Output</div>

      <Card title="Virtual webcam" icon={<Icon name="monitor" size={14} />}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span className={'badge ' + (vcam.active ? (vcam.connected ? 'ok' : 'warn') : 'off')}>
            {vcam.active ? (vcam.connected ? 'In use by an app' : 'Live') : 'Off'}
          </span>
          {vcam.registered && <span className="badge ok">Installed</span>}
        </div>
        <Toggle
          label="Enable virtual camera"
          sub={isMf ? 'Shows up as “CamDroid” in other apps' : 'Shows up as “DirectShow Softcam” in other apps'}
          checked={vcam.active}
          onChange={onVcamToggle}
        />
        {vcam.error && <div className="hint" style={{ color: 'var(--danger)' }}>{vcam.error}</div>}
        <div className="hint">
          {isMf ? (
            <>Select <b>CamDroid</b> as the camera in Zoom, Teams, Discord, OBS, Chrome, Windows Camera, etc.
            The output size follows your phone stream automatically. First enable asks for admin rights
            (one-time registration).</>
          ) : (
            <>Select <b>DirectShow Softcam</b> as the camera in legacy apps. This fallback is used on
            Windows 10, where the modern “CamDroid” camera API is unavailable. First enable asks for
            admin rights (one-time registration).</>
          )}
        </div>
      </Card>

      <Card title="Capture" icon={<Icon name="video" size={14} />}>
        <div className="btn-row">
          <button className={'btn ' + (recording ? 'danger' : 'primary')} onClick={onRecordToggle}>
            <Icon name={recording ? 'stop' : 'circle'} size={13} />
            {recording ? `Stop ${mm}:${ss}` : 'Record'}
          </button>
          <button className="btn" onClick={onSnapshot}>
            <Icon name="camera" size={13} />Snapshot
          </button>
        </div>
        <div className="hint">Records the processed video (all effects included) as WebM. Snapshots save as PNG.</div>
      </Card>

      <Card title="Window" icon={<Icon name="pin" size={14} />}>
        <Toggle label="Always on top" checked={alwaysOnTop} onChange={setAlwaysOnTop} />
        <Toggle label="Launch at Windows startup" sub="Starts minimized, auto-connects" checked={autoStart} onChange={setAutoStart} />
      </Card>
    </div>
  );
}