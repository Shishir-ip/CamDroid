import React, { useState } from 'react';
import { Card, Toggle } from './controls.jsx';
import Icon from './icons.jsx';

export default function ConnectPanel({
  devices, current, status, onConnect, onDisconnect,
  autoConnect, setAutoConnect, onRefresh, adb, onManual
}) {
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('8765');

  return (
    <div>
      <div className="panel-title">Connection</div>

      <Card title="Devices" icon={<Icon name="phone" size={14} />}>
        {devices.length === 0 && (
          <div className="hint" style={{ marginBottom: 8 }}>
            No phone found yet. Open CamDroid on your phone (same Wi-Fi) or plug in USB.
          </div>
        )}
        {devices.map((d) => {
          const connected = current?.id === d.id && status === 'live';
          return (
            <div key={d.id} className={'device-item' + (connected ? ' connected' : '')}>
              <span className="d-icon"><Icon name={d.transport === 'usb' ? 'usb' : 'wifi'} size={17} /></span>
              <div className="d-info">
                <div className="d-name">{d.name}</div>
                <div className="d-sub">{d.transport === 'usb' ? 'USB' : 'Wi-Fi'} · {d.host}:{d.port}</div>
              </div>
              {connected
                ? <button className="btn" onClick={onDisconnect}>Disconnect</button>
                : <button className="btn primary" onClick={() => onConnect(d)}>Connect</button>}
            </div>
          );
        })}
        <div className="btn-row" style={{ marginTop: 4 }}>
          <button className="btn" onClick={onRefresh}><Icon name="refresh" size={13} />Rescan</button>
        </div>
        <Toggle label="Auto-connect" sub="Reconnect automatically whenever the phone appears" checked={autoConnect} onChange={setAutoConnect} />
      </Card>

      <Card title="Manual connect" icon={<Icon name="link" size={14} />}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="text-input" placeholder="Phone IP (e.g. 192.168.1.42)" value={ip} onChange={(e) => setIp(e.target.value)} />
          <input className="text-input" style={{ width: 80 }} value={port} onChange={(e) => setPort(e.target.value)} />
        </div>
        <button
          className="btn block" style={{ marginTop: 8 }}
          disabled={!ip.trim()}
          onClick={() => onManual(ip.trim(), parseInt(port) || 8765)}
        >
          Connect
        </button>
        <div className="hint">The phone app shows its IP and a QR code on the main screen.</div>
      </Card>

      <Card title="USB (adb)" icon={<Icon name="usb" size={14} />}>
        <div className="kv"><span>adb devices</span><b>{adb.devices.length ? adb.devices.join(', ') : 'none'}</b></div>
        <div className="hint">
          USB gives the lowest latency and charges the phone. Enable <b>USB debugging</b> on the phone
          (Developer options) and accept the RSA prompt. CamDroid bundles its own adb — no setup needed.
        </div>
      </Card>
    </div>
  );
}