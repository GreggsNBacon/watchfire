'use strict';
// Downloads cover art for every game in games.json into ./art so `node build.js` can embed it in the exe.
// Usage:  node fetch-art.js            (add --force to re-download everything)
// For best coverage set a free SteamGridDB key first:  $env:WATCHFIRE_SGDB_KEY = "yourkey"
// Without a key, Steam's public CDN is used (Steam games only).
const fs = require('fs');
const path = require('path');
const art = require('./art');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const games = JSON.parse(fs.readFileSync(path.join(__dirname, 'games.json'), 'utf8'));
const dest = path.join(__dirname, 'art');
const force = process.argv.includes('--force');

(async () => {
  console.log(art.getSgdbKey() ? 'Using SteamGridDB + Steam CDN' : 'No SteamGridDB key found — Steam CDN only (non-Steam games will be skipped)');
  let ok = 0, miss = [];
  for (const g of games) {
    const id = slug(g.name);
    if (!force && fs.existsSync(path.join(dest, id + '.img'))) { ok++; continue; }
    const got = await art.fetchArt({ id, name: g.name, steam: g.steam }, dest).catch(() => false);
    console.log((got ? 'ok    ' : 'MISS  ') + g.name);
    got ? ok++ : miss.push(g.name);
  }
  console.log(`\n${ok}/${games.length} covers in ${dest}`);
  if (miss.length) console.log('Missing: ' + miss.join(', '));
  console.log('Now run: node build.js');
})();
