'use strict';
// Detects locally running game servers by process name (optionally gated on a listening port).
// Reads only local state (Windows: `tasklist` + `netstat -ano`; Linux: /proc + `ss`). No network traffic.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function runCmd(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 8000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Make Windows and Linux builds of the same server comparable:
// "PalServer-Win64-Shipping-Cmd.exe" / "PalServer-Linux-Shipping" -> "palserver", "valheim_server.x86_64" -> "valheim_server"
function norm(name) {
  return String(name).toLowerCase()
    .replace(/\.(exe|sh|bin|x86_64|x86|x64)$/g, '').replace(/\.(exe|sh|bin|x86_64|x86|x64)$/g, '')
    .replace(/-(win64|linux|linuxserver)-shipping(-cmd)?$/, '');
}

async function listProcessesWin() {
  const out = await runCmd(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/fo', 'csv', '/nh']);
  const procs = []; // { names: [normalised], pid }
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) procs.push({ names: [norm(m[1])], pid: +m[2] });
  }
  return procs;
}

function listProcessesLinux() {
  const procs = [];
  let dirs = [];
  try { dirs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return procs; }
  for (const d of dirs) {
    const names = new Set();
    try { names.add(norm(fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim())); } catch { continue; } // process ended, or not readable
    try { // comm is cut at 15 chars; argv[0] / the script argument carry the full name
      const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (args[0]) names.add(norm(path.basename(args[0])));
      if (args[1] && !args[1].startsWith('-')) names.add(norm(path.basename(args[1]))); // e.g. "bash ./PalServer.sh"
    } catch { /* ignore */ }
    procs.push({ names: [...names], pid: +d });
  }
  return procs;
}

const listProcesses = () => (IS_WIN ? listProcessesWin() : Promise.resolve(listProcessesLinux()));

async function listListenersWin() {
  const out = await runCmd(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe'), ['-ano']);
  const listeners = []; // { proto, port, pid }
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'TCP' && p.length >= 5 && p[3] === 'LISTENING') listeners.push({ proto: 'TCP', port: +p[1].slice(p[1].lastIndexOf(':') + 1), pid: +p[4] });
    else if (p[0] === 'UDP' && p.length >= 4) listeners.push({ proto: 'UDP', port: +p[1].slice(p[1].lastIndexOf(':') + 1), pid: +p[3] });
  }
  return listeners;
}

async function listListenersLinux() {
  let out = '';
  for (const ss of ['ss', '/usr/sbin/ss', '/sbin/ss', '/usr/bin/ss']) {
    try { out = await runCmd(ss, ['-H', '-l', '-n', '-t', '-u', '-p']); break; } catch { /* try the next location */ }
  }
  const listeners = [];
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5) continue;
    const proto = p[0].startsWith('tcp') ? 'TCP' : p[0].startsWith('udp') ? 'UDP' : null;
    if (!proto) continue;
    const port = +p[4].slice(p[4].lastIndexOf(':') + 1);
    for (const m of line.matchAll(/pid=(\d+)/g)) listeners.push({ proto, port, pid: +m[1] });
  }
  return listeners;
}

const listListeners = () => (IS_WIN ? listListenersWin() : listListenersLinux());

// games: [{ id, procs: ["palserver", "java@25565", ...] }]. Returns [{ gameId, process }]
async function detectRunning(games) {
  const [procs, listeners] = await Promise.all([listProcesses(), listListeners().catch(() => [])]);
  const found = [];
  for (const g of games) {
    for (const spec of g.procs || []) {
      const [rawName, rawPort] = spec.toLowerCase().split('@');
      const name = norm(rawName);
      const matching = procs.filter((p) => p.names.includes(name));
      if (!matching.length) continue;
      if (rawPort) {
        const pids = new Set(matching.map((p) => p.pid));
        if (!listeners.some((l) => l.port === +rawPort && pids.has(l.pid))) continue;
      }
      found.push({ gameId: g.id, process: rawName });
      break;
    }
  }
  return found;
}

module.exports = { detectRunning, listProcesses, listListeners };
