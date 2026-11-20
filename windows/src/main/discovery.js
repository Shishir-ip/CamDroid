// Device discovery: mDNS (Wi-Fi) + adb forward (USB). Emits a merged device list.
const { Bonjour } = require('bonjour-service');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { app } = require('electron');

const USB_LOCAL_PORT = 18765;
const PHONE_PORT = 8765;

let bonjour = null;
let browser = null;
let emit = () => {};
let timer = null;
const wifiDevices = new Map(); // key -> device
const usbDevices = new Map(); // serial -> device
let adbPathCache = null;
let lastAdbRaw = [];
let polling = false;
let stopped = true;
const usbPorts = new Map();

function adbPath() {
  if (adbPathCache) return adbPathCache;
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'adb', 'adb.exe')
    : path.join(__dirname, '..', '..', 'vendor', 'adb', 'adb.exe');
  adbPathCache = p;
  return p;
}

function merged() {
  return [...wifiDevices.values(), ...usbDevices.values()];
}

function push() {
  emit(merged());
}

// ---------------------------------------------------------------- mDNS

function startMdns() {
  try {
    bonjour = new Bonjour();
    browser = bonjour.find({ type: 'camdroid' });
    browser.on('up', (svc) => {
      const addresses = svc.addresses || [];
      const ipv4 = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.host;
      if (!ipv4) return;
      const key = `${ipv4}:${svc.port}`;
      wifiDevices.set(key, {
        id: `wifi:${key}`,
        name: svc.name || 'CamDroid phone',
        host: ipv4,
        port: svc.port || PHONE_PORT,
        transport: 'wifi'
      });
      push();
    });
    browser.on('down', (svc) => {
      const addresses = svc.addresses || [];
      const ipv4 = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.host;
      wifiDevices.delete(`${ipv4}:${svc.port}`);
      push();
    });
  } catch {}
}

// ---------------------------------------------------------------- adb / USB

function runAdb(args, timeout = 4000) {
  return new Promise((resolve) => {
    try {
      const child = spawn(adbPath(), args, { windowsHide: true });
      let out = '';
      let err = '';
      const t = setTimeout(() => { try { child.kill(); } catch {} resolve({ out, err, code: -1 }); }, timeout);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', () => { clearTimeout(t); resolve({ out: '', err: 'spawn failed', code: -1 }); });
      child.on('close', (code) => { clearTimeout(t); resolve({ out, err, code }); });
    } catch {
      resolve({ out: '', err: 'exception', code: -1 });
    }
  });
}

async function pollAdb() {
  if (polling || stopped) return;
  polling = true;
  try {
  const { out, code } = await runAdb(['devices']);
  if (code !== 0) {
    if (usbDevices.size) { usbDevices.clear(); push(); }
    lastAdbRaw = [];
    return;
  }
  const serials = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0]);
  lastAdbRaw = serials;

  for (const serial of serials) {
    if (stopped) return;
    if (!usbPorts.has(serial)) {
      let port = USB_LOCAL_PORT;
      while ([...usbPorts.values()].includes(port)) port++;
      usbPorts.set(serial, port);
    }
    const localPort = usbPorts.get(serial);
    const forwarded = await runAdb(['-s', serial, 'forward', '--no-rebind', `tcp:${localPort}`, `tcp:${PHONE_PORT}`]);
    if (forwarded.code !== 0) { usbDevices.delete(serial); continue; }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1800);
      const resp = await fetch(`http://127.0.0.1:${localPort}/info`, { signal: ctrl.signal });
      clearTimeout(t);
      const info = await resp.json();
      if (info.app === 'CamDroid') {
        usbDevices.set(serial, {
          id: `usb:${serial}`,
          name: info.model || serial,
          host: '127.0.0.1',
          port: localPort,
          transport: 'usb',
          serial
        });
      } else {
        usbDevices.delete(serial);
      }
    } catch {
      usbDevices.delete(serial);
    }
  }
  for (const key of [...usbDevices.keys()]) {
    if (!serials.includes(key)) usbDevices.delete(key);
  }
  if (!stopped) push();
  } finally { polling = false; }
}

// ---------------------------------------------------------------- lifecycle

function start(emitFn) {
  stopped = false;
  emit = emitFn;
  startMdns();
  pollAdb();
  timer = setInterval(pollAdb, 3000);
}

function stop() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  try { if (browser) browser.stop(); } catch {}
  try { if (bonjour) bonjour.destroy(); } catch {}
  bonjour = null;
  browser = null;
}

function refresh() {
  pollAdb();
  return merged();
}

function adbStatus() {
  return { adbPath: adbPath(), devices: lastAdbRaw };
}

module.exports = { start, stop, refresh, adbStatus };