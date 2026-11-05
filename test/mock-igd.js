'use strict';
// Fake UPnP router for local testing. Mimics routers that refuse to enumerate (GetGenericPortMappingEntry -> 606)
// but still answer GetSpecificPortMappingEntry. Usage: node mock-igd.js <bindIp> [rewrite]
const http = require('http');
const [bindIp, mode] = [process.argv[2], process.argv[3]];
const SVC = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const table = new Map();

const env = (inner) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
const fault = (code, desc) => env(`<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault>`);
const val = (x, k) => (new RegExp(`<${k}>([^<]*)</${k}>`).exec(x) || [])[1] || '';

http.createServer((req, res) => {
  if (req.url === '/desc.xml') {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(`<?xml version="1.0"?><root><device><manufacturer>MockCo</manufacturer><modelName>FakeGate 5690</modelName><serviceList><service><serviceType>${SVC}</serviceType><controlURL>/ctl</controlURL></service></serviceList></device></root>`);
  }
  if (req.url === '/_clear') { table.clear(); res.writeHead(200); return res.end('cleared'); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const action = /#(\w+)"?$/.exec(req.headers.soapaction || '')?.[1];
    const key = `${val(body, 'NewProtocol')}/${val(body, 'NewExternalPort')}`;
    const ok = (inner) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(env(inner)); };
    const err = (c, d) => { res.writeHead(500, { 'Content-Type': 'text/xml' }); res.end(fault(c, d)); };
    if (action === 'GetExternalIPAddress') return ok(`<u:GetExternalIPAddressResponse xmlns:u="${SVC}"><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:GetExternalIPAddressResponse>`);
    if (action === 'AddPortMapping') {
      table.set(key, { client: val(body, 'NewInternalClient'), port: val(body, 'NewInternalPort'), desc: mode === 'rewrite' ? 'rewritten' : val(body, 'NewPortMappingDescription') });
      return ok(`<u:AddPortMappingResponse xmlns:u="${SVC}"/>`);
    }
    if (action === 'DeletePortMapping') return table.delete(key) ? ok(`<u:DeletePortMappingResponse xmlns:u="${SVC}"/>`) : err(714, 'NoSuchEntryInArray');
    if (action === 'GetSpecificPortMappingEntry') {
      const e = table.get(key);
      return e ? ok(`<u:GetSpecificPortMappingEntryResponse xmlns:u="${SVC}"><NewInternalPort>${e.port}</NewInternalPort><NewInternalClient>${e.client}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>${e.desc}</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration></u:GetSpecificPortMappingEntryResponse>`) : err(714, 'NoSuchEntryInArray');
    }
    if (action === 'GetGenericPortMappingEntry') return err(606, 'Action not authorized'); // the suspected behaviour
    err(401, 'Invalid Action');
  });
}).listen(0, bindIp, function () { console.log(`http://${bindIp}:${this.address().port}/desc.xml`); });
