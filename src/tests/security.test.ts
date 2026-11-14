/**
 * Offline unit tests for the security modules (no network, database or running server).
 * Everything that touches the filesystem happens in a fresh temp directory that is removed afterwards.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import {
  isPathInside,
  resolveApprovedFile,
  safeDeleteFile,
  sanitizeDisplayName,
  hasUnsafePathChars
} from '../security/path-guard';
import {
  sniffImageHeader,
  verifyImageBuffer,
  verifyImageFile,
  inspectImageFileHeader,
  ImageValidationError,
  MAX_IMAGE_PIXELS
} from '../security/image-verify';
import {
  validateGenerateBody,
  validateUploadPayload,
  validateListQuery,
  validateInstruction,
  validateViralFields,
  parseVersionNumber,
  escapeRegex,
  MemeIdPipe
} from '../security/request-validation';
import {
  defaultGuardOptions,
  isHostAllowed,
  isOriginAllowed,
  hostAndOriginGuard
} from '../security/http-guards';

const rejects400 = (fn: () => unknown, pattern?: RegExp) =>
  assert.throws(fn, (e: any) => e.getStatus?.() === 400 && (!pattern || pattern.test(e.message)), `expected a 400${pattern ? ` matching ${pattern}` : ''}`);

// ------------------------------------------------------------------------------------------------
describe('path guard', () => {
  let tmp: string, uploads: string, outside: string;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pathguard-'));
    uploads = path.join(tmp, 'uploads');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(uploads);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(tmp, 'uploads-evil'));
    fs.writeFileSync(path.join(uploads, 'ok.jpg'), 'x');
    fs.mkdirSync(path.join(uploads, 'sub'));
    fs.writeFileSync(path.join(uploads, 'sub', 'deep.png'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.jpg'), 'secret');
    fs.writeFileSync(path.join(tmp, 'uploads-evil', 'x.jpg'), 'x');
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('accepts files inside the root, including subdirectories', () => {
    assert.ok(resolveApprovedFile(path.join(uploads, 'ok.jpg'), [uploads]));
    assert.ok(resolveApprovedFile(path.join(uploads, 'sub', 'deep.png'), [uploads]));
  });

  it('rejects path traversal', () => {
    assert.equal(resolveApprovedFile(path.join(uploads, '..', 'outside', 'secret.jpg'), [uploads]), null);
    assert.equal(resolveApprovedFile(uploads + path.sep + '..' + path.sep + 'outside' + path.sep + 'secret.jpg', [uploads]), null);
    assert.equal(resolveApprovedFile(path.join(uploads, 'sub', '..', '..', 'outside', 'secret.jpg'), [uploads]), null);
  });

  it('rejects absolute paths outside the root and sibling directories sharing a name prefix', () => {
    assert.equal(resolveApprovedFile(path.join(outside, 'secret.jpg'), [uploads]), null);
    assert.equal(resolveApprovedFile(path.join(tmp, 'uploads-evil', 'x.jpg'), [uploads]), null);
    assert.equal(isPathInside(uploads, path.join(tmp, 'uploads-evil', 'x.jpg')), false);
  });

  it('rejects relative paths, empty values, non-strings and NUL bytes', () => {
    assert.equal(resolveApprovedFile('uploads/ok.jpg', [uploads]), null);
    assert.equal(resolveApprovedFile('../uploads/ok.jpg', [uploads]), null);
    assert.equal(resolveApprovedFile('', [uploads]), null);
    assert.equal(resolveApprovedFile(undefined, [uploads]), null);
    assert.equal(resolveApprovedFile({ toString: () => path.join(uploads, 'ok.jpg') }, [uploads]), null);
    assert.equal(resolveApprovedFile(path.join(uploads, 'ok.jpg') + '\0.png', [uploads]), null);
  });

  it('rejects the root itself, directories and missing files', () => {
    assert.equal(resolveApprovedFile(uploads, [uploads]), null);
    assert.equal(resolveApprovedFile(path.join(uploads, 'sub'), [uploads]), null);
    assert.equal(resolveApprovedFile(path.join(uploads, 'missing.jpg'), [uploads]), null);
  });

  it('rejects UNC / device paths and alternate data streams', () => {
    assert.equal(hasUnsafePathChars('\\\\server\\share\\a.jpg'), true);
    assert.equal(hasUnsafePathChars('\\\\?\\C:\\a.jpg'), true);
    assert.equal(hasUnsafePathChars('C:\\x\\a.jpg:hidden'), true);
    assert.equal(hasUnsafePathChars('C:\\x\\a.jpg'), false);
    assert.equal(resolveApprovedFile(path.join(uploads, 'ok.jpg') + ':stream', [uploads]), null);
  });

  it('does not follow a symlink that points outside the root', (t) => {
    const link = path.join(uploads, 'link.jpg');
    try {
      fs.symlinkSync(path.join(outside, 'secret.jpg'), link);
    } catch {
      return t.skip('cannot create symlinks on this system (needs privilege)');
    }
    assert.equal(resolveApprovedFile(link, [uploads]), null);
    assert.equal(safeDeleteFile(link, uploads), false);
    assert.ok(fs.existsSync(path.join(outside, 'secret.jpg')), 'target must survive');
  });

  it('does not follow a directory junction / symlinked folder that leads outside the root', (t) => {
    const linkDir = path.join(uploads, 'linked-dir');
    try {
      fs.symlinkSync(outside, linkDir, 'junction');   // junctions need no privilege on Windows
    } catch {
      return t.skip('cannot create directory links on this system');
    }
    const viaLink = path.join(linkDir, 'secret.jpg');
    assert.ok(fs.existsSync(viaLink), 'sanity: the link really reaches the outside file');
    assert.equal(resolveApprovedFile(viaLink, [uploads]), null);
    assert.equal(isPathInside(uploads, viaLink), false);
    assert.equal(safeDeleteFile(viaLink, uploads), false);
    assert.ok(fs.existsSync(path.join(outside, 'secret.jpg')), 'the outside file must survive');
    fs.rmdirSync(linkDir);   // remove only the link, never its target
  });

  it('safeDeleteFile deletes only inside the root and never touches outside files', () => {
    const victim = path.join(outside, 'secret.jpg');
    assert.equal(safeDeleteFile(victim, uploads), false);
    assert.equal(safeDeleteFile(path.join(uploads, '..', 'outside', 'secret.jpg'), uploads), false);
    assert.equal(safeDeleteFile(path.join(uploads, 'sub'), uploads), false);   // directories are never deleted
    assert.ok(fs.existsSync(victim));
    assert.ok(fs.existsSync(path.join(uploads, 'sub')));

    assert.equal(safeDeleteFile(path.join(uploads, 'ok.jpg'), uploads), true);
    assert.ok(!fs.existsSync(path.join(uploads, 'ok.jpg')));
  });

  it('the old substring check ("path contains uploads") is not enough: a decoy path outside is refused', () => {
    const decoyDir = path.join(outside, 'uploads');
    fs.mkdirSync(decoyDir);
    const decoy = path.join(decoyDir, 'precious.jpg');
    fs.writeFileSync(decoy, 'precious');
    assert.ok(decoy.includes('uploads'));
    assert.equal(safeDeleteFile(decoy, uploads), false);
    assert.ok(fs.existsSync(decoy));
  });

  it('sanitises display names', () => {
    assert.equal(sanitizeDisplayName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeDisplayName('C:\\Windows\\win.ini'), 'win.ini');
    assert.equal(sanitizeDisplayName('a<b>:"c|d?.jpg'), 'abcd.jpg');
    assert.equal(sanitizeDisplayName('\u0000\u001f'), 'upload');
    assert.equal(sanitizeDisplayName(42), 'upload');
    assert.ok(sanitizeDisplayName('x'.repeat(500)).length <= 120);
  });
});

// ------------------------------------------------------------------------------------------------
describe('image content verification', () => {
  let jpeg: Buffer, png: Buffer, webp: Buffer, tmp: string;

  const draw = (w = 320, h = 240) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    for (let i = 0; i < 200; i++) {
      ctx.fillStyle = `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})`;
      ctx.fillRect((i * 17) % w, (i * 29) % h, 30, 30);
    }
    return c;
  };

  before(() => {
    const c = draw();
    jpeg = c.toBuffer('image/jpeg');
    png = c.toBuffer('image/png');
    webp = c.toBuffer('image/webp');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgverify-'));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  for (const [name, get, type] of [['JPEG', () => jpeg, 'jpeg'], ['PNG', () => png, 'png'], ['WebP', () => webp, 'webp']] as const) {
    it(`accepts a real ${name} and reports its true type and size`, async () => {
      const v = await verifyImageBuffer(get());
      assert.equal(v.type, type);
      assert.equal(v.width, 320);
      assert.equal(v.height, 240);
    });
  }

  it('rejects HTML, SVG, GIF, script and plain text regardless of what they are called', async () => {
    const samples: [string, Buffer][] = [
      ['html', Buffer.from('<!doctype html><html><script>alert(1)</script></html>')],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['svg with xml prolog', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')],
      ['js', Buffer.from('require("child_process").exec("calc")')],
      ['text', Buffer.from('hello')],
      ['pdf', Buffer.from('%PDF-1.7 ...')],
      ['exe', Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1')],
      ['empty', Buffer.alloc(0)]
    ];
    for (const [name, buf] of samples) {
      await assert.rejects(() => verifyImageBuffer(buf), ImageValidationError, `${name} must be rejected`);
      assert.equal(sniffImageHeader(buf), null, `${name} must not sniff as an image`);
    }
  });

  it('rejects an HTML payload that merely starts like an image signature', async () => {
    const polyglot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<script>alert(1)</script>')]);
    await assert.rejects(() => verifyImageBuffer(polyglot), ImageValidationError);
  });

  it('rejects truncated or corrupt images that have a valid header', async () => {
    await assert.rejects(() => verifyImageBuffer(jpeg.subarray(0, 120)), ImageValidationError);
    const garbage = Buffer.concat([png.subarray(0, 40), Buffer.from('not really png data at all, just junk bytes')]);
    await assert.rejects(() => verifyImageBuffer(garbage), ImageValidationError);
  });

  it('rejects decompression bombs from the header, before decoding anything', async () => {
    // A tiny PNG whose IHDR claims 40000x40000 (1.6 gigapixels)
    const bomb = Buffer.from(png);
    bomb.writeUInt32BE(40000, 16);
    bomb.writeUInt32BE(40000, 20);
    const started = Date.now();
    await assert.rejects(() => verifyImageBuffer(bomb), /too large/);
    assert.ok(Date.now() - started < 500, 'must be rejected without decoding');
    assert.ok(40000 * 40000 > MAX_IMAGE_PIXELS);

    const zeroWidth = Buffer.from(png);
    zeroWidth.writeUInt32BE(0, 16);
    await assert.rejects(() => verifyImageBuffer(zeroWidth), /invalid dimensions/);
  });

  it('verifies files on disk and ignores the extension: HTML named .jpg is rejected, a PNG named .jpg is identified as PNG', async () => {
    const fake = path.join(tmp, 'fake.jpg');
    fs.writeFileSync(fake, '<html><body onload="alert(1)"></body></html>');
    await assert.rejects(() => verifyImageFile(fake), ImageValidationError);
    assert.throws(() => inspectImageFileHeader(fake), ImageValidationError);

    const misnamed = path.join(tmp, 'actually-png.jpg');
    fs.writeFileSync(misnamed, png);
    const v = await verifyImageFile(misnamed);
    assert.equal(v.type, 'png');
    assert.equal(v.ext, '.png');
    assert.equal(inspectImageFileHeader(misnamed).type, 'png');

    const empty = path.join(tmp, 'empty.png');
    fs.writeFileSync(empty, '');
    await assert.rejects(() => verifyImageFile(empty), /empty/);
  });
});

// ------------------------------------------------------------------------------------------------
describe('external image download hardening (mocked network)', () => {
  const realFetch = globalThis.fetch;
  let svc: any;
  let validJpeg: Buffer;
  const saved: string[] = [];

  const candidate = (name: string) => ({ title: name, sourceUrl: `https://img.test/${name}`, sourceDomain: 'img.test' });
  const mockBody = (bodies: Record<string, () => Response>) => {
    globalThis.fetch = (async (input: any) => {
      const key = String(input?.url ?? input).replace('https://img.test/', '');
      return bodies[key] ? bodies[key]() : new Response('nope', { status: 404 });
    }) as any;
  };

  before(async () => {
    const { Logger } = await import('@nestjs/common');
    Logger.overrideLogger(false);
    const { InternetSubjectDiscoveryService } = await import('../services/internet-subject-discovery.service');
    svc = new InternetSubjectDiscoveryService();
    const c = createCanvas(600, 800);
    const ctx = c.getContext('2d');
    for (let i = 0; i < 6000; i++) {
      ctx.fillStyle = `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})`;
      ctx.fillRect((i * 17) % 600, (i * 29) % 800, 24, 24);
    }
    validJpeg = c.toBuffer('image/jpeg');
  });
  after(() => {
    globalThis.fetch = realFetch;
    for (const f of saved) { try { fs.unlinkSync(f); } catch { /* gone */ } }
  });

  it('still accepts a normal image and stores it with the detected extension', async () => {
    mockBody({ 'ok.png': () => new Response(new Uint8Array(validJpeg), { status: 200 }) });
    const r = await svc.downloadAndVerifyCandidate(candidate('ok.png'));   // misleading URL extension: content is JPEG
    saved.push(r.savedPath);
    assert.ok(r.savedPath.endsWith('.jpg'));
    assert.equal(r.mimeType, 'image/jpeg');
    assert.equal(r.width, 600);
  });

  it('rejects a body larger than the cap even when the server hides its size (streamed, no Content-Length)', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    mockBody({
      'huge.jpg': () => new Response(new ReadableStream({
        pull(controller) {
          if (sent++ >= 30) return controller.close();   // would be 30 MB
          controller.enqueue(chunk);
        }
      }), { status: 200 })
    });
    await assert.rejects(() => svc.downloadAndVerifyCandidate(candidate('huge.jpg')), /exceeds|too large/);
    assert.ok(sent < 30, `download must be aborted early (read ${sent} MB)`);
  });

  it('rejects a declared Content-Length over the cap without reading the body', async () => {
    mockBody({ 'big.jpg': () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }) });
    await assert.rejects(() => svc.downloadAndVerifyCandidate(candidate('big.jpg')), /too large/);
  });

  it('rejects HTML and SVG served as an "image"', async () => {
    const pad = ' '.repeat(25000);
    mockBody({
      'page.jpg': () => new Response('<html><script>alert(1)</script>' + pad + '</html>', { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      'vector.png': () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' + pad, { status: 200, headers: { 'content-type': 'image/png' } })
    });
    await assert.rejects(() => svc.downloadAndVerifyCandidate(candidate('page.jpg')), /not a JPEG, PNG or WebP/);
    await assert.rejects(() => svc.downloadAndVerifyCandidate(candidate('vector.png')), /not a JPEG, PNG or WebP/);
  });

  it('rejects a pixel bomb (tiny file claiming gigapixel dimensions) before decoding it', async () => {
    const bomb = Buffer.concat([validJpeg]);
    const png = createCanvas(300, 300).toBuffer('image/png');
    const padded = Buffer.concat([png, Buffer.alloc(25000)]);
    padded.writeUInt32BE(50000, 16);
    padded.writeUInt32BE(50000, 20);
    void bomb;
    mockBody({ 'bomb.png': () => new Response(new Uint8Array(padded), { status: 200 }) });
    const started = Date.now();
    await assert.rejects(() => svc.downloadAndVerifyCandidate(candidate('bomb.png')), /too large/);
    assert.ok(Date.now() - started < 1000);
  });
});

// ------------------------------------------------------------------------------------------------
describe('request validation', () => {
  const okAsset = { id: 'a1', originalName: 'x.jpg', path: 'C:\\somewhere\\x.jpg', role: 'subject_primary', orderIndex: 0 };
  const okBody = () => ({
    content: { topic: 't', punchline: 'నా పంచ్‌లైన్!  exact   text ' },
    assets: { subjectImages: [okAsset], reactionImage: { ...okAsset, id: 'r' } }
  });

  it('accepts a normal body and preserves the punchline exactly (including spacing)', () => {
    const v = validateGenerateBody(okBody());
    assert.equal(v.content.punchline, 'నా పంచ్‌లైన్!  exact   text ');
    assert.equal(v.assets.subjectImages.length, 1);
    assert.equal(v.assets.reactionImage?.role, 'reaction_punchline');
  });

  it('defaults the topic when only a headline is given (previously a 500 from the database)', () => {
    const b: any = okBody();
    delete b.content.topic;
    b.content.headline = 'OG CENSOR REPORT';
    assert.equal(validateGenerateBody(b).content.topic, 'OG CENSOR REPORT');
  });

  it('rejects malformed bodies with 400', () => {
    rejects400(() => validateGenerateBody(null), /JSON object/);
    rejects400(() => validateGenerateBody('x'));
    rejects400(() => validateGenerateBody([]));
    rejects400(() => validateGenerateBody({}), /assets is required/);
    rejects400(() => validateGenerateBody({ assets: {} }), /content is required/);
    const noPunch: any = okBody(); delete noPunch.content.punchline;
    rejects400(() => validateGenerateBody(noPunch), /punchline is required/);
  });

  it('rejects wrong types, including NoSQL-style operator objects', () => {
    const b1: any = okBody(); b1.content.punchline = { $ne: '' };
    rejects400(() => validateGenerateBody(b1), /punchline must be a string/);
    const b2: any = okBody(); b2.content.headline = ['a'];
    rejects400(() => validateGenerateBody(b2), /headline must be a string/);
    const b3: any = okBody(); b3.content.bulletPoints = 'x';
    rejects400(() => validateGenerateBody(b3), /bulletPoints must be an array/);
    const b4: any = okBody(); b4.assets.subjectImages = 'x';
    rejects400(() => validateGenerateBody(b4), /subjectImages must be an array/);
    const b5: any = okBody(); b5.assets.subjectImages = [{ path: { $gt: '' } }];
    rejects400(() => validateGenerateBody(b5), /path must be a string/);
    const b6: any = okBody(); b6.assets.subjectImages = [{ nopath: true }];
    rejects400(() => validateGenerateBody(b6), /path is required/);
  });

  it('enforces size limits and rejects NUL bytes', () => {
    const b1: any = okBody(); b1.content.punchline = 'x'.repeat(1001);
    rejects400(() => validateGenerateBody(b1), /too long/);
    const b2: any = okBody(); b2.assets.subjectImages = Array.from({ length: 13 }, () => okAsset);
    rejects400(() => validateGenerateBody(b2), /too many items/);
    const b3: any = okBody(); b3.content.punchline = 'abc\0def';
    rejects400(() => validateGenerateBody(b3), /invalid characters/);
    const b4: any = okBody(); b4.assets.subjectImages = [{ ...okAsset, path: 'x'.repeat(1025) }];
    rejects400(() => validateGenerateBody(b4), /too long/);
  });

  it('validates design and layout values', () => {
    const base = okBody() as any;
    for (const [design, re] of [
      [{ outlineThickness: 999 }, /outlineThickness/],
      [{ outlineThickness: 'abc' }, /outlineThickness/],
      [{ fontSizeScale: 99 }, /fontSizeScale/],
      [{ fontSizeScale: -1 }, /fontSizeScale/],
      [{ canvasPreset: 'huge' }, /canvasPreset/],
      [{ primaryTextColor: 'red; background:url(x)' }, /primaryTextColor/],
      [{ primaryTextColor: 'javascript:alert(1)' }, /primaryTextColor/],
      [{ fontFamily: 'Arial"; drop' }, /fontFamily/],
      [{ fontFamily: { a: 1 } }, /fontFamily/],
      [{ textAlignment: 'diagonal' }, /textAlignment/]
    ] as [object, RegExp][]) {
      rejects400(() => validateGenerateBody({ ...base, design }), re);
    }
    for (const [layout, re] of [
      [{ memeType: 'nope' }, /memeType/],
      [{ arrangement: 'spiral' }, /arrangement/],
      [{ reactionHeightRatio: 5 }, /reactionHeightRatio/],
      [{ gapSize: -3 }, /gapSize/]
    ] as [object, RegExp][]) {
      rejects400(() => validateGenerateBody({ ...base, layout }), re);
    }
    rejects400(() => validateGenerateBody({ ...base, design: 'x' }), /design must be an object/);
    // values the frontend really sends, and values read back from a saved meme
    const v = validateGenerateBody({
      ...base,
      design: { fontFamily: 'Arial Black', teluguFontFamily: 'Ramabhadra', primaryTextColor: '#FFE500', shadowColor: 'rgba(0,0,0,0.92)', outlineThickness: 7, fontSizeScale: 1, shadowBlur: 8, canvasPreset: 'portrait_4_5', width: 1080, height: 1350, shadowOffsetX: 3 },
      layout: { memeType: 'movie_update', arrangement: 'auto', reactionHeightRatio: 0.42, headerHeightRatio: 0.082, gapSize: 3, hasHeaderBanner: true, subjectSectionRatio: 0.5 }
    });
    assert.equal(v.design?.outlineThickness, 7);
    assert.equal(v.layout?.memeType, 'movie_update');
  });

  it('only keeps whitelisted asset fields and drops client-supplied filename / mimeType', () => {
    const b: any = okBody();
    b.assets.subjectImages = [{ ...okAsset, filename: '../../evil.html', mimeType: 'text/html', evil: 'x', sourceUrl: 'javascript:alert(1)', role: 'reaction_punchline' }];
    const a = validateGenerateBody(b).assets.subjectImages[0] as any;
    assert.equal(a.filename, '');
    assert.equal(a.mimeType, '');
    assert.equal(a.evil, undefined);
    assert.equal(a.sourceUrl, undefined);
    assert.notEqual(a.role, 'reaction_punchline');
  });

  it('upload payload: must be bounded JSON with a punchline', () => {
    const ok = validateUploadPayload(JSON.stringify({ content: { topic: 'x', punchline: 'p', itemLabels: ['a', ''] }, layout: { memeType: 'comparison', arrangement: 'auto' }, subjectLabels: ['A'] }));
    assert.equal(ok.content.punchline, 'p');
    rejects400(() => validateUploadPayload(undefined), /required/);
    rejects400(() => validateUploadPayload(''), /required/);
    rejects400(() => validateUploadPayload('{bad json'), /Invalid JSON/);
    rejects400(() => validateUploadPayload('[]'), /JSON object/);
    rejects400(() => validateUploadPayload('{}'), /punchline/);
    rejects400(() => validateUploadPayload(JSON.stringify({ content: { punchline: 'x'.repeat(2000) } })), /too long/);
    rejects400(() => validateUploadPayload('x'.repeat(200 * 1024)), /too large/);
    rejects400(() => validateUploadPayload(['a'] as any), /required/);
  });

  it('viral fields: punchline is trimmed but otherwise exact; font and context are checked', () => {
    const v = validateViralFields({ punchline: '  ఆ రోజు  నుంచి  ', reactionContext: ' * ctx ', fontFamily: 'Arial Black' });
    assert.equal(v.punchline, 'ఆ రోజు  నుంచి');
    assert.equal(v.reactionContext, '* ctx');
    rejects400(() => validateViralFields({ punchline: '   ' }), /punchline/);
    rejects400(() => validateViralFields({ punchline: ['a', 'b'] as any }), /string/);
    rejects400(() => validateViralFields({ punchline: 'x', fontFamily: 'a;b' }), /fontFamily/);
    rejects400(() => validateViralFields({ punchline: 'x', reactionContext: 'y'.repeat(400) }), /too long/);
  });

  it('list query: only plain, allowed strings', () => {
    assert.deepEqual(validateListQuery({ search: 'og', type: 'comparison', sort: 'oldest' }), { search: 'og', type: 'comparison', sort: 'oldest' });
    assert.deepEqual(validateListQuery({}), { search: undefined, type: undefined, sort: undefined });
    rejects400(() => validateListQuery({ type: { $ne: 'x' } }), /type must be one of/);
    rejects400(() => validateListQuery({ type: 'nope' }), /type must be one of/);
    rejects400(() => validateListQuery({ search: { $regex: '.*' } }), /search must be a string/);
    rejects400(() => validateListQuery({ search: ['a', 'b'] }), /search must be a string/);
    rejects400(() => validateListQuery({ sort: 'random' }), /sort must be one of/);
    rejects400(() => validateListQuery({ search: 'x'.repeat(101) }), /too long/);
  });

  it('escapes regex metacharacters so search is always literal', () => {
    assert.equal(escapeRegex('a.b*c(d)[e]'), 'a\\.b\\*c\\(d\\)\\[e\\]');
    assert.doesNotThrow(() => new RegExp(escapeRegex('(((')));
    assert.doesNotThrow(() => new RegExp(escapeRegex('[')));
    assert.ok(new RegExp(escapeRegex('(a+)+$'), 'i').test('x(a+)+$y'));
    assert.ok(!new RegExp(escapeRegex('.*'), 'i').test('anything'));
  });

  it('instructions and version numbers', () => {
    assert.equal(validateInstruction('  make text bigger '), 'make text bigger');
    rejects400(() => validateInstruction(undefined), /required/);
    rejects400(() => validateInstruction('   '), /required/);
    rejects400(() => validateInstruction({ a: 1 }), /string/);
    rejects400(() => validateInstruction('x'.repeat(301)), /too long/);
    assert.equal(parseVersionNumber('3'), 3);
    for (const bad of ['0', '-1', 'abc', '1.5', '1e3', '', undefined, ['1'], '99999999']) {
      rejects400(() => parseVersionNumber(bad as any), /version/);
    }
  });

  it('meme id pipe accepts UUIDs only', () => {
    const pipe = new MemeIdPipe();
    assert.equal(pipe.transform('3f2b8c1e-9d4a-4e6b-8a1c-0b2d3e4f5a6b'), '3f2b8c1e-9d4a-4e6b-8a1c-0b2d3e4f5a6b');
    for (const bad of ['../etc/passwd', '{"$ne":1}', '1', '', 'x'.repeat(200), '3f2b8c1e-9d4a-4e6b-8a1c-0b2d3e4f5a6b/../x', undefined, { $ne: 1 }]) {
      rejects400(() => pipe.transform(bad as any), /Invalid meme id/);
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe('http guards (host / origin)', () => {
  const opts = defaultGuardOptions({});

  const run = (headers: Record<string, string>, method = 'POST') => {
    let status = 0;
    let nextCalled = false;
    const req: any = { headers, method };
    const res: any = { status(s: number) { status = s; return this; }, json() { return this; } };
    hostAndOriginGuard(opts)(req, res, () => { nextCalled = true; });
    return { status, nextCalled };
  };

  it('allows loopback hosts with any port', () => {
    for (const h of ['localhost:3000', 'localhost', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST:3000']) {
      assert.equal(isHostAllowed(h, opts), true, h);
    }
  });

  it('blocks foreign Host headers (DNS rebinding) and a missing Host', () => {
    for (const h of ['evil.com', 'evil.com:3000', 'localhost.evil.com', '192.168.0.5:3000', '127.0.0.1.evil.com', undefined]) {
      assert.equal(isHostAllowed(h as any, opts), false, String(h));
      if (h) assert.equal(run({ host: h }, 'GET').status, 403);
    }
  });

  it('allows local frontend origins and rejects everything else', () => {
    for (const o of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://[::1]:5173']) {
      assert.equal(isOriginAllowed(o, opts), true, o);
    }
    for (const o of ['https://evil.com', 'http://localhost.evil.com', 'http://evil.com:5173', 'null', 'file://', 'http://localhostx:5173', undefined]) {
      assert.equal(isOriginAllowed(o as any, opts), false, String(o));
    }
  });

  it('blocks cross-site state-changing requests but allows same-machine tools without an Origin', () => {
    assert.equal(run({ host: 'localhost:3000', origin: 'https://evil.com' }, 'POST').status, 403);
    assert.equal(run({ host: 'localhost:3000', origin: 'https://evil.com' }, 'DELETE').status, 403);
    assert.equal(run({ host: 'localhost:3000', origin: 'null' }, 'POST').status, 403);
    assert.equal(run({ host: 'localhost:3000', origin: 'http://localhost:5173' }, 'POST').nextCalled, true);
    assert.equal(run({ host: 'localhost:3000' }, 'POST').nextCalled, true);
    assert.equal(run({ host: 'localhost:3000', origin: 'https://evil.com' }, 'GET').nextCalled, true); // CORS keeps it unreadable
  });

  it('extra hosts and origins are opt-in through the environment', () => {
    const custom = defaultGuardOptions({ ALLOWED_HOSTS: 'studio.lan', CORS_ORIGINS: 'https://studio.lan' } as any);
    assert.equal(isHostAllowed('studio.lan:3000', custom), true);
    assert.equal(isOriginAllowed('https://studio.lan', custom), true);
    assert.equal(isHostAllowed('studio.lan', opts), false);
  });
});
