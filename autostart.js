'use strict';
// "Start with Windows" / "Start at login": a per-user entry, no admin needed.
//   Windows: HKCU Run key, launches the exe with --background (tray only).
//   Linux:   ~/.config/autostart/porthop.desktop (XDG autostart), launches the binary normally.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'PortHop';
const desktopFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'porthop.desktop');

function run(args) {
  return new Promise((resolve) => {
    execFile(reg, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}

// True only if the entry exists AND points at this exe (so a moved/renamed exe reads as "off" and can be re-enabled).
async function isEnabled(exePath) {
  if (!IS_WIN) {
    try { return fs.readFileSync(desktopFile, 'utf8').includes(`Exec="${exePath}"`); } catch { return false; }
  }
  const r = await run(['query', KEY, '/v', NAME]);
  return r.ok && r.out.toLowerCase().includes(String(exePath).toLowerCase());
}

async function setEnabled(on, exePath) {
  if (!IS_WIN) {
    if (!on) { try { fs.unlinkSync(desktopFile); } catch { /* wasn't set */ } return; }
    if (/[\r\n"%$`\\]/.test(exePath)) throw new Error('Unsupported binary path');
    fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
    fs.writeFileSync(desktopFile, `[Desktop Entry]\nType=Application\nName=PortHop\nComment=Game port forwarding\nExec="${exePath}"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  if (on) {
    if (/[\r\n"]/.test(exePath)) throw new Error('Unsupported exe path');
    const r = await run(['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', `"${exePath}" --background`, '/f']);
    if (!r.ok) throw new Error('Could not add the Windows startup entry');
  } else {
    await run(['delete', KEY, '/v', NAME, '/f']); // fails harmlessly if it was never set
  }
}

module.exports = { isEnabled, setEnabled };
