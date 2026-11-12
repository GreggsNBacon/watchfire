// Builds Linux packages on any OS (Windows' tools can't set Unix permissions, owners or symlinks):
//   node pkg.js deb <spec.json> <out.deb>       a Debian/Ubuntu package
//   node pkg.js tar <spec.json> <out.tar.gz>    a tarball of spec.tarball (folder name + files)
//
// spec.json (paths relative to the spec file unless absolute):
// {
//   "package": "emberkeep", "version": "0.3.41", "arch": "amd64",
//   "control": { "Maintainer": "...", "Depends": "...", "Section": "utils", "Description": "line\n more" },
//   "files":   [ { "src": "publish-linux/emberkeep", "dest": "/opt/emberkeep/emberkeep", "mode": "755" },
//                { "link": "/usr/bin/emberkeep", "target": "/opt/emberkeep/emberkeep" } ],
//   "scripts": { "postinst": "linux/deb/postinst", "prerm": "linux/deb/prerm", "postrm": "linux/deb/postrm" },
//   "tarball": { "folder": "emberkeep-0.3.41", "files": [ { "src": "...", "mode": "755" } ] }
// }
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

const [kind, specPath, out] = process.argv.slice(2);
if (!['deb', 'tar'].includes(kind) || !specPath || !out) { console.error('usage: node pkg.js deb|tar spec.json out'); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const base = path.dirname(path.resolve(specPath));
const abs = (p) => (path.isAbsolute(p) ? p : path.join(base, p));
const mtime = Math.floor(Date.now() / 1000);

// ---------- tar (ustar) ----------
function header(name, { size = 0, mode = 0o644, type = '0', linkname = '' } = {}) {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) { // ustar: split long names at a slash into prefix (155) + name (100)
    const cut = name.lastIndexOf('/', name.length - 2 > 155 ? 155 : name.length - 2);
    prefix = name.slice(0, cut); name = name.slice(cut + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('path too long: ' + prefix + '/' + name);
  }
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100); put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(mtime, 12), 136, 12); put('        ', 148, 8); put(type, 156, 1);
  put(linkname, 157, 100); put('ustar\0', 257, 6); put('00', 263, 2); put('root', 265, 32); put('root', 297, 32);
  put(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
class Tar {
  constructor() { this.parts = []; this.dirs = new Set(); }
  dir(name, mode = 0o755) { if (this.dirs.has(name)) return; this.dirs.add(name); this.parts.push(header(name, { mode, type: '5' })); }
  // Adds the folders above a path ("./opt/", "./opt/emberkeep/") first, as dpkg and tar expect.
  parents(name) {
    const segs = name.replace(/\/$/, '').split('/'); segs.pop();
    for (let i = 1; i <= segs.length; i++) this.dir(segs.slice(0, i).join('/') + '/');
  }
  file(name, data, mode = 0o644) {
    this.parents(name);
    this.parts.push(header(name, { size: data.length, mode }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  link(name, target) { this.parents(name); this.parts.push(header(name, { type: '2', mode: 0o777, linkname: target })); }
  gz() { return zlib.gzipSync(Buffer.concat([...this.parts, Buffer.alloc(1024)]), { level: 9 }); }
}
const read = (f) => { const d = fs.readFileSync(abs(f.src)); return f.text ? Buffer.from(d.toString('utf8').replace(/\r\n/g, '\n')) : d; };
const isText = (src) => /\.(sh|service|desktop|txt|md|svg)$|\/(postinst|prerm|postrm|preinst)$/.test(src.replace(/\\/g, '/'));
const modeOf = (f) => parseInt(f.mode || '644', 8);

if (kind === 'tar') {
  const t = new Tar();
  const folder = spec.tarball.folder;
  t.dir(folder + '/');
  for (const f of spec.tarball.files) t.file(`${folder}/${f.as || path.basename(f.src)}`, read({ ...f, text: isText(f.src) }), modeOf(f));
  fs.writeFileSync(out, t.gz());
} else {
  // ---------- data.tar.gz: the installed files ----------
  const data = new Tar(); data.dir('./');
  const md5 = []; let bytes = 0;
  for (const f of spec.files) {
    const name = '.' + f.dest;
    if (f.link) { data.link('.' + f.link, f.target); continue; }
    const buf = read({ ...f, text: isText(f.src) });
    data.file(name, buf, modeOf(f));
    md5.push(`${crypto.createHash('md5').update(buf).digest('hex')}  ${f.dest.slice(1)}`);
    bytes += buf.length;
  }
  // ---------- control.tar.gz: what dpkg reads ----------
  const c = { Package: spec.package, Version: spec.version, Architecture: spec.arch || 'amd64', 'Installed-Size': String(Math.ceil(bytes / 1024)), ...spec.control };
  const desc = String(c.Description || spec.package).split('\n');
  c.Description = desc[0] + desc.slice(1).map((l) => '\n ' + (l.trim() ? l.trim() : '.')).join('');
  const control = Object.entries(c).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
  const ctl = new Tar(); ctl.dir('./');
  ctl.file('./control', Buffer.from(control));
  ctl.file('./md5sums', Buffer.from(md5.join('\n') + '\n'));
  for (const [name, src] of Object.entries(spec.scripts || {})) ctl.file('./' + name, read({ src, text: true }), 0o755);

  // ---------- the .deb: an ar archive ----------
  const members = [['debian-binary', Buffer.from('2.0\n')], ['control.tar.gz', ctl.gz()], ['data.tar.gz', data.gz()]];
  const parts = [Buffer.from('!<arch>\n')];
  for (const [name, buf] of members) {
    const h = name.padEnd(16) + String(mtime).padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(buf.length).padEnd(10) + '`\n';
    parts.push(Buffer.from(h, 'latin1'), buf);
    if (buf.length % 2) parts.push(Buffer.from('\n'));
  }
  fs.writeFileSync(out, Buffer.concat(parts));
}
console.log(`${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
