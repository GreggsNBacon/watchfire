'use strict';
// "Start with Windows" / "Start at login": a per-user entry, no admin needed.
//   Windows: HKCU Run key, launches the exe with --background (tray only).
//   Linux:   ~/.config/autostart/watchfire.desktop (XDG autostart), launches the binary normally.
// Watchfire was called PortHop: an entry left under that name is moved to the new one the first time it's checked.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'Watchfire';
const LEGACY_NAME = 'PortHop';
const autostartDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
const desktopFile = path.join(autostartDir, 'watchfire.desktop');
const legacyDesktopFile = path.join(autostartDir, 'porthop.desktop');

function run(args) {
  return new Promise((resolve) => {
    execFile(reg, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}

// True only if the entry exists AND points at this exe (so a moved/renamed exe reads as "off" and can be re-enabled).
async function isEnabled(exePath) {
  if (!IS_WIN) {
    try { if (fs.readFileSync(desktopFile, 'utf8').includes(`Exec="${exePath}"`)) return true; } catch { /* not set */ }
    if (fs.existsSync(legacyDesktopFile)) { await setEnabled(true, exePath); return true; } // carry PortHop's choice over
    return false;
  }
  const r = await run(['query', KEY, '/v', NAME]);
  if (r.ok && r.out.toLowerCase().includes(String(exePath).toLowerCase())) return true;
  // PortHop's entry: the user wanted this at startup, so keep that under the new name and exe.
  const legacy = await run(['query', KEY, '/v', LEGACY_NAME]);
  if (legacy.ok) { try { await setEnabled(true, exePath); return true; } catch { return false; } }
  return false;
}

async function setEnabled(on, exePath) {
  if (!IS_WIN) {
    try { fs.unlinkSync(legacyDesktopFile); } catch { /* wasn't set */ }
    if (!on) { try { fs.unlinkSync(desktopFile); } catch { /* wasn't set */ } return; }
    if (/[\r\n"%$`\\]/.test(exePath)) throw new Error('Unsupported binary path');
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(desktopFile, `[Desktop Entry]\nType=Application\nName=Watchfire\nComment=Game port forwarding\nExec="${exePath}"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  if (on) {
    if (/[\r\n"]/.test(exePath)) throw new Error('Unsupported exe path');
    const r = await run(['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', `"${exePath}" --background`, '/f']);
    if (!r.ok) throw new Error('Could not add the Windows startup entry');
  } else {
    await run(['delete', KEY, '/v', NAME, '/f']); // fails harmlessly if it was never set
  }
  await run(['delete', KEY, '/v', LEGACY_NAME, '/f']); // the old name, either way
}

module.exports = { isEnabled, setEnabled };
