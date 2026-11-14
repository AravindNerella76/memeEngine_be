/**
 * Security end-to-end test: attacks a RUNNING backend over HTTP and checks the files on disk.
 *
 * This script WRITES memes to the database and creates/removes files in the backend's uploads/
 * and output/ folders, so it refuses to run unless you opt in AND point it at a throw-away
 * server + database:
 *
 *   SECURITY_E2E_ALLOW=1 BASE_URL=http://127.0.0.1:3999 MONGO_URI=mongodb://127.0.0.1:27999/scratch node test-security-e2e.js
 *
 * IMPORTANT: start the server with USERPROFILE pointing at an EMPTY folder and run this with
 * E2E_NO_VISION_CLI=1, so the real vision CLI (agy) can never be launched by these tests.
 *
 * Start that scratch server with AUTH_ENABLED=false (it must stay on 127.0.0.1): these attacks target the
 * upload/path/network layers behind the sign-in guard, and the script has no session. The sign-in guard itself
 * is tested by src/tests/auth.test.ts and auth.integration.test.ts.
 *
 * It must be run from the same backend folder the server uses (it inspects uploads/ and output/).
 * "Victim" files are created in a temp folder it owns; it never touches anything else.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createCanvas } = require('@napi-rs/canvas');
const mongoose = require('mongoose');

if (process.env.SECURITY_E2E_ALLOW !== '1' || !process.env.MONGO_URI || !process.env.BASE_URL) {
  console.error('Refusing to run: set SECURITY_E2E_ALLOW=1, BASE_URL and MONGO_URI (a scratch server and database only).');
  process.exit(2);
}
const BASE = process.env.BASE_URL.replace(/\/$/, '');
const URLP = new URL(BASE);
const ROOT = __dirname;
const UPLOADS = path.join(ROOT, 'uploads');
const OUTPUT = path.join(ROOT, 'output');
const TEST_ASSETS = path.join(ROOT, 'test-assets');
const VICTIMS = path.join(ROOT, 'e2e-victims');

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
const section = t => console.log(`\n=== ${t} ===`);

// ---------- helpers ----------
function raw(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: URLP.hostname, port: URLP.port, method, path: p, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = r => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };
const api = async (method, p, obj, headers = {}) => {
  const body = obj === undefined ? undefined : (typeof obj === 'string' ? obj : JSON.stringify(obj));
  const r = await raw(method, p, { headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers }, body });
  return { ...r, data: json(r) };
};
const uploadsList = () => (fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS).filter(f => fs.statSync(path.join(UPLOADS, f)).isFile()) : []);
const memeCount = async () => (await api('GET', '/api/memes')).data.length;

function noisy(w, h) {
  const c = createCanvas(w, h); const ctx = c.getContext('2d');
  for (let i = 0; i < 400; i++) { ctx.fillStyle = `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})`; ctx.fillRect((i * 17) % w, (i * 29) % h, 40, 40); }
  return c;
}
const jpeg = (w = 640, h = 480) => noisy(w, h).toBuffer('image/jpeg');
const png = (w = 640, h = 480) => noisy(w, h).toBuffer('image/png');
const webp = (w = 640, h = 480) => noisy(w, h).toBuffer('image/webp');

async function postUpload(files, payloadObj, url = '/api/memes/upload-and-generate') {
  const fd = new FormData();
  for (const f of files) fd.append(f.field, new Blob([f.bytes], { type: f.type }), f.name);
  if (payloadObj !== null) fd.append('payload', typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj));
  try {
    const res = await fetch(BASE + url, { method: 'POST', body: fd });
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data, text };
  } catch (e) {
    return { status: 0, data: null, text: String(e.cause?.code || e.message) };
  }
}
const goodPayload = (extra = {}) => ({
  content: { topic: 'Security test', headline: 'HEADLINE', punchline: 'నా పంచ్‌లైన్ — exact text', itemLabels: ['A', 'B', 'C'] },
  layout: { memeType: 'comparison', arrangement: 'auto' },
  design: { fontFamily: 'Arial Black', teluguFontFamily: 'Ramabhadra', primaryTextColor: '#FFE500', secondaryTextColor: '#FFFFFF', outlineColor: '#000000', outlineThickness: 7, fontSizeScale: 1, shadowBlur: 8, canvasPreset: 'portrait_4_5' },
  subjectLabels: ['A', 'B', 'C'],
  ...extra
});
const rxFile = () => ({ field: 'reactionImage', bytes: jpeg(960, 540), type: 'image/jpeg', name: 'reaction.jpg' });
const oneSubject = (name, type, bytes) => [{ field: 'subjectImages', bytes, type, name }, rxFile()];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('memes');

  fs.mkdirSync(path.join(VICTIMS, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(VICTIMS, 'other'), { recursive: true });
  const decoy = path.join(VICTIMS, 'uploads', 'victim_in_decoy_uploads.jpg');   // path CONTAINS "uploads"
  const precious = path.join(VICTIMS, 'other', 'precious.png');
  fs.writeFileSync(decoy, jpeg()); fs.writeFileSync(precious, png());
  const victims = [decoy, precious];
  const testAssetsBefore = fs.readdirSync(TEST_ASSETS).sort().join(',');
  const stillThere = () => victims.every(v => fs.existsSync(v));

  // ================================================================================
  section('1. Normal use still works (JPEG + PNG + WebP uploads, generate, download, versions)');
  const created = await postUpload(
    [
      { field: 'subjectImages', bytes: jpeg(), type: 'image/jpeg', name: 'one.jpg' },
      { field: 'subjectImages', bytes: png(), type: 'image/png', name: 'two.png' },
      { field: 'subjectImages', bytes: webp(), type: 'image/webp', name: 'three.webp' },
      rxFile()
    ], goodPayload());
  check('upload-and-generate with JPEG+PNG+WebP -> 201', created.status === 201, `${created.status} ${created.text.slice(0, 200)}`);
  const M = created.data || {};
  const subj = M.assets?.subjectImages || [];
  check('three subject images stored', subj.length === 3);
  check('stored extensions match real content (.jpg .png .webp)', subj.map(s => path.extname(s.path)).join() === '.jpg,.png,.webp', subj.map(s => s.path).join(' | '));
  check('stored names are server-generated (upload_<uuid>)', subj.every(s => /^upload_[0-9a-f-]{36}\.\w+$/.test(path.basename(s.path))));
  check('stored files really are inside uploads/', subj.every(s => path.dirname(s.path).toLowerCase() === UPLOADS.toLowerCase() && fs.existsSync(s.path)));
  check('MIME types recorded from content', subj.map(s => s.mimeType).join() === 'image/jpeg,image/png,image/webp');
  check('punchline preserved exactly', M.content?.punchline === 'నా పంచ్‌లైన్ — exact text');
  const id = M.memeId;

  const dlPng = await raw('GET', `/api/memes/${id}/download/png`);
  check('download png -> 200 PNG bytes', dlPng.status === 200 && dlPng.body.subarray(1, 4).toString() === 'PNG', String(dlPng.status));
  const dlJpg = await raw('GET', `/api/memes/${id}/download/jpeg?version=1`);
  check('download jpeg ?version=1 -> 200 JPEG bytes', dlJpg.status === 200 && dlJpg.body[0] === 0xff && dlJpg.body[1] === 0xd8);
  const pubPng = await raw('GET', M.outputUrls.png);
  check('generated meme served from /output with nosniff', pubPng.status === 200 && pubPng.headers['content-type'] === 'image/png' && pubPng.headers['x-content-type-options'] === 'nosniff');
  const regen = await api('POST', `/api/memes/${id}/regenerate`, { instruction: 'make the text bigger' });
  check('regenerate -> 201 with version 2', regen.status === 201 && regen.data?.currentVersion === 2, `${regen.status}`);
  const restored = await api('POST', `/api/memes/${id}/restore/1`);
  check('restore version 1 -> 201', restored.status === 201 && restored.data?.currentVersion === 1, `${restored.status}`);
  const dlV2 = await raw('GET', `/api/memes/${id}/download/png?version=2`);
  check('download of version 2 still works after restore', dlV2.status === 200);
  const one = await api('GET', `/api/memes/${id}`);
  check('GET meme by id -> 200', one.status === 200 && one.data?.memeId === id);
  const list = await api('GET', '/api/memes?type=comparison&sort=newest&search=' + encodeURIComponent('Security'));
  check('gallery list with type/sort/search -> includes the meme', list.status === 200 && list.data.some(m => m.memeId === id), String(list.status));
  const refMeme = await api('GET', '/api/memes/reference/facts_collage');
  check('reference format (uses repository test-assets) still works', refMeme.status === 200 || refMeme.status === 201, String(refMeme.status));
  if (refMeme.data?.memeId) {
    const del = await api('DELETE', `/api/memes/${refMeme.data.memeId}`);
    check('deleting a meme built from test-assets leaves test-assets untouched', del.status === 200 && fs.readdirSync(TEST_ASSETS).sort().join(',') === testAssetsBefore);
  }

  // ================================================================================
  section('2. Upload attacks: wrong content, misleading names/MIME types, size, count');
  const before = uploadsList().length;
  const rejected = [
    ['HTML file named .html', 'evil.html', 'text/html', Buffer.from('<script>alert(1)</script>')],
    ['HTML content named .jpg with image/jpeg', 'evil.jpg', 'image/jpeg', Buffer.from('<html><script>alert(1)</script></html>' + ' '.repeat(3000))],
    ['SVG named .svg', 'vector.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['SVG content named .png with image/png', 'vector.png', 'image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + ' '.repeat(3000))],
    ['GIF named .gif', 'anim.gif', 'image/gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
    ['GIF content named .jpg with image/jpeg', 'anim.jpg', 'image/jpeg', Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;', 'latin1')],
    ['Executable content named .jpg', 'tool.jpg', 'image/jpeg', Buffer.concat([Buffer.from('MZ\x90\x00\x03', 'latin1'), Buffer.alloc(4000)])],
    ['empty file named .jpg', 'empty.jpg', 'image/jpeg', Buffer.alloc(0)],
    ['real JPEG but declared text/html', 'real.jpg', 'text/html', jpeg()],
    ['real JPEG named .exe', 'real.exe', 'image/jpeg', jpeg()],
    ['double extension .jpg.html', 'double.jpg.html', 'image/jpeg', jpeg()],
    ['real JPEG named .php', 'shell.php', 'image/jpeg', jpeg()],
    ['truncated JPEG (valid header, cut off)', 'cut.jpg', 'image/jpeg', jpeg().subarray(0, 150)],
    ['pixel-bomb PNG (header claims 40000x40000)', 'bomb.png', 'image/png', (() => { const b = Buffer.concat([png(), Buffer.alloc(2000)]); b.writeUInt32BE(40000, 16); b.writeUInt32BE(40000, 20); return b; })()]
  ];
  for (const [name, fname, type, bytes] of rejected) {
    const r = await postUpload(oneSubject(fname, type, bytes), goodPayload());
    check(`rejected (400): ${name}`, r.status === 400, `${r.status} ${r.text.slice(0, 120)}`);
  }
  const big = Buffer.concat([jpeg(), Buffer.alloc(21 * 1024 * 1024)]);
  const rBig = await postUpload(oneSubject('big.jpg', 'image/jpeg', big), goodPayload());
  check('rejected: 21 MB upload (413 or connection closed)', rBig.status === 413 || rBig.status === 0 || rBig.status === 400, `${rBig.status} ${rBig.text.slice(0, 100)}`);
  const many = await postUpload([...Array.from({ length: 11 }, (_, i) => ({ field: 'subjectImages', bytes: jpeg(200, 200), type: 'image/jpeg', name: `m${i}.jpg` })), rxFile()], goodPayload());
  check('rejected: 11 subject images (limit 10)', many.status === 400, String(many.status));
  const unexpected = await postUpload([{ field: 'avatar', bytes: jpeg(), type: 'image/jpeg', name: 'a.jpg' }, ...oneSubject('x.jpg', 'image/jpeg', jpeg())], goodPayload());
  check('rejected: unexpected file field', unexpected.status === 400, String(unexpected.status));
  await new Promise(r => setTimeout(r, 400));
  check('NO files left behind in uploads/ by any rejected upload', uploadsList().length === before, `before=${before} after=${uploadsList().length}`);

  const mis = await postUpload(oneSubject('actually-png.jpg', 'image/jpeg', png()), goodPayload());
  check('real PNG with a misleading .jpg name is accepted AND re-saved as .png', mis.status === 201 && path.extname(mis.data?.assets?.subjectImages?.[0]?.path || '') === '.png', `${mis.status} ${mis.data?.assets?.subjectImages?.[0]?.path}`);
  const jfif = await postUpload(oneSubject('photo.jfif', 'image/jpeg', jpeg()), goodPayload());
  check('a real JPEG saved as .jfif (common on Windows) is accepted and re-saved as .jpg', jfif.status === 201 && path.extname(jfif.data?.assets?.subjectImages?.[0]?.path || '') === '.jpg', `${jfif.status} ${jfif.data?.assets?.subjectImages?.[0]?.path}`);
  const jfifFake = await postUpload(oneSubject('fake.jfif', 'image/jpeg', Buffer.from('<html>x</html>' + ' '.repeat(3000))), goodPayload());
  check('HTML named .jfif is still rejected by the content check', jfifFake.status === 400, String(jfifFake.status));
  const trav = await postUpload(oneSubject('../../../evil.jpg', 'image/jpeg', jpeg()), goodPayload());
  const travPath = trav.data?.assets?.subjectImages?.[0]?.path || '';
  check('client file name "../../../evil.jpg" cannot escape: stored as upload_<uuid> inside uploads/', trav.status === 201 && path.dirname(travPath).toLowerCase() === UPLOADS.toLowerCase() && /upload_[0-9a-f-]{36}\.jpg$/.test(travPath), `${trav.status} ${travPath}`);
  check('display name was sanitised to "evil.jpg"', trav.data?.assets?.subjectImages?.[0]?.originalName === 'evil.jpg', trav.data?.assets?.subjectImages?.[0]?.originalName);
  check('no evil.jpg appeared anywhere above uploads/', !fs.existsSync(path.join(ROOT, 'evil.jpg')) && !fs.existsSync(path.join(ROOT, '..', 'evil.jpg')) && !fs.existsSync(path.join(ROOT, '..', '..', 'evil.jpg')));

  // ================================================================================
  section('3. Public access to files');
  const aName = path.basename(subj[0].path);
  for (const p of [`/uploads/${aName}`, '/uploads/', '/uploads', `/uploads/internet-discovered/x.jpg`]) {
    const r = await raw('GET', p);
    check(`GET ${p.length > 40 ? p.slice(0, 40) + '…' : p} is NOT served (404)`, r.status === 404, String(r.status));
  }
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT, 'planted.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(OUTPUT, '.hidden.png'), png());
  for (const p of ['/output/planted.html', '/output/.hidden.png', '/output/', '/output', '/output/../package.json', '/output/%2e%2e/package.json', '/output/..%5cpackage.json', '/output/%2e%2e%2fpackage.json', '/output/..%2f..%2fsrc%2fmain.ts']) {
    const r = await raw('GET', p);
    check(`GET ${p} is not served`, r.status !== 200, String(r.status));
  }
  fs.unlinkSync(path.join(OUTPUT, 'planted.html')); fs.unlinkSync(path.join(OUTPUT, '.hidden.png'));

  // ================================================================================
  section('4. Arbitrary file READ attempts through /generate (the original exploit)');
  const countBefore = await memeCount();
  const asset = p => ({ id: 'x', originalName: 'x.jpg', path: p, role: 'subject_primary', orderIndex: 0 });
  const gen = p => api('POST', '/api/memes/generate', { content: { topic: 't', punchline: 'x' }, assets: { subjectImages: [asset(p)] } });
  const attacks = [
    ['absolute path outside storage', precious],
    ['decoy folder whose path merely contains "uploads"', decoy],
    ['traversal out of uploads/', path.join(UPLOADS, '..', 'e2e-victims', 'other', 'precious.png')],
    ['traversal with forward slashes', UPLOADS.replace(/\\/g, '/') + '/../e2e-victims/other/precious.png'],
    ['traversal to package.json', path.join(UPLOADS, '..', 'package.json')],
    ['Windows system file', 'C:\\Windows\\win.ini'],
    ['relative path', 'uploads/anything.jpg'],
    ['relative traversal', '../../package.json'],
    ['UNC path', '\\\\127.0.0.1\\c$\\Windows\\win.ini'],
    ['device path', '\\\\?\\C:\\Windows\\win.ini'],
    ['NTFS alternate data stream', subj[0].path + ':hidden'],
    ['NUL byte truncation', subj[0].path + '\u0000.png'],
    ['a directory', UPLOADS],
    ['a non-image text file', path.join(ROOT, 'package.json')],
    ['missing file', path.join(UPLOADS, 'does-not-exist.jpg')]
  ];
  for (const [name, p] of attacks) {
    const r = await gen(p);
    check(`blocked (400): ${name}`, r.status === 400, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  }
  fs.writeFileSync(path.join(UPLOADS, 'planted_not_image.jpg'), '<html>not an image</html>');
  const planted = await gen(path.join(UPLOADS, 'planted_not_image.jpg'));
  check('blocked: a non-image file planted INSIDE uploads/ (content check, not just location)', planted.status === 400, String(planted.status));
  fs.unlinkSync(path.join(UPLOADS, 'planted_not_image.jpg'));
  check('no meme was created by any blocked attempt', (await memeCount()) === countBefore);
  check('victim files untouched', stillThere());
  const legit = await gen(subj[0].path);
  check('legitimate use still works: an uploaded image path is accepted', legit.status === 201, `${legit.status} ${JSON.stringify(legit.data).slice(0, 120)}`);
  const legitTA = await gen(path.join(TEST_ASSETS, 'movie_subject1.jpg'));
  check('legitimate use still works: repository test-assets path is accepted', legitTA.status === 201, String(legitTA.status));
  const legacy = await api('POST', '/api/memes/generate', { content: M.content, assets: M.assets, design: M.design, layout: M.layout });
  check('legacy UI regenerate (re-POST of a saved meme\'s content/assets/design/layout) still works', legacy.status === 201, `${legacy.status} ${JSON.stringify(legacy.data).slice(0, 200)}`);
  for (const x of [legit, legitTA, legacy]) if (x.data?.memeId) await api('DELETE', `/api/memes/${x.data.memeId}`);

  // ================================================================================
  section('5. Arbitrary file DELETE attempts');
  const tm = await postUpload(oneSubject('t.jpg', 'image/jpeg', jpeg()), goodPayload());
  const T = tm.data;
  const realAssetPaths = [T.assets.subjectImages[0].path, T.assets.reactionImage.path];
  const realOutputs = [T.outputPaths.png, T.outputPaths.jpeg];
  await col.updateOne({ memeId: T.memeId }, { $set: {
    'assets.subjectImages.0.path': decoy,
    'assets.reactionImage.path': precious,
    'outputPaths.png': precious,
    'outputPaths.jpeg': decoy,
    'versions.0.outputPaths.png': precious,
    'versions.0.outputPaths.jpeg': decoy
  } });
  const dlTampered = await raw('GET', `/api/memes/${T.memeId}/download/png`);
  check('download of a record whose stored path points outside output/ -> 404, file untouched', dlTampered.status === 404 && stillThere(), String(dlTampered.status));
  const regenTampered = await api('POST', `/api/memes/${T.memeId}/regenerate`, { instruction: 'make the text bigger' });
  check('regenerate of a poisoned record -> 400 (assets re-verified), not 500', regenTampered.status === 400, `${regenTampered.status} ${JSON.stringify(regenTampered.data).slice(0, 100)}`);
  const delTampered = await api('DELETE', `/api/memes/${T.memeId}`);
  check('DELETE of a poisoned record succeeds ...', delTampered.status === 200, String(delTampered.status));
  check('... but the files it pointed at (outside storage, incl. the "uploads"-named decoy) SURVIVE', stillThere());
  for (const f of [...realAssetPaths, ...realOutputs]) { try { fs.unlinkSync(f); } catch { /* ok */ } }   // clean the genuine files the poisoned record no longer references

  const A = (await postUpload(oneSubject('shared.jpg', 'image/jpeg', jpeg()), goodPayload())).data;
  const sharedPath = A.assets.subjectImages[0].path;
  const B = (await api('POST', '/api/memes/generate', { content: A.content, assets: A.assets, design: A.design, layout: A.layout })).data;
  await api('DELETE', `/api/memes/${A.memeId}`);
  check('deleting meme A keeps an upload that meme B still uses', fs.existsSync(sharedPath));
  check('...and meme B still renders its record', (await api('GET', `/api/memes/${B.memeId}`)).status === 200);
  await api('DELETE', `/api/memes/${B.memeId}`);
  check('deleting the last meme that uses it removes the upload (normal cleanup works)', !fs.existsSync(sharedPath));
  check('...and its generated output files', ![A.outputPaths.png, A.outputPaths.jpeg, B.outputPaths.png, B.outputPaths.jpeg].some(f => fs.existsSync(f)));

  // ================================================================================
  section('6. Malformed requests and injection');
  const m0 = await memeCount();
  const bad = async (name, resP, want = 400) => { const r = await resP; check(`${name} -> ${want}`, r.status === want, `${r.status} ${(r.text || r.body?.toString() || '').slice(0, 100)}`); };
  await bad('/generate with invalid JSON', raw('POST', '/api/memes/generate', { headers: { 'Content-Type': 'application/json', 'Content-Length': 5 }, body: '{bad,' }));
  await bad('/generate with empty body', api('POST', '/api/memes/generate'));
  await bad('/generate with a JSON array body', api('POST', '/api/memes/generate', '[1,2]'));
  await bad('/generate with text/plain body', raw('POST', '/api/memes/generate', { headers: { 'Content-Type': 'text/plain', 'Content-Length': 2 }, body: 'hi' }));
  await bad('/generate without punchline', api('POST', '/api/memes/generate', { content: { topic: 't' }, assets: { subjectImages: [] } }));
  await bad('/generate with punchline as an object ($ne)', api('POST', '/api/memes/generate', { content: { topic: 't', punchline: { $ne: '' } }, assets: { subjectImages: [] } }));
  await bad('/generate with 1001-char punchline', api('POST', '/api/memes/generate', { content: { topic: 't', punchline: 'x'.repeat(1001) }, assets: { subjectImages: [] } }));
  await bad('/generate with absurd design values', api('POST', '/api/memes/generate', { content: { topic: 't', punchline: 'x' }, assets: { subjectImages: [] }, design: { outlineThickness: 99999, fontSizeScale: 'abc', primaryTextColor: 'red;}</style><script>' } }));
  await bad('/generate with a 150 KB body', api('POST', '/api/memes/generate', { content: { topic: 't', punchline: 'x', statement: 'y'.repeat(150 * 1024) }, assets: { subjectImages: [] } }), 413);
  await bad('/preview with no content', api('POST', '/api/memes/preview', { assets: {} }));
  const u0 = uploadsList().length;
  await bad('upload-and-generate without payload', postUpload(oneSubject('a.jpg', 'image/jpeg', jpeg()), null));
  await bad('upload-and-generate with invalid payload JSON', postUpload(oneSubject('a.jpg', 'image/jpeg', jpeg()), '{nope'));
  await bad('upload-and-generate with no punchline', postUpload(oneSubject('a.jpg', 'image/jpeg', jpeg()), { content: { topic: 't' } }));
  await bad('upload-and-generate with 200 KB payload', postUpload(oneSubject('a.jpg', 'image/jpeg', jpeg()), JSON.stringify({ content: { punchline: 'x' }, pad: 'z'.repeat(200 * 1024) })), 400);
  const badBody = '--XYZ\r\nbroken header\r\n';
  const badMp = await raw('POST', '/api/memes/upload-and-generate', { headers: { 'Content-Type': 'multipart/form-data; boundary=XYZ', 'Content-Length': Buffer.byteLength(badBody) }, body: badBody });
  check('malformed multipart body -> 400 (not 500)', badMp.status === 400, String(badMp.status));
  check('rejected uploads above left no files behind', uploadsList().length === u0, `${u0} -> ${uploadsList().length}`);
  await bad('regenerate with instruction as an object', api('POST', `/api/memes/${id}/regenerate`, { instruction: { $ne: 1 } }));
  await bad('regenerate with no instruction', api('POST', `/api/memes/${id}/regenerate`, {}));
  await bad('regenerate with 301-char instruction', api('POST', `/api/memes/${id}/regenerate`, { instruction: 'a'.repeat(301) }));
  check('none of the malformed requests created a meme', (await memeCount()) === m0);

  const typeNe = await raw('GET', '/api/memes?type[$ne]=comparison');
  check('operator-style query ?type[$ne]=... is NOT interpreted by MongoDB (comparison meme still listed)', typeNe.status === 200 && json(typeNe).some(m => m.memeId === id), String(typeNe.status));
  const typeJson = await raw('GET', '/api/memes?type=' + encodeURIComponent('{"$ne":"x"}'));
  check('?type={"$ne":"x"} as a string -> 400', typeJson.status === 400, String(typeJson.status));
  await bad('?search repeated (array) ', raw('GET', '/api/memes?search=a&search=b'));
  await bad('?sort=bogus', raw('GET', '/api/memes?sort=bogus'));
  await bad('?search 101 chars', raw('GET', '/api/memes?search=' + 'a'.repeat(101)));
  const rx1 = await raw('GET', '/api/memes?search=' + encodeURIComponent('('));
  check('search "(" is literal, no regex crash (200)', rx1.status === 200, String(rx1.status));
  const rx2 = await raw('GET', '/api/memes?search=' + encodeURIComponent('.*'));
  check('search ".*" matches literally, not everything', rx2.status === 200 && json(rx2).length === 0, `${rx2.status} ${json(rx2)?.length}`);
  const rx3 = await raw('GET', '/api/memes?search=' + encodeURIComponent('(a+)+$'));
  check('catastrophic-backtracking pattern is harmless and fast', rx3.status === 200);
  await bad('GET /api/memes/not-a-uuid', raw('GET', '/api/memes/not-a-uuid'));
  await bad('GET /api/memes/{"$ne":1}', raw('GET', '/api/memes/' + encodeURIComponent('{"$ne":1}')));
  await bad('DELETE /api/memes/..%2f..%2fx', raw('DELETE', '/api/memes/..%2f..%2fx'));
  await bad('download with bad id', raw('GET', '/api/memes/xyz/download/png'));
  await bad('download format "exe"', raw('GET', `/api/memes/${id}/download/exe`));
  await bad('download ?version=abc', raw('GET', `/api/memes/${id}/download/png?version=abc`));
  await bad('download ?version=99 (does not exist)', raw('GET', `/api/memes/${id}/download/png?version=99`), 404);
  await bad('restore version abc', raw('POST', `/api/memes/${id}/restore/abc`));
  await bad('restore version 0', raw('POST', `/api/memes/${id}/restore/0`));
  await bad('restore version 99', raw('POST', `/api/memes/${id}/restore/99`), 404);
  await bad('unknown but valid UUID', raw('GET', '/api/memes/3f2b8c1e-9d4a-4e6b-8a1c-0b2d3e4f5a6b'), 404);

  // ================================================================================
  section('7. Viral adaptation endpoint (upload hardening; the vision CLI itself is not run here)');
  const v0 = uploadsList().length;
  const viral = (files, fields) => {
    const fd = new FormData();
    for (const f of files) fd.append(f.field, new Blob([f.bytes], { type: f.type }), f.name);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fetch(BASE + '/api/memes/adapt-viral', { method: 'POST', body: fd }).then(async r => ({ status: r.status, text: await r.text() }));
  };
  const ref = { field: 'referenceImage', bytes: jpeg(), type: 'image/jpeg', name: 'ref.jpg' };
  const rx = { field: 'reactionImage', bytes: jpeg(960, 540), type: 'image/jpeg', name: 'rx.jpg' };
  let r = await viral([rx], { punchline: 'p' }); check('missing reference image -> 400', r.status === 400, `${r.status}`);
  r = await viral([ref], { punchline: 'p' }); check('missing reaction image -> 400', r.status === 400, `${r.status}`);
  r = await viral([ref, rx], {}); check('missing punchline -> 400', r.status === 400, `${r.status}`);
  r = await viral([ref, rx], { punchline: 'x'.repeat(1001) }); check('over-long punchline -> 400', r.status === 400, `${r.status}`);
  r = await viral([ref, rx], { punchline: 'p', fontFamily: '"; drop' }); check('font name injection -> 400', r.status === 400, `${r.status}`);
  r = await viral([{ ...ref, bytes: Buffer.from('<html>x</html>' + ' '.repeat(3000)), name: 'ref.jpg' }, rx], { punchline: 'p' });
  check('HTML disguised as the reference screenshot -> 400', r.status === 400 && /rejected/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`);
  r = await viral([ref, { ...rx, bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>' + ' '.repeat(3000)), name: 'rx.png', type: 'image/png' }], { punchline: 'p' });
  check('SVG disguised as the reaction image -> 400', r.status === 400, `${r.status}`);
  if (process.env.E2E_NO_VISION_CLI === '1') {
    r = await viral([ref, rx], { punchline: 'ఇది నా పంచ్‌లైన్' });
    check('valid inputs reach the analysis step; with no vision CLI available the request fails cleanly (503, explained)', (r.status === 503 || r.status === 400) && /analy/i.test(r.text) && /VISION_CLI_PATH|not found|signed in/i.test(r.text), `${r.status} ${r.text.slice(0, 160)}`);
  } else {
    console.log('  SKIP  valid-input viral request: set E2E_NO_VISION_CLI=1 and start the server with USERPROFILE pointing at an empty folder, so the real vision CLI can never be launched');
  }
  await new Promise(x => setTimeout(x, 400));
  check('no uploads left behind by any rejected or failed viral request', uploadsList().length === v0, `${v0} -> ${uploadsList().length}`);

  // ================================================================================
  section('7b. New endpoints: image streaming, report and design profile');
  const assetOk = await raw('GET', `/api/memes/${id}/assets/subject-0`);
  check('asset endpoint streams the meme\'s own image with an image content type and nosniff', assetOk.status === 200 && /^image\/(jpeg|png|webp)$/.test(String(assetOk.headers['content-type'])) && assetOk.headers['x-content-type-options'] === 'nosniff', `${assetOk.status} ${assetOk.headers['content-type']}`);
  for (const which of ['..%2f..%2fpackage.json', '../../package.json', 'subject-99', 'reference', 'subject--1', 'secret']) {
    const r = await raw('GET', `/api/memes/${id}/assets/${which}`);
    check(`asset endpoint refuses "${which}" (400/404)`, r.status === 400 || r.status === 404, String(r.status));
  }
  const rep1 = await raw('GET', `/api/memes/${id}/report`);
  check('report endpoint answers for a manual meme (no report, no file paths leaked)', rep1.status === 200 && !/[A-Za-z]:\\\\|\/uploads\//.test(rep1.body.toString()), String(rep1.status));
  const dp = await api('GET', '/api/design-profile');
  check('design profile readable', dp.status === 200 && dp.data?.colors?.primary === '#FFE500', String(dp.status));
  const dpBad = await api('PUT', '/api/design-profile', { typography: { englishFont: 'Comic Sans' }, punchline: 'x' });
  check('design profile rejects unknown fonts and keys (400)', dpBad.status === 400, String(dpBad.status));
  const dpX = await api('PUT', '/api/design-profile', { name: 'evil' }, { Origin: 'https://evil.com' });
  check('cross-site design profile change refused (403)', dpX.status === 403, String(dpX.status));
  const sys = await raw('GET', '/api/system/status');
  check('system status exposes no secrets', sys.status === 200 && !/mongodb:\/\/|api_key|apiKey"\s*:\s*"[^"]/i.test(sys.body.toString()), String(sys.status));

  // ================================================================================
  section('8. Network access: host/origin checks, CORS, headers, binding');
  const h1 = await raw('GET', '/api/memes', { headers: { Host: 'evil.com' } });
  check('foreign Host header (DNS rebinding) -> 403', h1.status === 403, String(h1.status));
  const mBefore = await memeCount();
  const o1 = await api('POST', '/api/memes/generate', { content: { topic: 't', punchline: 'x' }, assets: { subjectImages: [] } }, { Origin: 'https://evil.com' });
  check('cross-site POST (Origin: evil.com) -> 403', o1.status === 403, String(o1.status));
  const fdE = new FormData(); fdE.append('payload', '{}');
  const o2 = await raw('POST', '/api/memes/upload-and-generate', { headers: { Origin: 'https://evil.com', 'Content-Type': 'text/plain', 'Content-Length': 2 }, body: 'hi' });
  check('cross-site simple (non-preflighted) POST -> 403', o2.status === 403, String(o2.status));
  const o3 = await api('DELETE', `/api/memes/${id}`, undefined, { Origin: 'https://evil.com' });
  check('cross-site DELETE -> 403 and the meme survives', o3.status === 403 && (await api('GET', `/api/memes/${id}`)).status === 200, String(o3.status));
  const o4 = await api('POST', '/api/memes/generate', { content: { topic: 't' } }, { Origin: 'http://localhost:5173' });
  check('request from the local frontend origin passes the guard (reaches validation -> 400, not 403)', o4.status === 400, String(o4.status));
  check('no meme created by the blocked cross-site requests', (await memeCount()) === mBefore);
  const pf1 = await raw('OPTIONS', '/api/memes', { headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'DELETE' } });
  check('CORS preflight from evil.com gets no Allow-Origin', !pf1.headers['access-control-allow-origin'], String(pf1.headers['access-control-allow-origin']));
  const pf2 = await raw('OPTIONS', '/api/memes', { headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
  check('CORS preflight from the local frontend is allowed', pf2.headers['access-control-allow-origin'] === 'http://localhost:5173', String(pf2.headers['access-control-allow-origin']));
  const hdr = await raw('GET', '/api/memes');
  check('no X-Powered-By header', hdr.headers['x-powered-by'] === undefined);
  check('security headers present (nosniff, CSP, no-referrer, frame deny)', hdr.headers['x-content-type-options'] === 'nosniff' && /default-src 'none'/.test(hdr.headers['content-security-policy'] || '') && hdr.headers['referrer-policy'] === 'no-referrer' && hdr.headers['x-frame-options'] === 'DENY');
  const viaName = await fetch(`http://localhost:${URLP.port}/api/memes`).then(r => r.status).catch(e => String(e.cause?.code || e.message));
  check('the frontend dev proxy / browser path "localhost" still reaches the loopback-only server', viaName === 200, String(viaName));
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const viaLan = await new Promise(resolve => {
      const req = http.request({ host: lan.address, port: URLP.port, path: '/api/memes', timeout: 3000 }, res => { res.resume(); resolve('REACHABLE ' + res.statusCode); });
      req.on('error', e => resolve('refused: ' + e.code)); req.on('timeout', () => { req.destroy(); resolve('timeout'); });
      req.end();
    });
    check(`server is NOT reachable on the LAN address ${lan.address}`, /^refused|^timeout/.test(viaLan), viaLan);
  } else console.log('  (no LAN interface found: LAN reachability check skipped)');

  // ================================================================================
  section('Cleanup + final integrity');
  for (const m of (await api('GET', '/api/memes')).data || []) await api('DELETE', `/api/memes/${m.memeId}`);
  check('victim files outside storage are all still present', stillThere());
  check('repository test-assets are unchanged', fs.readdirSync(TEST_ASSETS).sort().join(',') === testAssetsBefore);
  fs.rmSync(VICTIMS, { recursive: true, force: true });

  await mongoose.disconnect();
  console.log(`\nRESULT: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:\n  - ' + failures.join('\n  - ')); process.exit(1); }
})().catch(e => { console.error('E2E script error:', e); process.exit(1); });
