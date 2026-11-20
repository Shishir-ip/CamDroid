// Small reusable controls with premium feel.
import React from 'react';

export function Slider({ label, value, min, max, step = 0.01, display, onChange, onReset, disabled }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="ctl" style={disabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
      <div className="ctl-head">
        <label onDoubleClick={onReset} title={onReset ? 'Double-click to reset' : undefined}>{label}</label>
        <span className="val">{display ?? value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        style={{ '--fill': `${fill}%` }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={onReset}
      />
    </div>
  );
}

export function Toggle({ label, sub, checked, onChange }) {
  return (
    <div className="toggle-row">
      <div>
        <label>{label}</label>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <button
        className={'switch' + (checked ? ' on' : '')}
        role="switch" aria-checked={checked}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

export function Select({ value, options, onChange, disabled }) {
  return (
    <select className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function Segmented({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, icon, children }) {
  return (
    <div className="card">
      {title && <h3>{icon}{title}</h3>}
      {children}
    </div>
  );
}

export const pct = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
export const signed = (v, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;