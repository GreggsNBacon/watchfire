'use strict';
// Cover-art fetching + caching. Providers: SteamGridDB (needs free API key) then Steam's public CDN (no key).
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ALLOWED_HOSTS = ['steamgriddb.com', 'steampowered.com', 'steamstatic.com'];
const MAX_BYTES = 4 * 1024 * 1024;
const hostAllowed = (h) => ALLOWED_HOSTS.some((d) => h === d || h.endsWith('.' + d));

const dataDir = path.join(process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'PortHop');
const cacheDir = path.join(dataDir, 'art');
const settingsFile = path.join(dataDir, 'settings.json');
const customDir = path.join(dataDir, 'covers'); // user-uploaded covers always win

// ---- settings (API key lives only on disk + server memory, never sent to the page) ----
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
}
function setSgdbKey(key) {
  key = String(key || '').trim();
  if (key && !/^[A-Za-z0-9]{16,64}$/.test(key)) throw new Error('That doesn’t look like a SteamGridDB API key');
  fs.mkdirSync(dataDir, { recursive: true });
  const s = readSettings();
  if (key) s.sgdbKey = key; else delete s.sgdbKey;
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}
function getSgdbKey() {
  const k = process.env.PORTHOP_SGDB_KEY || readSettings().sgdbKey || '';
  return /^[A-Za-z0-9]{16,64}$/.test(k) ? k : '';
}

// ---- http ----
function get(urlStr, { headers = {}, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' || !hostAllowed(u.hostname)) return reject(new Error('Blocked host ' + u.hostname));
    const h = { 'User-Agent': 'PortHop/1.0', ...headers };
    if (!(u.hostname === 'steamgriddb.com' || u.hostname.endsWith('.steamgriddb.com'))) delete h.Authorization; // never leak the key
    const req = https.get(u, { headers: h, timeout: 10000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, u).toString(), { headers, redirects: redirects - 1 }));
      }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) req.destroy(new Error('Too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}
async function getJson(url, headers) {
  const r = await get(url, { headers });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return JSON.parse(r.body.toString('utf8'));
}

function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 8 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- providers ----
async function viaSgdb(key, { name, steam }) {
  const auth = { Authorization: 'Bearer ' + key };
  const base = 'https://www.steamgriddb.com/api/v2';
  let grids;
  if (steam) {
    grids = (await getJson(`${base}/grids/steam/${steam}?dimensions=600x900&types=static`, auth)).data;
    if (Array.isArray(grids) && Array.isArray(grids[0])) grids = grids[0];
  } else {
    const found = (await getJson(`${base}/search/autocomplete/${encodeURIComponent(name)}`, auth)).data;
    if (!found || !found.length) return null;
    grids = (await getJson(`${base}/grids/game/${found[0].id}?dimensions=600x900&types=static`, auth)).data;
  }
  const url = grids && grids[0] && grids[0].url;
  if (!url) return null;
  const r = await get(url);
  return r.status === 200 ? r.body : null;
}

async function viaSteam({ name, steam }) {
  let appid = steam;
  if (steam === undefined) { // unknown game: try Steam store search, accept only a close name match
    const j = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=us`);
    const hit = (j.items || []).find((i) => { const a = norm(i.name), b = norm(name); return a === b || a.startsWith(b) || b.startsWith(a); });
    if (!hit) return null;
    appid = hit.id;
  }
  if (!appid) return null; // 0 = not on Steam
  for (const file of ['library_600x900.jpg', 'header.jpg']) {
    const r = await get(`https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/${file}`).catch(() => null);
    if (r && r.status === 200 && sniff(r.body)) return r.body;
  }
  return null;
}

// entry: { id, name, steam? }. Returns true if an image was saved to destDir/<id>.img
async function fetchArt(entry, destDir = cacheDir) {
  let img = null;
  const key = getSgdbKey();
  if (key) img = await viaSgdb(key, entry).catch(() => null);
  if (!img || !sniff(img)) img = await viaSteam(entry).catch(() => null);
  if (!img || !sniff(img)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, entry.id + '.img'), img);
  return true;
}

// Look up a cached image: user cache first, then whatever was bundled with the build.
let bundledReader = () => null;
function setBundledReader(fn) { bundledReader = fn; }
function readCached(id) {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) return null;
  let buf = null;
  try { buf = fs.readFileSync(path.join(customDir, id + '.img')); } catch { /* no custom cover */ }
  if (!buf) { try { buf = fs.readFileSync(path.join(cacheDir, id + '.img')); } catch { /* not cached */ } }
  if (!buf) { try { buf = bundledReader(id); } catch { buf = null; } }
  const mime = buf && sniff(buf);
  return mime ? { buf, mime } : null;
}

function saveCustomCover(id, buf) {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('Bad id');
  if (buf.length > MAX_BYTES) throw new Error('Image too large');
  if (!sniff(buf)) throw new Error('Not a PNG, JPEG or WebP image');
  fs.mkdirSync(customDir, { recursive: true });
  fs.writeFileSync(path.join(customDir, id + '.img'), buf);
}
function removeCustomCover(id) {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) return;
  try { fs.unlinkSync(path.join(customDir, id + '.img')); } catch { /* none */ }
}

module.exports = { fetchArt, readCached, setBundledReader, setSgdbKey, getSgdbKey, cacheDir, saveCustomCover, removeCustomCover };
