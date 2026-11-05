'use strict';
// Minimal dependency-free UPnP IGD client: SSDP discovery + SOAP port mapping.
const dgram = require('dgram');
const os = require('os');
const http = require('http');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
];

function isPrivateHost(host) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function unesc(v) {
  return String(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function tag(xml, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? unesc(m[1].trim()) : '';
}

function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    // Tests may run the fake router on loopback (no firewall prompt); only when the test hook is set.
    const testLoopback = !!process.env.PORTHOP_TEST_GATEWAY && u.hostname === '127.0.0.1';
    if (!isPrivateHost(u.hostname) && !testLoopback) return reject(new Error('Refusing non-LAN gateway address'));
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 1e6) req.destroy(new Error('Response too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Router request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function ssdpSearch(timeoutMs = 3000) {
  const ifaces = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) ifaces.push(i.address);
    }
  }
  return new Promise((resolve) => {
    const found = new Set();
    const sockets = [];
    for (const addr of ifaces) {
      try {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sockets.push(s);
        s.on('error', () => {});
        s.on('message', (msg) => {
          const m = /^location:\s*(.+)$/im.exec(msg.toString());
          if (m) found.add(m[1].trim());
        });
        s.bind(0, addr, () => {
          try { s.setMulticastInterface(addr); } catch { /* ignore */ }
          for (const st of SEARCH_TARGETS) {
            const pkt = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
            s.send(pkt, SSDP_PORT, SSDP_ADDR, () => {});
            setTimeout(() => s.send(pkt, SSDP_PORT, SSDP_ADDR, () => {}), 700);
          }
        });
      } catch { /* ignore this interface */ }
    }
    setTimeout(() => {
      sockets.forEach((s) => { try { s.close(); } catch { /* ignore */ } });
      resolve([...found]);
    }, timeoutMs);
  });
}

async function describe(location) {
  const res = await request(location);
  if (res.status !== 200) throw new Error(`Description HTTP ${res.status}`);
  const xml = res.body;
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => ({
    serviceType: tag(m[1], 'serviceType'),
    controlURL: tag(m[1], 'controlURL'),
  }));
  const base = new URL(location);
  const name = [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' ') || tag(xml, 'friendlyName') || 'Router';
  // Routers often list several WAN services (IP and PPP, or an unused second WAN). Only the one that is actually
  // connected applies mappings; the others accept AddPortMapping and silently do nothing. So probe each.
  const cands = [];
  for (const s of services.filter((x) => /:(WANIPConnection|WANPPPConnection):/i.test(x.serviceType))) {
    const controlUrl = new URL(s.controlURL, base).toString();
    if (new URL(controlUrl).hostname !== base.hostname) continue;
    cands.push({ location, host: base.hostname, controlUrl, serviceType: s.serviceType, name });
  }
  if (!cands.length) return null;
  for (const c of cands) {
    try {
      const ip = await getExternalIp(c);
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0') { c.alts = cands.filter((x) => x !== c); return c; }
    } catch { /* try the next service */ }
  }
  cands[0].alts = cands.slice(1);
  return cands[0];
}

async function discover() {
  const locations = await ssdpSearch();
  for (const loc of locations) {
    try {
      const gw = await describe(loc);
      if (gw) return gw;
    } catch { /* try next */ }
  }
  return null;
}

class UpnpError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function soap(gw, action, args = {}) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${gw.serviceType}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const res = await request(gw.controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(body),
      SOAPAction: `"${gw.serviceType}#${action}"`,
    },
    body,
  });
  if (res.status !== 200) {
    const code = parseInt(tag(res.body, 'errorCode'), 10) || res.status;
    throw new UpnpError(tag(res.body, 'errorDescription') || `Router returned HTTP ${res.status}`, code);
  }
  return res.body;
}

async function getExternalIp(gw) {
  return tag(await soap(gw, 'GetExternalIPAddress'), 'NewExternalIPAddress');
}

async function addMapping(gw, { port, protocol, internalClient, description }) {
  const args = {
    NewRemoteHost: '',
    NewExternalPort: port,
    NewProtocol: protocol,
    NewInternalPort: port,
    NewInternalClient: internalClient,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: 0,
  };
  try {
    await soap(gw, 'AddPortMapping', args);
  } catch (e) {
    if (e.code === 718) throw e; // conflict: no point retrying
    await soap(gw, 'AddPortMapping', { ...args, NewLeaseDuration: 86400 }); // some routers refuse permanent leases
  }
}

async function deleteMapping(gw, { port, protocol }) {
  await soap(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol });
}

// Direct lookup of one mapping. Many routers support this even when they refuse to enumerate the table.
async function getSpecificMapping(gw, { port, protocol }) {
  const x = await soap(gw, 'GetSpecificPortMappingEntry', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol });
  return {
    port,
    protocol,
    internalPort: parseInt(tag(x, 'NewInternalPort'), 10),
    internalClient: tag(x, 'NewInternalClient'),
    enabled: tag(x, 'NewEnabled') !== '0',
    description: tag(x, 'NewPortMappingDescription'),
  };
}

// Returns { entries, error }. `error` is set when the router refuses/fails to enumerate (as opposed to simply reaching the end).
async function listMappings(gw, max = 256) {
  const out = [];
  let error = null;
  for (let i = 0; i < max; i++) {
    try {
      const x = await soap(gw, 'GetGenericPortMappingEntry', { NewPortMappingIndex: i });
      out.push({
        port: parseInt(tag(x, 'NewExternalPort'), 10),
        protocol: tag(x, 'NewProtocol').toUpperCase(),
        internalPort: parseInt(tag(x, 'NewInternalPort'), 10),
        internalClient: tag(x, 'NewInternalClient'),
        enabled: tag(x, 'NewEnabled') !== '0',
        description: tag(x, 'NewPortMappingDescription'),
      });
    } catch (e) {
      // End-of-table is signalled as 713/714/402, or a bare HTTP 500 once we're past the first entry.
      const end = e.code === 713 || e.code === 714 || e.code === 402 || (e.code === 500 && i > 0);
      if (!end) error = { code: e.code, message: e.message };
      break;
    }
  }
  return { entries: out, error };
}

function localIpFor(host) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.on('error', (e) => { try { s.close(); } catch { /* ignore */ } reject(e); });
    s.connect(1900, host, () => {
      const a = s.address().address;
      s.close();
      resolve(a);
    });
  });
}

module.exports = { describeAt: describe, discover, getExternalIp, addMapping, deleteMapping, listMappings, getSpecificMapping, localIpFor, UpnpError, isPrivateHost };
