/**
 * LIVE end-to-end test of the three-input viral workflow against a RUNNING backend.
 * Uses the real vision CLI (your Antigravity quota) and the real internet.
 *
 *   node scripts/live/viral-e2e.js --base http://127.0.0.1:3000 --reference <ref.png> --reaction <reaction.jpg> --punchline "..." [--context "..."] [--out <dir>]
 *
 * Prints the decisions from the generation report and saves the output PNG.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const base = new URL(arg('base', 'http://127.0.0.1:3000'));
const reference = arg('reference');
const reaction = arg('reaction');
const punchline = arg('punchline');
const context = arg('context');
const outDir = arg('out', path.join(process.cwd(), 'live-e2e-output'));
if (!reference || !reaction || !punchline) {
  console.error('usage: --reference <file> --reaction <file> --punchline "<text>" [--base url] [--context text] [--out dir]');
  process.exit(2);
}

function multipart(fields, files) {
  const boundary = '----memeE2E' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n`));
    parts.push(Buffer.from(String(v), 'utf8'));
    parts.push(Buffer.from('\r\n'));
  }
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${path.basename(f.path)}"\r\nContent-Type: ${type}\r\n\r\n`));
    parts.push(fs.readFileSync(f.path));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// The server needs a signed-in session: copy the me_session cookie from your browser (dev tools > Application > Cookies)
// and pass it as  SESSION_COOKIE="me_session=<value>"  (or start a scratch server with AUTH_ENABLED=false).
const withSession = h => (process.env.SESSION_COOKIE ? { ...h, Cookie: process.env.SESSION_COOKIE } : h);

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: base.hostname, port: base.port, method, path: p, headers: withSession(headers) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const fields = { punchline };
  if (context) fields.reactionContext = context;
  const mp = multipart(fields, [
    { field: 'referenceImage', path: reference },
    { field: 'reactionImage', path: reaction }
  ]);
  const started = Date.now();
  console.log(`POST /api/memes/adapt-viral  reference=${path.basename(reference)} reaction=${path.basename(reaction)}`);
  const res = await request('POST', '/api/memes/adapt-viral', mp.body, { 'Content-Type': mp.contentType, 'Content-Length': mp.body.length });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  let data;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch {
    data = { raw: res.body.toString('utf8').slice(0, 500) };
  }
  console.log(`HTTP ${res.status} after ${secs}s`);
  if (res.status !== 201) {
    console.log(JSON.stringify(data, null, 2).slice(0, 6000));
    process.exit(1);
  }
  console.log(`punchline stored exactly: ${data.content?.punchline === punchline.trim()}`);
  console.log(`adaptationMetadata: ${JSON.stringify(data.adaptationMetadata, null, 1).slice(0, 2500)}`);

  const rep = await request('GET', `/api/memes/${data.memeId}/report`);
  const report = JSON.parse(rep.body.toString('utf8')).report;
  console.log(`\nstage timings: ${JSON.stringify(report.stageTimings)}  total=${report.durationMs}ms`);
  console.log(`analysis: format=${report.referenceAnalysis.memeFormat} rows=${JSON.stringify(report.referenceAnalysis.grid.columnsPerRow)} header=${JSON.stringify(report.referenceAnalysis.header.text)}`);
  for (const id of report.identities) {
    console.log(`identity ${id.slotId}: written=${JSON.stringify(id.nameAsWritten)} ai=${JSON.stringify(id.aiIdentifiedName)} -> ${id.resolvedName} [${id.method}, ${id.confidence}]`);
  }
  for (const s of report.slots) {
    console.log(`\nslot ${s.slotId} "${s.subject}" wants ${s.desiredImageType} ctx=${JSON.stringify(s.context)} rounds=${s.rounds} candidates=${s.candidatesConsidered} downloads=${s.downloads} visualChecks=${s.visualChecks} ${s.durationMs}ms`);
    console.log(`  entity: ${JSON.stringify(s.entity || null)}`);
    console.log(`  queries: ${s.queries.map(q => q.query).join(' | ')}`);
    if (s.droppedSearchTerms?.length) console.log(`  dropped ungrounded AI terms: ${s.droppedSearchTerms.join(' | ')}`);
    if (s.providerErrors?.length) console.log(`  provider errors: ${JSON.stringify(s.providerErrors).slice(0, 400)}`);
    const sel = s.selected;
    console.log(`  SELECTED: "${sel.title}" (${sel.provider}) ${sel.width}x${sel.height} final=${sel.finalScore} license=${sel.license}`);
    console.log(`    scores: ${JSON.stringify({ id: sel.scores.identity, ctx: sel.scores.context, type: sel.scores.type, res: sel.scores.resolution, asp: sel.scores.aspect, inferred: sel.scores.inferredType })}`);
    console.log(`    visual: ${sel.visual ? `${sel.visual.verdict} ${sel.visual.confidence} type=${sel.visual.imageType} subject=${sel.visual.showsIntendedSubject} ref=${sel.visual.matchesReferencePerson} :: ${sel.visual.reason}` : 'n/a'}`);
    console.log(`  alternates: ${s.alternates.length}  rejected (top 4): ${s.rejected.slice(0, 4).map(r => `[${r.provider}] ${r.title.slice(0, 50)} -> ${r.reason}`).join(' || ')}`);
    if (s.warnings.length) console.log(`  warnings: ${s.warnings.join(' | ')}`);
  }
  console.log(`\nvision calls: ${report.visionCalls.map(c => `${c.purpose}:${c.ok ? 'ok' : 'fail'}:${Math.round(c.durationMs / 1000)}s`).join(', ')}`);
  console.log(`warnings: ${JSON.stringify(report.warnings)}`);
  console.log(`render: ${JSON.stringify(report.render)}`);

  fs.mkdirSync(outDir, { recursive: true });
  const png = await request('GET', data.outputUrls.png);
  const outFile = path.join(outDir, `${path.basename(reference, path.extname(reference))}__${data.memeId.slice(0, 8)}.png`);
  fs.writeFileSync(outFile, png.body);
  console.log(`\nsaved output: ${outFile}  (memeId ${data.memeId})`);
})().catch(e => {
  console.error('E2E error:', e);
  process.exit(1);
});
