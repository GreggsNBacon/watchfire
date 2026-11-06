'use strict';
// Builds dist/PortHop.exe (Node single-executable app). Usage: node build.js [--out <dir>]
//
// Versions: 1.2.<commit count>, like Hostbay's 0.3.<commit count>. The packaged exe reports it (Settings, /api/hello,
// Hostbay) and carries it in its file properties along with PortHop's name and icon, instead of Node.js's. The 4th
// part of the file version is the minute of the day, so a rebuild of the same commit still installs as an upgrade.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAJOR_MINOR = '1.2';
const root = __dirname;
// Optional --out <dir>: build somewhere else (e.g. while dist/PortHop.exe is running and locked).
const outIdx = process.argv.indexOf('--out');
const dist = outIdx > 0 && process.argv[outIdx + 1] ? path.resolve(process.argv[outIdx + 1]) : path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

function gitCount() {
  const r = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const n = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
const now = new Date();
const version = `${MAJOR_MINOR}.${gitCount()}`;
const fileVersion = `${version}.${now.getHours() * 60 + now.getMinutes()}`;
console.log(`Version ${fileVersion}`);

(async () => {
  // 1. Inline the local modules into server.js (SEA main scripts can't require() local files) and stamp the version.
  let server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const name of ['upnp', 'art', 'detect', 'store', 'autostart']) {
    const src = fs.readFileSync(path.join(root, name + '.js'), 'utf8');
    const needle = `const ${name} = require('./${name}');`;
    if (!server.includes(needle)) throw new Error(`require line for ${name} not found in server.js`);
    server = server.replace(needle, () => `const ${name} = (() => {\nconst module = { exports: {} }; const exports = module.exports;\n${src}\nreturn module.exports;\n})();`);
  }
  const versionLine = /const VERSION = '[^']*';/;
  if (!versionLine.test(server)) throw new Error('VERSION line not found in server.js');
  server = server.replace(versionLine, `const VERSION = '${version}';`);
  fs.writeFileSync(path.join(dist, 'bundle.js'), server);

  const outName = process.platform === 'win32' ? 'PortHop.exe' : 'porthop'; // build on the OS you are targeting
  // 2. SEA config with embedded assets: the UI, game list, tray and window helpers, WebView2 SDK files, icon, and any
  //    pre-downloaded cover art in ./art.
  const assets = {
    'games.json': path.join(root, 'games.json'),
    'public/index.html': path.join(root, 'public', 'index.html'),
    'tray.ps1': path.join(root, 'tray.ps1'),
    'window.ps1': path.join(root, 'window.ps1'),
    'assets/porthop.ico': path.join(root, 'assets', 'porthop.ico'),
  };
  for (const f of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'])
    assets[`vendor/webview2/${f}`] = path.join(root, 'vendor', 'webview2', f);
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

  const exe = path.join(dist, outName);
  if (process.platform !== 'win32') { fs.chmodSync(exe, 0o755); done(exe); return; }

  // 3. PortHop's icon and version in the exe's resources, replacing Node.js's.
  let buf = await stampResources(fs.readFileSync(exe));

  // 4. Flip the PE subsystem from console to GUI so no black console window appears.
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') throw new Error('Not a PE file');
  const subsysOff = peOff + 24 + 68;
  if (buf.readUInt16LE(subsysOff) === 3) buf.writeUInt16LE(2, subsysOff);
  fs.writeFileSync(exe, buf);
  done(exe);
})().catch((e) => { console.error(e); process.exit(1); });

async function stampResources(data) {
  let ResEdit;
  try { ResEdit = await import('resedit'); } catch {
    throw new Error('The resedit package is missing: run "npm install" in the PortHop folder first.');
  }
  // Node's own signature no longer matches once anything changes, so it's dropped.
  const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'porthop.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const icons = iconFile.icons.map((i) => i.data);
  if (groups.length) for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);
  else ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);

  const [v1, v2, v3, v4] = fileVersion.split('.').map(Number);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(v1, v2, v3, v4, 1033);
  vi.setProductVersion(v1, v2, v3, 0, 1033);
  const lang = { lang: 1033, codepage: 1200 };
  // Replace every string table (Node's say "Node.js"), keeping just PortHop's.
  for (const l of vi.getAllLanguagesForStringValues()) vi.removeAllStringValues(l);
  vi.setStringValues(lang, {
    ProductName: 'PortHop',
    FileDescription: 'PortHop: open ports on your router for game servers',
    CompanyName: 'PortHop',
    LegalCopyright: `© ${now.getFullYear()} PortHop`,
    InternalName: 'PortHop',
    OriginalFilename: 'PortHop.exe',
    FileVersion: fileVersion,
    ProductVersion: version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

function done(exe) {
  console.log('Built', exe, (fs.statSync(exe).size / 1048576).toFixed(1) + ' MB', 'version', fileVersion);
}
