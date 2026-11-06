'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const upnp = require('./upnp');
const art = require('./art');
const detect = require('./detect');
const store = require('./store');
const autostart = require('./autostart');
const crypto = require('crypto');

// When packaged as a single exe, the UI and game list are embedded assets instead of files.
let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { /* running from source */ }
function readAsset(rel) {
  if (sea) return Buffer.from(sea.getAsset(rel));
  return fs.readFileSync(path.join(__dirname, rel));
}

art.setBundledReader((id) => (sea ? Buffer.from(sea.getAsset(`art/${id}.img`)) : fs.readFileSync(path.join(__dirname, 'art', `${id}.img`))));
const artMisses = new Set(); // don't re-hit the network this session for covers we couldn't find
let artChain = Promise.resolve();
const enqueueArt = (fn) => { const p = artChain.then(fn); artChain = p.catch(() => {}); return p; };

const TAG = 'Watchfire:';
const LEGACY_TAGS = ['PortHop:']; // Watchfire was called PortHop: forwards it made then are still ours
const isOurDescription = (d) => typeof d === 'string' && (d.startsWith(TAG) || LEGACY_TAGS.some((t) => d.startsWith(t)));
const VERSION = '1.2.0-dev'; // build.js stamps the real version (1.2.<commit count>) into the packaged exe
const MAX_PORTS_PER_REQUEST = 200;
let httpPort = 0;

// ---------- game data ----------
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function expandEntries(entries) {
  const out = [];
  const seen = new Set();
  for (const [proto, range] of entries) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(range).trim());
    if (!m) throw new Error(`Bad port range "${range}"`);
    const lo = +m[1], hi = m[2] ? +m[2] : lo;
    if (lo < 1 || hi > 65535 || hi < lo) throw new Error(`Port out of range "${range}"`);
    const protos = String(proto).toUpperCase() === 'TCP/UDP' || String(proto).toUpperCase() === 'BOTH' ? ['TCP', 'UDP'] : [String(proto).toUpperCase()];
    for (const p of protos) {
      if (p !== 'TCP' && p !== 'UDP') throw new Error(`Bad protocol "${proto}"`);
      for (let port = lo; port <= hi; port++) {
        const k = `${p}/${port}`;
        if (!seen.has(k)) { seen.add(k); out.push({ port, protocol: p }); }
      }
    }
    if (out.length > MAX_PORTS_PER_REQUEST) throw new Error(`Too many ports (max ${MAX_PORTS_PER_REQUEST})`);
  }
  return out;
}

const builtInGames = () => JSON.parse(readAsset('games.json').toString('utf8')).map((g) => ({ id: slug(g.name), ...g }));

// Built-in list + the user's overrides + the user's own games.
function loadGames() {
  const { overrides, userGames } = store.load();
  const merged = builtInGames().map((g) => (overrides[g.id] ? { ...g, ...overrides[g.id], id: g.id, modified: true } : g));
  for (const u of userGames) merged.push({ ...u, custom: true });
  const out = [];
  for (const g of merged) {
    try { out.push({ ...g, expanded: expandEntries(g.ports) }); } catch { /* skip corrupt entry */ }
  }
  return out;
}

const cleanStr = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

// Validates editor input; throws a user-readable Error.
function cleanGameInput(body) {
  const name = cleanStr(body.name, 40);
  if (!name) throw new Error('Give the game a name');
  if (!Array.isArray(body.ports) || !body.ports.length || body.ports.length > 12) throw new Error('Add between 1 and 12 port entries');
  const ports = body.ports.map((p) => {
    const proto = String(p[0]).toUpperCase();
    if (!['TCP', 'UDP', 'TCP/UDP'].includes(proto)) throw new Error(`Bad protocol "${cleanStr(p[0], 10)}"`);
    return [proto, cleanStr(p[1], 11)];
  });
  expandEntries(ports); // validates ranges + total count
  const procs = (Array.isArray(body.procs) ? body.procs : []).slice(0, 8).map((s) => cleanStr(s, 60).replace(/\.exe$/i, '')).filter(Boolean);
  for (const s of procs) if (!/^[A-Za-z0-9_.\- ]+(@\d{1,5})?$/.test(s)) throw new Error(`Bad process name "${s}"`);
  return { name, category: cleanStr(body.category, 20) || 'Custom', ports, procs, note: cleanStr(body.note, 100) };
}

// ---------- router state ----------
let gw = null;
let localIp = null;
let lastError = null;

// Concurrent callers (startup restore, the UI, the tray) share one discovery instead of each scanning.
let gwInflight = null;
function ensureGateway(force = false) {
  if (gw && !force) return Promise.resolve(gw);
  if (!gwInflight) gwInflight = discoverGateway().finally(() => { gwInflight = null; });
  return gwInflight;
}

async function discoverGateway() {
  gw = null; localIp = null; lastError = null;
  if ((process.env.WATCHFIRE_TEST_GATEWAY || process.env.PORTHOP_TEST_GATEWAY)) { // test hook: talk to a specific (fake) router description URL instead of scanning the network
    try { gw = await upnp.describeAt((process.env.WATCHFIRE_TEST_GATEWAY || process.env.PORTHOP_TEST_GATEWAY)); localIp = await upnp.localIpFor(gw.host); } catch (e) { lastError = e.message; }
    return gw;
  }
  if ((process.env.WATCHFIRE_OFFLINE || process.env.PORTHOP_OFFLINE)) { lastError = 'Offline mode (WATCHFIRE_OFFLINE is set) — router discovery disabled.'; return null; }
  try {
    gw = await upnp.discover();
    if (!gw) lastError = 'No UPnP router found. Make sure UPnP is enabled in your router settings.';
    else localIp = await upnp.localIpFor(gw.host);
  } catch (e) {
    lastError = e.message;
  }
  return gw;
}

// Public IP with some patience: routers can drop a request when several arrive together, and some expose a second
// WAN service that is the one that answers. Retry, then try the alternates, and remember which one worked.
let lastIpError = '';
async function lookupExternalIp(g) {
  const tryOne = async (c) => {
    for (let i = 0; i < 2; i++) {
      try { const ip = await upnp.getExternalIp(c); if (ip) return ip; lastIpError = 'The router returned an empty address'; } catch (e) { lastIpError = e.message; }
      await sleep(400);
    }
    return '';
  };
  let ip = await tryOne(g);
  if (!ip) {
    for (const alt of g.alts || []) {
      ip = await tryOne(alt);
      if (ip) { alt.alts = [g, ...(g.alts || []).filter((a) => a !== alt)]; gw = alt; break; }
    }
  }
  if (ip) lastIpError = '';
  return ip;
}

async function status() {
  const g = await ensureGateway();
  if (!g) return { found: false, error: lastError };
  let externalIp = await lookupExternalIp(g);
  if (!externalIp) externalIp = snapshot.externalIp || ''; // last known good value beats a blank
  const cgnat = !!externalIp && upnp.isPrivateHost(externalIp);
  if (externalIp) snapshot.externalIp = externalIp;
  return { found: true, router: g.name, routerHost: g.host, localIp, externalIp, ipError: externalIp ? null : lastIpError, cgnat, error: null, restore: lastRestore };
}

const describeFor = (name) => `${TAG} ${String(name).replace(/[^\w .:'()+-]/g, '').slice(0, 40) || 'custom'}`;

async function forwardPorts(name, ports) {
  const g = await ensureGateway();
  if (!g) throw new Error(lastError || 'Router not found');
  const results = [];
  for (const p of ports) {
    try {
      await upnp.addMapping(g, { port: p.port, protocol: p.protocol, internalClient: localIp, description: describeFor(name) });
      // Some routers answer "OK" and then don't keep the rule. Read it back; only a definite "no such entry" or a wrong target is a failure.
      let stored = null;
      try { stored = await upnp.getSpecificMapping(g, p); } catch (e) { if (e.code === 714) stored = false; }
      if (stored === false) results.push({ ...p, ok: false, error: 'The router said OK but did not keep the rule. Check its UPnP/firewall settings.' });
      else if (stored && stored.internalClient !== localIp) results.push({ ...p, ok: false, error: `The router stored this for ${stored.internalClient || 'another device'}, not this PC (${localIp}).` });
      else results.push({ ...p, ok: true });
    } catch (e) {
      const msg = e.code === 718 ? 'Port already forwarded to another device' : e.message;
      results.push({ ...p, ok: false, error: msg });
    }
  }
  const added = results.filter((r) => r.ok);
  if (added.length) { // remember what we opened (keyed so re-forwarding doesn't duplicate)
    const label = describeFor(name).slice(TAG.length + 1);
    const reg = new Map(store.loadForwards().map((r) => [fkey(r), r]));
    for (const r of added) { reg.delete(fkey(r)); reg.set(fkey(r), { port: r.port, protocol: r.protocol, name: label }); }
    store.saveForwards([...reg.values()]);
  }
  return results;
}

// Delete one mapping and read it back. Some routers answer "OK" to a delete that arrives right after another request
// and keep the rule, which is how a multi-port game ended up with only one port closed. Retry until the router agrees it's gone.
async function deleteVerified(g, p) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try { await upnp.deleteMapping(g, p); lastErr = null; }
    catch (e) { if (e.code !== 714 && e.code !== 713) { lastErr = e; await sleep(600); continue; } } // 714/713: already gone
    await sleep(300);
    try { await upnp.getSpecificMapping(g, p); } catch { return; } // not found (or the router can't say): treat as removed
    await sleep(600); // still listed: go again
  }
  throw lastErr || new Error(`The router still lists ${p.protocol} ${p.port} after removing it`);
}

// By default only removes mappings this app created (in our registry, or tagged with our description).
// `force` additionally allows removing any mapping that points at THIS PC (used by the per-row Remove in the table).
async function removePorts(ports, { force = false } = {}) {
  const g = await ensureGateway();
  if (!g) throw new Error(lastError || 'Router not found');
  const registry = new Set(store.loadForwards().map(fkey));
  const results = [];
  const removed = new Set();
  for (const p of ports) {
    let owned = registry.has(fkey(p));
    if (!owned) {
      try {
        const m = await upnp.getSpecificMapping(g, p);
        owned = isOurDescription(m.description) || (force && m.internalClient === localIp);
      } catch { owned = false; }
    }
    if (!owned) { results.push({ ...p, ok: true, skipped: true }); continue; }
    try { await deleteVerified(g, p); results.push({ ...p, ok: true }); removed.add(fkey(p)); }
    catch (e) { results.push({ ...p, ok: false, error: e.message }); }
  }
  if (removed.size) store.saveForwards(store.loadForwards().filter((r) => !removed.has(fkey(r))));
  return results;
}

const fkey = (p) => `${p.protocol}/${p.port}`;

// Everything we can learn about the router's forwards: its own table (if it will share it) + our registry verified one-by-one.
async function gatherMappings(g) {
  const { entries, error } = await upnp.listMappings(g);
  const seen = new Set(entries.map(fkey));
  // The registry is the user's *intent* ("what I had forwarded"), so entries are never dropped just because the router
  // lost them (e.g. after a reboot). They simply don't show as active until restored. Only an explicit Remove deletes them.
  const registry = store.loadForwards();
  const regKeys = new Set(registry.map(fkey));
  const extra = [];
  for (const r of registry) {
    if (seen.has(fkey(r))) continue;
    try {
      extra.push(await upnp.getSpecificMapping(g, r));
    } catch (e) {
      if (e.code === 714 || e.code === 713) continue; // router says it's not there right now
      // Router can't confirm either way: show it, flagged as unverified.
      extra.push({ port: r.port, protocol: r.protocol, internalPort: r.port, internalClient: localIp, enabled: true, description: `${TAG} ${r.name}`, unverified: true });
    }
  }
  const mappings = [...entries, ...extra].map((m) => ({
    ...m,
    ours: isOurDescription(m.description) || regKeys.has(fkey(m)), // some routers rewrite descriptions, so trust the registry too
    mine: m.internalClient === localIp,
  }));
  snapshot.mappings = mappings;
  return { mappings, enumerationError: error ? `${error.message} (code ${error.code})` : null };
}

// ---------- remembered state: snapshot for the tray, restore on launch ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let snapshot = { mappings: [], externalIp: '' };
let lastRestore = null; // { restored, conflicts } from the last launch-time restore

async function refreshSnapshot() {
  const g = gw;
  if (!g) return;
  await gatherMappings(g);
  { const ip = await lookupExternalIp(g); if (ip) snapshot.externalIp = ip; } // else keep the previous value
}

// Re-opens every port in the registry that the router no longer has (e.g. after a reboot or lease expiry).
async function restoreForwards() {
  if (store.loadPrefs().restore === false) return null;
  const g = gw;
  if (!g || !localIp) return null;
  let restored = 0, conflicts = 0;
  for (const r of store.loadForwards()) {
    try {
      const m = await upnp.getSpecificMapping(g, r);
      if (m.internalClient === localIp) continue; // already in place
      conflicts++; // someone else (or an old IP of this PC) holds the port: don't steal it, the user can re-forward manually
      continue;
    } catch { /* not present (or router can't say): try to add it */ }
    try {
      await upnp.addMapping(g, { port: r.port, protocol: r.protocol, internalClient: localIp, description: describeFor(r.name) });
      restored++;
    } catch { conflicts++; }
  }
  return { restored, conflicts };
}

// At launch the network may not be up yet (especially when started with Windows), so keep trying for a few minutes.
async function bootstrap() {
  for (let i = 0; i < 20 && !shuttingDown; i++) {
    if (await ensureGateway()) {
      lastRestore = await restoreForwards().catch(() => null);
      await refreshSnapshot().catch(() => {});
      return;
    }
    await sleep(15000);
  }
}

async function removeAllOurs() {
  const g = await ensureGateway();
  if (!g) throw new Error(lastError || 'Router not found');
  const { mappings } = await gatherMappings(g);
  const targets = new Map();
  for (const m of mappings) if (m.ours && m.mine) targets.set(fkey(m), { port: m.port, protocol: m.protocol });
  for (const r of store.loadForwards()) targets.set(fkey(r), { port: r.port, protocol: r.protocol });
  return removePorts([...targets.values()]);
}

function trayData() {
  const ip = snapshot.externalIp || '';
  const ours = new Set(snapshot.mappings.filter((m) => m.ours && m.mine).map(fkey));
  const covered = new Set();
  const forwards = [];
  for (const g of loadGames()) {
    if (g.expanded.length && g.expanded.every((e) => ours.has(fkey(e)))) {
      g.expanded.forEach((e) => covered.add(fkey(e)));
      forwards.push({
        name: g.name,
        summary: g.ports.map(([p, r]) => `${p === 'TCP/UDP' ? 'TCP+UDP' : p} ${r}`).join(', ').slice(0, 48),
        address: ip ? `${ip}:${g.expanded[0].port}` : '',
      });
    }
  }
  const otherPorts = [...ours].filter((k) => !covered.has(k)).length;
  // The menu's checkboxes ride along so the tray needs one cheap request, not two.
  return {
    quit: shuttingDown, router: gw ? gw.name : '', externalIp: ip, forwards, otherPorts,
    canStartup: !!sea && !headless, startup: startupCache === true, restore: store.loadPrefs().restore,
  };
}

// "Start with Windows" is read from the registry by running reg.exe, which is slow; remember the answer.
let startupCache = null;
async function startupEnabled() {
  if (!sea) return false;
  if (startupCache === null) startupCache = await autostart.isEnabled(process.execPath);
  return startupCache;
}

// ---------- companion apps (Emberkeep) ----------
// What's forwarded to this PC right now, from the cached snapshot: answers instantly, never waits on the router.
// The snapshot refreshes every minute and after every forward/remove.
function forwardedPayload() {
  const ports = snapshot.mappings
    .filter((m) => m.mine)
    .map((m) => ({ port: m.port, protocol: m.protocol, enabled: m.enabled !== false, ours: !!m.ours, name: String(m.description || '').replace(/^Watchfire:\s*/, '') }));
  return { router: gw ? gw.name : '', routerFound: !!gw, localIp, externalIp: snapshot.externalIp || '', ports, error: gw ? null : lastError };
}

// ---------- tray icon (PowerShell helper, hidden) + lifecycle ----------
let trayProc = null;
let trayActive = false;
let shuttingDown = false;

function startTray() {
  if (process.platform !== 'win32') return;
  try {
    fs.mkdirSync(store.dataDir, { recursive: true });
    const script = path.join(store.dataDir, 'tray.ps1');
    fs.writeFileSync(script, '\ufeff' + readAsset('tray.ps1').toString('utf8')); // BOM so Windows PowerShell reads it as UTF-8
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let icon = '';
    try { icon = path.join(prepareWindowFiles(), 'watchfire.ico'); } catch { /* the tray draws a plain stand-in */ }
    trayProc = spawn(ps, ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(httpPort), '-IconPath', icon], { windowsHide: true, stdio: 'ignore' });
    trayProc.on('exit', () => { trayActive = false; trayProc = null; });
    trayProc.on('error', () => { trayActive = false; trayProc = null; });
  } catch { trayProc = null; }
}

const eventClients = new Set(); // open windows listening for a "quit" push
async function quitApp() {
  shuttingDown = true; // the tray sees this on its next poll, removes its icon and exits
  for (const c of eventClients) { try { c.write('event: quit\ndata: 1\n\n'); } catch { /* window already gone */ } }
  const tp = trayProc;
  if (tp) await Promise.race([new Promise((r) => tp.once('exit', r)), sleep(3500)]);
  if (tp) { try { tp.kill(); } catch { /* already gone */ } } // never leave an orphaned tray icon behind
  store.clearInstance(process.pid);
  process.exit(0);
}

// ---------- update check ----------
// Asks GitHub for Watchfire's latest release when Watchfire starts and every 12 hours (unless turned off in Settings).
// One small request with no personal details. Watchfire only shows a link: it often comes inside Emberkeep's installer,
// which owns the exe, so it never replaces itself.
const UPDATE_URL = process.env.WATCHFIRE_UPDATE_URL || 'https://api.github.com/repos/GreggsNBacon/watchfire/releases/latest';
const RELEASES_PAGE = 'https://github.com/GreggsNBacon/watchfire/releases/latest';
const update = { latest: null, available: null, checkedAt: null, error: null };
const verParts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
async function checkForUpdate() {
  try {
    const r = await fetch(UPDATE_URL, { headers: { 'User-Agent': `Watchfire/${VERSION}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/i, '');
    update.latest = latest || null;
    const page = typeof j.html_url === 'string' && /^https?:\/\//.test(j.html_url) ? j.html_url : RELEASES_PAGE;
    update.available = latest && isNewer(latest, VERSION) ? { version: latest, title: String(j.name || latest), pageUrl: page } : null;
    update.error = null;
  } catch (e) {
    update.error = `Couldn't check for updates: ${e.message}`;
  }
  update.checkedAt = new Date().toISOString();
  return update;
}
function startUpdateChecks() {
  const tick = () => { if (store.loadPrefs().checkUpdates) checkForUpdate().catch(() => {}); };
  setTimeout(tick, 20000); // after start-up has settled
  setInterval(tick, 12 * 60 * 60 * 1000);
}

async function settingsPayload() {
  return {
    checkUpdates: store.loadPrefs().checkUpdates,
    update,
    hasSgdbKey: !!art.getSgdbKey(),
    restore: store.loadPrefs().restore,
    theme: store.loadPrefs().theme,
    version: VERSION,
    favs: store.loadPrefs().favs,
    collapsed: store.loadPrefs().collapsed,
    canStartup: !!sea && !headless, // only the packaged exe/binary has a stable path to register
    startup: await startupEnabled(),
    platform: process.platform,
    trayActive,
  };
}

// ---------- http ----------
let lastPing = Date.now();
let everPinged = false;
let byeTimer = null;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, max = 1e5) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > max) { req.destroy(); reject(new Error('Request too large')); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function hostOk(req) {
  return [`127.0.0.1:${httpPort}`, `localhost:${httpPort}`].includes(req.headers.host);
}
function originOk(req) {
  const o = req.headers.origin;
  return !o || o === `http://127.0.0.1:${httpPort}` || o === `http://localhost:${httpPort}`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 403, { error: 'Bad host' }); // blocks DNS-rebinding
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      // The saved theme goes straight into the page, so it never flashes the wrong colours while loading.
      return res.end(readAsset('public/index.html').toString('utf8').replace('<html lang="en">', `<html lang="en" data-theme="${store.loadPrefs().theme}">`));
    }
    if (req.method === 'GET' && (url.pathname === '/logo.svg' || url.pathname === '/favicon.ico')) {
      const svg = url.pathname === '/logo.svg';
      res.writeHead(200, { 'Content-Type': svg ? 'image/svg+xml' : 'image/x-icon', 'Cache-Control': 'max-age=3600' });
      return res.end(readAsset(svg ? 'assets/watchfire.svg' : 'assets/watchfire.ico'));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/art/')) {
      const hit = art.readCached(url.pathname.slice(5));
      if (!hit) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': hit.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(hit.buf);
    }

    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    if (req.method === 'POST') {
      if (!originOk(req)) return send(res, 403, { error: 'Bad origin' });
      if (url.pathname !== '/api/bye' && req.headers['x-watchfire'] !== '1' && req.headers['x-porthop'] !== '1') return send(res, 403, { error: 'Missing header' }); // CSRF guard
    }

    if (req.method === 'GET' && url.pathname === '/api/ping') {
      lastPing = Date.now(); everPinged = true;
      if (byeTimer) { clearTimeout(byeTimer); byeTimer = null; }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') { // server-sent events: lets Watchfire close its window on quit, no polling
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      eventClients.add(res);
      req.on('close', () => eventClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/bye') {
      // Closing the window only ends the app when there's no tray icon to keep it alive (and let you quit it).
      if (!trayActive) byeTimer = setTimeout(() => process.exit(0), 4000); // cancelled by a ping if it was only a reload
      return send(res, 200, { ok: true });
    }
    // Second launches and companion apps (Emberkeep) use this to detect us. api: bumped when the companion API changes.
    if (req.method === 'GET' && url.pathname === '/api/hello') return send(res, 200, { app: 'watchfire', version: VERSION, api: 1 });
    if (req.method === 'GET' && url.pathname === '/api/forwarded') return send(res, 200, forwardedPayload());
    if (req.method === 'GET' && url.pathname === '/api/tray') return send(res, 200, trayData());
    if (req.method === 'POST' && url.pathname === '/api/tray/ready') { trayActive = true; return send(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/window') return send(res, 200, { show: windowShowSeq }); // polled by Watchfire's own window
    if (req.method === 'POST' && url.pathname === '/api/show') {
      if (windowProc) windowShowSeq++; // Watchfire's own window is open: bring it to the front
      else if (Date.now() - lastPing > 10000) openWindow(`http://127.0.0.1:${httpPort}/`); // a browser window is already up: leave it alone
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/quit') {
      const body = await readJson(req);
      if (body.closeForwards) { try { await removeAllOurs(); } catch { /* quit anyway */ } }
      send(res, 200, { ok: true });
      setTimeout(quitApp, 50);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/remove-all') {
      const results = await removeAllOurs();
      refreshSnapshot().catch(() => {});
      return send(res, 200, { results });
    }
    if (req.method === 'GET' && url.pathname === '/api/games') return send(res, 200, loadGames());
    if (req.method === 'POST' && url.pathname === '/api/game/save') {
      const body = await readJson(req);
      const fields = cleanGameInput(body);
      const data = store.load();
      let id = body.id ? String(body.id) : '';
      if (!id) {
        if (data.userGames.length >= 100) return send(res, 400, { error: 'Too many custom games' });
        id = `u-${slug(fields.name).slice(0, 40) || 'game'}-${crypto.randomBytes(2).toString('hex')}`;
        data.userGames.push({ id, ...fields });
      } else if (builtInGames().some((g) => g.id === id)) {
        data.overrides[id] = fields;
      } else {
        const i = data.userGames.findIndex((g) => g.id === id);
        if (i < 0) return send(res, 404, { error: 'Unknown game' });
        data.userGames[i] = { id, ...fields };
      }
      store.save(data);
      artMisses.delete(id);
      return send(res, 200, { id });
    }
    if (req.method === 'POST' && url.pathname === '/api/game/reset') { // built-in: drop edits; custom: delete game
      const { id } = await readJson(req);
      const data = store.load();
      delete data.overrides[id];
      data.userGames = data.userGames.filter((g) => g.id !== id);
      store.save(data);
      art.removeCustomCover(String(id));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/game/cover') {
      const body = await readJson(req, 8e6);
      if (!loadGames().some((g) => g.id === body.id)) return send(res, 404, { error: 'Unknown game' });
      art.saveCustomCover(String(body.id), Buffer.from(String(body.data || ''), 'base64'));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/game/cover-reset') {
      const { id } = await readJson(req);
      art.removeCustomCover(String(id));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/running') {
      try { return send(res, 200, { running: await detect.detectRunning(loadGames()) }); }
      catch (e) { return send(res, 200, { running: [], error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') return send(res, 200, await settingsPayload());
    if (req.method === 'GET' && url.pathname === '/api/update') return send(res, 200, { enabled: store.loadPrefs().checkUpdates, current: VERSION, ...update });
    if (req.method === 'POST' && url.pathname === '/api/update/check') return send(res, 200, { enabled: store.loadPrefs().checkUpdates, current: VERSION, ...(await checkForUpdate()) });
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(req);
      if ('sgdbKey' in body) { art.setSgdbKey(body.sgdbKey); artMisses.clear(); }
      if ('restore' in body) store.savePrefs({ restore: !!body.restore });
      const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 80).slice(0, 300) : []);
      if ('favs' in body) store.savePrefs({ favs: strList(body.favs) });
      if ('collapsed' in body) store.savePrefs({ collapsed: strList(body.collapsed) });
      if ('theme' in body) store.savePrefs({ theme: String(body.theme) });
      if ('checkUpdates' in body) {
        store.savePrefs({ checkUpdates: !!body.checkUpdates });
        if (body.checkUpdates && !update.checkedAt) checkForUpdate().catch(() => {});
      }
      if ('startup' in body) {
        if (!sea) return send(res, 400, { error: 'Starting with the system is only available in the packaged Watchfire build.' });
        await autostart.setEnabled(!!body.startup, process.execPath);
        startupCache = null; // re-read what actually got written
      }
      return send(res, 200, await settingsPayload());
    }
    if (req.method === 'POST' && url.pathname === '/api/art/fetch') {
      const body = await readJson(req);
      let entry;
      if (body.gameId) {
        const g = loadGames().find((x) => x.id === body.gameId);
        if (!g) return send(res, 404, { error: 'Unknown game' });
        entry = { id: g.id, name: g.name, steam: g.steam };
      } else {
        const name = String(body.name || '').trim().slice(0, 60);
        if (name.length < 2) return send(res, 400, { error: 'Name too short' });
        entry = { id: 'c-' + slug(name), name };
      }
      if (art.readCached(entry.id)) return send(res, 200, { ok: true });
      if (artMisses.has(entry.id)) return send(res, 200, { ok: false });
      const ok = await enqueueArt(() => art.fetchArt(entry)).catch(() => false);
      if (!ok) artMisses.add(entry.id);
      return send(res, 200, { ok });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await status());
    if (req.method === 'POST' && url.pathname === '/api/rescan') { await ensureGateway(true); return send(res, 200, await status()); }

    if (req.method === 'GET' && url.pathname === '/api/mappings') {
      const g = await ensureGateway();
      if (!g) return send(res, 200, { mappings: [], error: lastError });
      return send(res, 200, await gatherMappings(g));
    }
    if (req.method === 'POST' && url.pathname === '/api/remove-entry') { // per-row Remove in the table (any mapping that points at this PC)
      const body = await readJson(req);
      const ports = expandEntries([[String(body.protocol), String(body.port)]]);
      const results = await removePorts(ports, { force: true });
      refreshSnapshot().catch(() => {});
      return send(res, 200, { results });
    }

    if (req.method === 'POST' && (url.pathname === '/api/forward' || url.pathname === '/api/remove')) {
      const body = await readJson(req);
      let name, ports;
      if (body.gameId) {
        const game = loadGames().find((g) => g.id === body.gameId);
        if (!game) return send(res, 404, { error: 'Unknown game' });
        name = game.name; ports = game.expanded;
      } else {
        if (!Array.isArray(body.entries) || !body.entries.length) return send(res, 400, { error: 'No ports given' });
        name = String(body.name || 'custom');
        ports = expandEntries(body.entries.map((e) => [e.proto, e.range]));
      }
      const results = url.pathname === '/api/forward' ? await forwardPorts(name, ports) : await removePorts(ports);
      refreshSnapshot().catch(() => {}); // keep the tray menu current
      return send(res, 200, { results });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// ---------- launch ----------
const IS_WIN = process.platform === 'win32';
// A Linux box with no display (e.g. a game server over SSH): no window, just print the URL.
const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

function findInPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) { const p = path.join(dir, n); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  }
  return null;
}

function launch(file, args) {
  try { const c = spawn(file, args, { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch { /* ignore */ }
}

// ---------- Watchfire's own window (Windows) ----------
// window.ps1 shows the UI in WebView2 with a dark title bar and Watchfire's icon. Its files are unpacked next to the
// app's data; if WebView2 isn't available it exits with code 3 and Watchfire falls back to an Edge/Chrome app window.
let windowProc = null;
let windowShowSeq = 0;
const WINDOW_FILES = ['vendor/webview2/Microsoft.Web.WebView2.Core.dll', 'vendor/webview2/Microsoft.Web.WebView2.WinForms.dll',
  'vendor/webview2/WebView2Loader.dll', 'assets/watchfire.ico', 'window.ps1'];

function prepareWindowFiles() {
  const dir = path.join(store.dataDir, 'window');
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of WINDOW_FILES) {
    let data = readAsset(rel);
    if (rel.endsWith('.ps1')) data = Buffer.concat([Buffer.from('\ufeff'), data]); // BOM so Windows PowerShell reads it as UTF-8
    const target = path.join(dir, path.basename(rel));
    let same = false;
    try { same = fs.readFileSync(target).equals(data); } catch { /* not there yet */ }
    if (!same) {
      try { fs.writeFileSync(target, data); } catch (e) { if (!fs.existsSync(target)) throw e; /* in use by an open window: keep it */ }
    }
  }
  return dir;
}

function openNativeWindow(url) {
  if ((process.env.WATCHFIRE_BROWSER_WINDOW || process.env.PORTHOP_BROWSER_WINDOW)) return false; // escape hatch: always use the browser's app window
  let dir;
  try { dir = prepareWindowFiles(); } catch { return false; }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let proc;
  try {
    proc = spawn(ps, ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'window.ps1'),
      '-Port', String(httpPort), '-Dir', dir, '-DataDir', path.join(store.dataDir, 'WebView2')], { windowsHide: true, stdio: 'ignore' });
  } catch { return false; }
  windowProc = proc;
  const started = Date.now();
  proc.on('error', () => { if (windowProc === proc) { windowProc = null; openBrowserWindow(url); } });
  proc.on('exit', (code) => {
    if (windowProc !== proc) return;
    windowProc = null;
    // No WebView2 on this PC (code 3), or the window died before the page ever loaded: use a browser window instead.
    if (code === 3 || (code !== 0 && lastPing < started)) { openBrowserWindow(url); return; }
    // Closing the window ends the app when there's no tray icon to keep it running (opening a new window cancels this).
    if (!trayActive && !shuttingDown) { clearTimeout(byeTimer); byeTimer = setTimeout(() => { if (!windowProc) process.exit(0); }, 4000); }
  });
  return true;
}

function openWindow(url) {
  if (headless) return;
  if (IS_WIN) {
    if (windowProc) { windowShowSeq++; return; } // already open: bring it to the front
    if (openNativeWindow(url)) return;
  }
  openBrowserWindow(url);
}

function openBrowserWindow(url) {
  if (headless) return;
  if (IS_WIN) {
    const candidates = [
      process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const exe = candidates.find((p) => p && fs.existsSync(p));
    if (exe) launch(exe, [`--app=${url}`, '--window-size=1180,800']);
    else launch('cmd', ['/c', 'start', '', url]);
  } else if (process.platform === 'darwin') {
    launch('open', [url]);
  } else {
    // A Chromium-family browser gives the borderless app window; anything else falls back to the default browser.
    const exe = findInPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'brave']);
    if (exe) launch(exe, [`--app=${url}`, '--window-size=1180,800']);
    else launch('xdg-open', [url]);
  }
}

function httpLocal(port, method, pathName) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, timeout: 1500, headers: method === 'POST' ? { 'X-Watchfire': '1', 'Content-Length': 0 } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

(async function main() {
  const background = process.argv.includes('--background'); // started with Windows: tray only, no window
  // Single instance: if Watchfire is already running, hand over to it (open its window) and quit.
  const other = store.readInstance();
  if (other && other.pid !== process.pid) {
    const hello = await httpLocal(other.port, 'GET', '/api/hello');
    if (hello && hello.app === 'watchfire') {
      if (!background) await httpLocal(other.port, 'POST', '/api/show');
      process.exit(0);
    }
  }

  const pi = process.argv.indexOf('--port'); // optional fixed port (handy for SSH tunnels to a headless box)
  const wantPort = pi > 0 ? Math.max(0, Math.min(65535, parseInt(process.argv[pi + 1], 10) || 0)) : 0;
  server.listen(wantPort, '127.0.0.1', () => {
    httpPort = server.address().port;
    const url = `http://127.0.0.1:${httpPort}/`;
    store.writeInstance({ port: httpPort, pid: process.pid });
    process.on('exit', () => store.clearInstance(process.pid));
    if (!sea || !IS_WIN || headless) console.log(`Watchfire running at ${url}${headless ? '  (no display detected: open this in a browser, e.g. through an SSH tunnel)' : ''}`);

    bootstrap().catch(() => {});
    startupEnabled().catch(() => {}); // warm the cache so the tray's first menu is right
    setInterval(() => refreshSnapshot().catch(() => {}), 60000);
    startUpdateChecks();

    if (!process.argv.includes('--no-tray')) startTray();
    if (!process.argv.includes('--no-window') && !background) openWindow(url);
    // If the tray couldn't start, a background launch would be invisible and unkillable, so show the window instead.
    if (background) setTimeout(() => { if (!trayActive && !shuttingDown) openWindow(url); }, 20000);
  });
})();

// Without a tray icon the app follows its window: no heartbeat for a while means it was closed.
setInterval(() => {
  if (trayActive || shuttingDown || headless) return; // headless: there is no window to follow, keep running until quit
  const idle = Date.now() - lastPing;
  if ((everPinged && idle > 180000) || (!everPinged && idle > 120000)) process.exit(0);
}, 5000);
