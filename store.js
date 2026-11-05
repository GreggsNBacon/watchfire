'use strict';
// Per-user game customisations (survives rebuilds). Lives in %LOCALAPPDATA%\PortHop\games-user.json
//   overrides: { [builtInGameId]: { name?, category?, ports?, procs?, note? } }
//   userGames: [ { id, name, category, ports, procs, note } ]
const fs = require('fs');
const path = require('path');
const os = require('os');

const dataDir = path.join(process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'PortHop');
const file = path.join(dataDir, 'games-user.json');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      overrides: j.overrides && typeof j.overrides === 'object' ? j.overrides : {},
      userGames: Array.isArray(j.userGames) ? j.userGames : [],
    };
  } catch {
    return { overrides: {}, userGames: [] };
  }
}

function save(data) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Registry of ports PortHop has forwarded, so we can show/verify/remove them even if the router won't list its table.
const fwdFile = path.join(dataDir, 'forwards.json');
const MAX_FORWARDS = 150;

function loadForwards() {
  try {
    const j = JSON.parse(fs.readFileSync(fwdFile, 'utf8'));
    return (Array.isArray(j) ? j : []).filter((r) => r && Number.isInteger(r.port) && r.port > 0 && r.port < 65536 && (r.protocol === 'TCP' || r.protocol === 'UDP'))
      .map((r) => ({ port: r.port, protocol: r.protocol, name: String(r.name || '').slice(0, 40) }));
  } catch {
    return [];
  }
}

function saveForwards(list) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = fwdFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-MAX_FORWARDS), null, 2));
  fs.renameSync(tmp, fwdFile);
}

// App preferences. Shares settings.json with art.js (which owns `sgdbKey`), so always read-modify-write the whole object.
const settingsFile = path.join(dataDir, 'settings.json');
function readSettingsFile() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
}
function loadPrefs() {
  const s = readSettingsFile();
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 80).slice(0, 300) : []);
  return { restore: s.restore !== false, favs: list(s.favs), collapsed: list(s.collapsed) }; // restoring forwards is on unless the user turned it off
}
function savePrefs(partial) {
  fs.mkdirSync(dataDir, { recursive: true });
  const s = { ...readSettingsFile(), ...partial };
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}

// Single-instance bookkeeping: lets a second launch hand over to the running copy instead of starting another tray icon.
const instFile = path.join(dataDir, 'instance.json');
function readInstance() {
  try { const j = JSON.parse(fs.readFileSync(instFile, 'utf8')); return Number.isInteger(j.port) ? j : null; } catch { return null; }
}
function writeInstance(info) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(instFile, JSON.stringify(info));
}
function clearInstance(pid) {
  const cur = readInstance();
  if (cur && cur.pid === pid) { try { fs.unlinkSync(instFile); } catch { /* already gone */ } }
}

module.exports = { dataDir, load, save, loadForwards, saveForwards, loadPrefs, savePrefs, readInstance, writeInstance, clearInstance };
