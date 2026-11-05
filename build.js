'use strict';
// Builds dist/PortHop.exe (Node single-executable app). Usage: node build.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;
// Optional --out <dir>: build somewhere else (e.g. while dist/PortHop.exe is running and locked).
const outIdx = process.argv.indexOf('--out');
const dist = outIdx > 0 && process.argv[outIdx + 1] ? path.resolve(process.argv[outIdx + 1]) : path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

// 1. Inline upnp.js into server.js (SEA main scripts can't require() local files).
let server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
for (const name of ['upnp', 'art', 'detect', 'store', 'autostart']) {
  const src = fs.readFileSync(path.join(root, name + '.js'), 'utf8');
  const needle = `const ${name} = require('./${name}');`;
  if (!server.includes(needle)) throw new Error(`require line for ${name} not found in server.js`);
  server = server.replace(needle, () => `const ${name} = (() => {\nconst module = { exports: {} }; const exports = module.exports;\n${src}\nreturn module.exports;\n})();`);
}
fs.writeFileSync(path.join(dist, 'bundle.js'), server);

const outName = process.platform === 'win32' ? 'PortHop.exe' : 'porthop'; // build on the OS you are targeting
// 2. SEA config with embedded assets (UI, game list, and any pre-downloaded cover art in ./art).
const assets = { 'games.json': path.join(root, 'games.json'), 'public/index.html': path.join(root, 'public', 'index.html'), 'tray.ps1': path.join(root, 'tray.ps1') };
const artDir = path.join(root, 'art');
let artCount = 0;
if (fs.existsSync(artDir)) {
  for (const f of fs.readdirSync(artDir)) if (/^[a-z0-9-]+\.img$/.test(f)) { assets['art/' + f] = path.join(artDir, f); artCount++; }
}
console.log(`Embedding ${artCount} cover image(s)`);
fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify({
  main: 'bundle.js',
  output: outName,
  disableExperimentalSEAWarning: true,
  assets,
}, null, 2));

const r = spawnSync(process.execPath, ['--build-sea', 'sea-config.json'], { cwd: dist, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

// 3. Flip the PE subsystem from console to GUI so no black console window appears.
const exe = path.join(dist, outName);
if (process.platform === 'win32') {
  const buf = fs.readFileSync(exe);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') throw new Error('Not a PE file');
  const subsysOff = peOff + 24 + 68;
  if (buf.readUInt16LE(subsysOff) === 3) { buf.writeUInt16LE(2, subsysOff); fs.writeFileSync(exe, buf); }
} else fs.chmodSync(exe, 0o755);
console.log('Built', exe, (fs.statSync(exe).size / 1048576).toFixed(1) + ' MB');
