// Builds the renderer bundle and copies static assets (wasm, models, html, css).
import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist', 'renderer');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'renderer', 'main.jsx')],
  bundle: true,
  outfile: path.join(out, 'bundle.js'),
  format: 'iife',
  target: 'chrome128',
  jsx: 'automatic',
  minify: process.argv.includes('--minify'),
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info'
});

cpSync(path.join(root, 'src', 'renderer', 'index.html'), path.join(out, 'index.html'));
cpSync(path.join(root, 'src', 'renderer', 'styles.css'), path.join(out, 'styles.css'));

const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
if (existsSync(wasmSrc)) cpSync(wasmSrc, path.join(out, 'wasm'), { recursive: true });

const modelsSrc = path.join(root, 'vendor', 'models');
if (existsSync(modelsSrc)) cpSync(modelsSrc, path.join(out, 'models'), { recursive: true });

console.log('renderer built ->', out);