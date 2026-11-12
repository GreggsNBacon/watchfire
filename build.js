'use strict';
// Builds dist/Watchfire.exe (Node single-executable app). Usage: node build.js [--out <dir>] [--linux]
//   --linux: builds the Linux (x64) version instead, from any OS: dist/watchfire, plus
//            dist/watchfire_<version>_amd64.deb and dist/Watchfire-<version>-linux-x64.tar.gz.
//            It downloads the official Node.js for Linux of this same version (checked against nodejs.org's SHA-256 list)
//            once into .cache/ and builds on top of it.
//
// Versions: 1.2.<commit count>, like Emberkeep's 0.3.<commit count>. The packaged exe reports it (Settings, /api/hello,
// Emberkeep) and carries it in its file properties along with Watchfire's name and icon, instead of Node.js's. The 4th
// part of the file version is the minute of the day, so a rebuild of the same commit still installs as an upgrade.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const LINUX = process.argv.includes('--linux');

const MAJOR_MINOR = '1.2';
const root = __dirname;
// Optional --out <dir>: build somewhere else (e.g. while dist/Watchfire.exe is running and locked).
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

  const outName = LINUX ? 'watchfire' : process.platform === 'win32' ? 'Watchfire.exe' : 'watchfire';
  // 2. SEA config with embedded assets: the UI, game list, tray and window helpers, WebView2 SDK files, icon, and any
  //    pre-downloaded cover art in ./art.
  const assets = {
    'games.json': path.join(root, 'games.json'),
    'public/index.html': path.join(root, 'public', 'index.html'),
    'assets/watchfire.ico': path.join(root, 'assets', 'watchfire.ico'),
    'assets/watchfire.svg': path.join(root, 'assets', 'watchfire.svg'),
  };
  // Windows only: the tray and window helpers and the WebView2 files they use.
  if (!LINUX) {
    assets['tray.ps1'] = path.join(root, 'tray.ps1');
    assets['window.ps1'] = path.join(root, 'window.ps1');
    for (const f of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'])
      assets[`vendor/webview2/${f}`] = path.join(root, 'vendor', 'webview2', f);
  }
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
    ...(LINUX ? { executable: await linuxNode() } : {}),
  }, null, 2));

  const r = spawnSync(process.execPath, ['--build-sea', 'sea-config.json'], { cwd: dist, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);

  const exe = path.join(dist, outName);
  if (LINUX) { done(exe); packageLinux(exe); return; }
  if (process.platform !== 'win32') { fs.chmodSync(exe, 0o755); done(exe); return; }

  // 3. Watchfire's icon and version in the exe's resources, replacing Node.js's.
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
    throw new Error('The resedit package is missing: run "npm install" in the Watchfire folder first.');
  }
  // Node's own signature no longer matches once anything changes, so it's dropped.
  const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'watchfire.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const icons = iconFile.icons.map((i) => i.data);
  if (groups.length) for (const g of groups) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);
  else ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);

  const [v1, v2, v3, v4] = fileVersion.split('.').map(Number);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(v1, v2, v3, v4, 1033);
  vi.setProductVersion(v1, v2, v3, 0, 1033);
  const lang = { lang: 1033, codepage: 1200 };
  // Replace every string table (Node's say "Node.js"), keeping just Watchfire's.
  for (const l of vi.getAllLanguagesForStringValues()) vi.removeAllStringValues(l);
  vi.setStringValues(lang, {
    ProductName: 'Watchfire',
    FileDescription: 'Watchfire: open ports on your router for game servers',
    CompanyName: 'Watchfire',
    LegalCopyright: `© ${now.getFullYear()} Watchfire`,
    InternalName: 'Watchfire',
    OriginalFilename: 'Watchfire.exe',
    FileVersion: fileVersion,
    ProductVersion: version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

// The official Node.js for Linux x64 of the version running this build (a SEA must match the Node that made it).
async function linuxNode() {
  const ver = process.version;
  const name = `node-${ver}-linux-x64`;
  const cache = path.join(root, '.cache');
  const bin = path.join(cache, name, 'node');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const base = `https://nodejs.org/dist/${ver}/`;
  console.log(`Downloading ${name} from nodejs.org…`);
  const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
  const want = (sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.gz`)) || '').split(' ')[0];
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('No checksum for ' + name);
  const res = await fetch(base + name + '.tar.gz');
  if (!res.ok) throw new Error(`nodejs.org answered ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(gz).digest('hex');
  if (got !== want) throw new Error(`Checksum mismatch for ${name}.tar.gz`);
  // Take bin/node out of the tarball.
  const tar = zlib.gunzipSync(gz);
  for (let off = 0; off + 512 <= tar.length;) {
    const entry = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!entry) break;
    const size = parseInt(tar.toString('latin1', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    if (entry === `${name}/bin/node`) { fs.writeFileSync(bin, tar.subarray(off + 512, off + 512 + size)); return bin; }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('bin/node not found in ' + name + '.tar.gz');
}

// The .deb (Ubuntu, Debian, Mint…) and a tarball for any other Linux, via linux/pkg.js.
function packageLinux(exe) {
  const L = path.join(root, 'linux');
  const icon = path.join(root, 'assets', 'watchfire.svg');
  const spec = {
    package: 'watchfire', version, arch: 'amd64',
    control: {
      Maintainer: 'GreggsNBacon <22661097+GreggsNBacon@users.noreply.github.com>',
      Section: 'net', Priority: 'optional', Homepage: 'https://github.com/GreggsNBacon/watchfire',
      Depends: 'libc6 (>= 2.28), libgcc-s1 | libgcc1, libstdc++6',
      Suggests: 'chromium | google-chrome-stable',
      Description: 'Open ports on your router for game servers\nPick a game and Watchfire asks your router (UPnP) to forward its ports to this\ncomputer, so friends outside your home can join. Shows what is open and the\naddress to send your friends, and restores the forwards after a router reboot.',
    },
    files: [
      { src: exe, dest: '/opt/watchfire/watchfire', mode: '755' },
      { link: '/usr/bin/watchfire', target: '/opt/watchfire/watchfire' },
      { src: path.join(L, 'watchfire.desktop'), dest: '/usr/share/applications/watchfire.desktop' },
      { src: icon, dest: '/usr/share/icons/hicolor/scalable/apps/watchfire.svg' },
      { src: path.join(L, 'README.txt'), dest: '/usr/share/doc/watchfire/README.txt' },
    ],
    tarball: {
      folder: `watchfire-${version}`,
      files: [
        { src: exe, mode: '755' },
        { src: path.join(L, 'install.sh'), mode: '755' },
        { src: path.join(L, 'watchfire.desktop') },
        { src: icon },
        { src: path.join(L, 'README.txt') },
      ],
    },
  };
  const specFile = path.join(dist, 'package.json');
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
  for (const old of fs.readdirSync(dist)) if (/^watchfire_.*_amd64\.deb$|^Watchfire-.*-linux-x64\.tar\.gz$/.test(old)) fs.unlinkSync(path.join(dist, old));
  for (const [kind, out] of [['deb', `watchfire_${version}_amd64.deb`], ['tar', `Watchfire-${version}-linux-x64.tar.gz`]]) {
    const r = spawnSync(process.execPath, [path.join(L, 'pkg.js'), kind, specFile, path.join(dist, out)], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
  }
}

function done(exe) {
  console.log('Built', exe, (fs.statSync(exe).size / 1048576).toFixed(1) + ' MB', 'version', fileVersion);
}
