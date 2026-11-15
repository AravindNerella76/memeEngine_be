/**
 * Gallery scaling: query validation for the paged list and thumbnails, and the thumbnail service
 * (made on demand, cached, rebuilt when the source changes, only from the output folder).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { BadRequestException } from '@nestjs/common';
import { PAGE_DEFAULT, PAGE_MAX, THUMB_WIDTHS, validatePageQuery, validateThumbQuery } from '../security/request-validation';
import { THUMB_DIR, ThumbnailService } from '../services/thumbnail.service';
import { OUTPUT_ROOT, TEST_ASSETS_ROOT } from '../security/path-guard';

describe('validatePageQuery', () => {
  it('has sensible defaults', () => {
    const q = validatePageQuery({});
    assert.equal(q.limit, PAGE_DEFAULT);
    assert.equal(q.skip, 0);
  });
  it('accepts a page and the existing filters', () => {
    const q = validatePageQuery({ limit: '12', skip: '24', type: 'comparison', sort: 'oldest', search: 'net worth' });
    assert.deepEqual([q.limit, q.skip, q.type, q.sort, q.search], [12, 24, 'comparison', 'oldest', 'net worth']);
  });
  it('rejects out-of-range, non-numeric and non-string values (no operator objects reach the database)', () => {
    for (const bad of [{ limit: '0' }, { limit: String(PAGE_MAX + 1) }, { limit: '-5' }, { limit: 'abc' }, { skip: '-1' }, { skip: '1e3' }, { limit: ['1', '2'] }, { skip: { $gt: '0' } }]) {
      assert.throws(() => validatePageQuery(bad), BadRequestException, JSON.stringify(bad));
    }
  });
});

describe('validateThumbQuery', () => {
  it('defaults to 480 px and the current version', () => assert.deepEqual(validateThumbQuery({}), { version: undefined, width: 480 }));
  it('accepts the allowed widths and a version', () => {
    for (const w of THUMB_WIDTHS) assert.equal(validateThumbQuery({ w: String(w), v: '3' }).width, w);
    assert.equal(validateThumbQuery({ v: '3' }).version, 3);
  });
  it('refuses any other width, so nobody can make the server render huge images', () => {
    for (const w of ['100', '481', '4000', '99999', '0', 'big']) assert.throws(() => validateThumbQuery({ w }), BadRequestException, w);
  });
  it('refuses a bad version', () => {
    for (const v of ['0', '-1', 'x', '1.5']) assert.throws(() => validateThumbQuery({ v }), BadRequestException, v);
  });
});

describe('ThumbnailService', () => {
  const svc = new ThumbnailService();
  const dir = path.join(OUTPUT_ROOT, '__thumb_test__');
  const src = path.join(dir, 'meme_test_v1.png');
  const KEY = 'thumbtest0000_v1';

  before(async () => {
    fs.mkdirSync(dir, { recursive: true });
    // a real photo as a 1080x1350 PNG, like a generated meme (flat colours or noise would not be representative)
    const photo = await loadImage(path.join(TEST_ASSETS_ROOT, 'movie_subject1.jpg'));
    const c = createCanvas(1080, 1350);
    c.getContext('2d').drawImage(photo, 0, 0, 1080, 1350);
    fs.writeFileSync(src, c.toBuffer('image/png'));
  });
  after(() => {
    svc.removeForMeme('thumbtest0000');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('makes a much smaller JPEG with the same proportions', async () => {
    const out = await svc.ensure(src, KEY, 480);
    assert.ok(out.startsWith(THUMB_DIR));
    const img = await loadImage(out);
    assert.equal(img.width, 480);
    assert.equal(img.height, 600, '4:5 stays 4:5');
    assert.ok(fs.statSync(out).size < fs.statSync(src).size / 4, 'far smaller than the source');
    assert.deepEqual([...fs.readFileSync(out).subarray(0, 3)], [0xff, 0xd8, 0xff], 'a real JPEG');
  });

  it('never enlarges a small image', async () => {
    const out = await svc.ensure(src, 'thumbtest0000_v2', 720);
    assert.equal((await loadImage(out)).width, 720);
    const tiny = path.join(dir, 'tiny.png');
    const c = createCanvas(200, 250);
    c.getContext('2d').fillRect(0, 0, 200, 250);
    fs.writeFileSync(tiny, c.toBuffer('image/png'));
    assert.equal((await loadImage(await svc.ensure(tiny, 'thumbtest0000_v3', 480))).width, 200);
  });

  it('reuses the cached file, and rebuilds it when the source is newer', async () => {
    const a = await svc.ensure(src, KEY, 480);
    const t1 = fs.statSync(a).mtimeMs;
    await svc.ensure(src, KEY, 480);
    assert.equal(fs.statSync(a).mtimeMs, t1, 'not rebuilt');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(src, later, later);
    await svc.ensure(src, KEY, 480);
    assert.ok(fs.statSync(a).mtimeMs > t1, 'rebuilt after the source changed');
  });

  it('shares one build between simultaneous requests', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => svc.ensure(src, 'thumbtest0000_v9', 360)));
    assert.equal(new Set(results).size, 1);
    assert.equal(fs.readdirSync(THUMB_DIR).filter(f => f.startsWith('thumbtest0000_v9_360') && f.endsWith('.tmp')).length, 0, 'no half-written files left');
  });

  it('refuses a source outside the output folder', async () => {
    await assert.rejects(() => svc.ensure(path.join(OUTPUT_ROOT, '..', 'package.json'), 'evil_v1', 480), /outside the output folder/);
    await assert.rejects(() => svc.ensure('/etc/passwd', 'evil_v1', 480), /outside the output folder/);
  });

  it('removes every thumbnail of a meme and nothing else', async () => {
    await svc.ensure(src, 'otherthumb00_v1', 480);
    const n = svc.removeForMeme('thumbtest0000');
    assert.ok(n >= 3, `removed ${n}`);
    assert.ok(!fs.readdirSync(THUMB_DIR).some(f => f.startsWith('thumbtest0000_')));
    assert.ok(fs.existsSync(svc.thumbPath('otherthumb00_v1', 480)), "another meme's thumbnail is untouched");
    svc.removeForMeme('otherthumb00');
  });
});
