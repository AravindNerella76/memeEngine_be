/**
 * LIVE regeneration test against a RUNNING backend (uses the vision CLI for instruction parsing).
 *
 *   node scripts/live/regenerate-e2e.js --base http://127.0.0.1:3000 --meme <memeId> --instruction "Make the headline bigger" [--instruction "..."]
 *   add --restore <n> to restore a version at the end.
 */
const http = require('http');

const argv = process.argv.slice(2);
const get = n => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const all = n => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const base = new URL(get('base') || 'http://127.0.0.1:3000');
const memeId = get('meme');

// Needs a signed-in session: SESSION_COOKIE="me_session=<value>" (copy it from the browser), or a scratch server with AUTH_ENABLED=false.
const withSession = h => (process.env.SESSION_COOKIE ? { ...h, Cookie: process.env.SESSION_COOKIE } : h);

function call(method, p, obj) {
  return new Promise((resolve, reject) => {
    const body = obj ? Buffer.from(JSON.stringify(obj)) : null;
    const req = http.request({ host: base.hostname, port: base.port, method, path: p, headers: withSession(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try {
          j = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, json: j, text: t });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const before = await call('GET', `/api/memes/${memeId}`);
  const punchline = before.json.content.punchline;
  console.log(`meme ${memeId}: current v${before.json.currentVersion}, ${before.json.versions.length} versions`);
  for (const instruction of all('instruction')) {
    const t0 = Date.now();
    const r = await call('POST', `/api/memes/${memeId}/regenerate`, { instruction });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status === 201) {
      const v = r.json.versions[r.json.versions.length - 1];
      console.log(`\n"${instruction}" -> 201 in ${secs}s: v${r.json.currentVersion} via ${v.interpreter}; changes: ${JSON.stringify(v.appliedChanges)}`);
      console.log(`   textScales=${JSON.stringify(r.json.design.textScales)} fontSizeScale=${r.json.design.fontSizeScale} reactionHeightRatio=${r.json.layout.reactionHeightRatio} outline=${r.json.design.outlineThickness}`);
      console.log(`   punchline unchanged: ${r.json.content.punchline === punchline}; reaction image unchanged: ${r.json.assets.reactionImage.path === before.json.assets.reactionImage.path}`);
      console.log(`   subject sources: ${r.json.assets.subjectImages.map(a => (a.originalName || '').slice(0, 40)).join(' | ')}`);
    } else {
      console.log(`\n"${instruction}" -> HTTP ${r.status} in ${secs}s: ${JSON.stringify(r.json || r.text).slice(0, 400)}`);
    }
  }
  const restore = get('restore');
  if (restore) {
    const r = await call('POST', `/api/memes/${memeId}/restore/${restore}`);
    console.log(`\nrestore v${restore} -> ${r.status}; current v${r.json?.currentVersion}; subject sources: ${(r.json?.assets?.subjectImages || []).map(a => (a.originalName || '').slice(0, 40)).join(' | ')}`);
    const after = await call('POST', `/api/memes/${memeId}/regenerate`, { instruction: 'make the outline thicker' });
    const nums = (after.json?.versions || []).map(v => v.versionNumber);
    console.log(`regenerate after restore -> ${after.status}; version numbers: ${JSON.stringify(nums)}; unique: ${new Set(nums).size === nums.length}`);
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
