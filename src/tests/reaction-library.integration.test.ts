/**
 * INTEGRATION (scratch MongoDB only; skipped unless MONGO_TEST_URI is set): the reaction library service.
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27999/meme_test npm run test:integration
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import { ReactionImage, ReactionImageSchema } from '../schemas/reaction-image.schema';
import { ReactionLibraryService } from '../services/reaction-library.service';
import { TEST_ASSETS_ROOT } from '../security/path-guard';

const URI = process.env.MONGO_TEST_URI;
const skip = URI ? false : 'set MONGO_TEST_URI to a scratch database to run integration tests';
const TAG = 'rxtest';

describe('reaction library (integration)', { skip }, () => {
  let lib: ReactionLibraryService;
  let model: mongoose.Model<any>;
  const photo = (f: string) => fs.readFileSync(path.join(TEST_ASSETS_ROOT, f));

  before(async () => {
    await mongoose.connect(URI as string);
    model = mongoose.models[ReactionImage.name] || mongoose.model(ReactionImage.name, ReactionImageSchema);
    await model.deleteMany({ category: new RegExp(`^${TAG}`) });
    lib = new ReactionLibraryService(model as any);
  });

  after(async () => {
    await model.deleteMany({ category: new RegExp(`^${TAG}`) });
    await mongoose.disconnect();
  });

  it('stores a picture with its folder and serves the file and a small copy', async () => {
    const buf = photo('movie_reaction.jpg');
    const r = await lib.add({ buffer: buf, originalName: 'FB_IMG_1742285803405.jpg', category: `${TAG} shocking`, tags: ['brahmanandam'] });
    assert.equal(r.created, true);
    assert.equal(r.image.category, `${TAG} shocking`);
    assert.equal(r.image.name, '', 'camera-roll style file names are not kept');
    assert.deepEqual(r.image.tags, ['brahmanandam']);
    const file = await lib.bytes(r.image.imageId, 'file');
    assert.equal(file.mime, 'image/jpeg');
    assert.ok(file.data.equals(buf), 'the original bytes come back untouched');
    const thumb = await lib.bytes(r.image.imageId, 'thumb');
    assert.ok(thumb.data.length < file.data.length && thumb.data.length > 500, 'the small copy is smaller');
  });

  it('never stores the same picture twice, whatever folder it is sent to', async () => {
    const buf = photo('movie_reaction.jpg');
    const again = await lib.add({ buffer: buf, originalName: 'copy.jpg', category: `${TAG} sad` });
    assert.equal(again.created, false);
    assert.equal(again.image.category, `${TAG} shocking`, 'it is reported where it already lives');
    assert.equal(await model.countDocuments({ category: new RegExp(`^${TAG}`) }), 1);
  });

  it('refuses things that are not pictures, with a readable reason', async () => {
    await assert.rejects(lib.add({ buffer: Buffer.from('<html><script>alert(1)</script></html>'), originalName: 'evil.jpg', category: `${TAG} x` }), (e: any) => e instanceof BadRequestException && /rejected/.test(e.message));
    await assert.rejects(lib.add({ buffer: Buffer.alloc(0), originalName: 'empty.png', category: `${TAG} x` }), BadRequestException);
  });

  it('keeps a transparent PNG transparent (logos) and shrinks a very large picture', async () => {
    const c = createCanvas(300, 120);
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.font = '60px sans-serif';
    x.fillText('LOGO', 10, 80); // the rest stays transparent
    const logo = await lib.add({ buffer: c.toBuffer('image/png'), originalName: 'logo.png', category: `${TAG} logos` });
    assert.equal((await lib.bytes(logo.image.imageId, 'thumb')).mime, 'image/png');

    const big = createCanvas(4000, 3000);
    const bx = big.getContext('2d');
    for (let i = 0; i < 60; i++) {
      bx.fillStyle = `hsl(${i * 6}, 70%, 50%)`;
      bx.fillRect((i * 67) % 4000, (i * 41) % 3000, 900, 700);
    }
    const added = await lib.add({ buffer: big.toBuffer('image/jpeg', 98), originalName: 'huge.jpg', category: `${TAG} big` });
    assert.ok(Math.max(added.image.width, added.image.height) <= 2400, `shrunk to fit (${added.image.width}x${added.image.height})`);
    assert.ok(added.image.bytes <= 3 * 1024 * 1024 * 2);
  });

  it('lists by folder, searches folder / name / tags, and counts folders', async () => {
    const q = (o: object) => ({ category: undefined, search: undefined, sort: 'newest' as const, limit: 48, skip: 0, ...o });
    assert.equal((await lib.list(q({ category: `${TAG} shocking` }))).total, 1);
    assert.equal((await lib.list(q({ search: 'brahmanandam', category: `${TAG} shocking` }))).items.length, 1, 'tag search');
    assert.equal((await lib.list(q({ search: `${TAG} logos` }))).total, 1, 'folder-name search');
    assert.equal((await lib.list(q({ search: 'no-such-thing-xyz' }))).total, 0);
    assert.equal((await lib.list(q({ search: '.*' }))).total, 0, 'a search is text, never a pattern');
    const cats = await lib.categories();
    assert.ok(cats.categories.some(c => c.category === `${TAG} logos` && c.count === 1));
    assert.equal(cats.total, cats.categories.reduce((n, c) => n + c.count, 0));
  });

  it('paging: skip and limit cover everything once', async () => {
    const all = await lib.list({ category: undefined, search: TAG, sort: 'newest', limit: 48, skip: 0 });
    const seen: string[] = [];
    for (let skipN = 0; skipN < all.total; skipN += 2) {
      seen.push(...(await lib.list({ category: undefined, search: TAG, sort: 'newest', limit: 2, skip: skipN })).items.map(i => i.imageId));
    }
    assert.equal(new Set(seen).size, all.total);
  });

  it('counts uses, and "recent" / "used" list only pictures that were used', async () => {
    const [first] = (await lib.list({ category: `${TAG} shocking`, search: undefined, sort: 'newest', limit: 5, skip: 0 })).items;
    assert.equal((await lib.list({ category: `${TAG} shocking`, search: undefined, sort: 'used', limit: 5, skip: 0 })).total, 0);
    await lib.markUsed(first.imageId);
    await lib.markUsed(first.imageId);
    const used = await lib.list({ category: `${TAG} shocking`, search: undefined, sort: 'used', limit: 5, skip: 0 });
    assert.equal(used.items[0].usedCount, 2);
    assert.ok(used.items[0].lastUsedAt);
    assert.equal((await lib.list({ category: `${TAG} shocking`, search: undefined, sort: 'recent', limit: 5, skip: 0 })).total, 1);
  });

  it('edits folder, name and tags; moves and deletes in bulk; reports missing pictures', async () => {
    const [img] = (await lib.list({ category: `${TAG} shocking`, search: undefined, sort: 'newest', limit: 5, skip: 0 })).items;
    const edited = await lib.update(img.imageId, { name: 'Brahmi shocked', tags: ['a', 'b'] });
    assert.equal(edited.name, 'Brahmi shocked');
    assert.deepEqual(edited.tags, ['a', 'b']);
    await assert.rejects(lib.update(img.imageId, {}), BadRequestException);
    assert.equal((await lib.bulk('move', [img.imageId], `${TAG} moved`)).changed, 1);
    assert.equal((await lib.list({ category: `${TAG} moved`, search: undefined, sort: 'newest', limit: 5, skip: 0 })).total, 1);
    assert.equal((await lib.bulk('delete', [img.imageId], undefined)).changed, 1);
    await assert.rejects(lib.remove(img.imageId), NotFoundException);
    await assert.rejects(lib.bytes(img.imageId, 'file'), NotFoundException);
    await assert.rejects(lib.update('00000000-0000-4000-8000-000000000000', { name: 'x' }), NotFoundException);
  });
});
