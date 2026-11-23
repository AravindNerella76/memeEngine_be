/**
 * iPhone photos (HEIC/HEIF) in the studio: the conversion endpoint the browser uses for previews, and every upload
 * route (accepted even with the empty or generic type Windows/Android browsers give them, converted to JPEG on arrival).
 *
 * A real HEIC photo is needed for the decoding parts. It is not part of the repository (licence); point HEIC_SAMPLE at
 * one, or put it at test-assets/heic/sample.heic. Without it those tests are skipped; the rest always run.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ImageConvertController } from '../controllers/image-convert.controller';
import { ImageSelectionController } from '../controllers/image-selection.controller';
import { ImageSelectionService } from '../services/image-selection.service';
import { isHeic } from '../security/image-normalize';
import { verifyImageBuffer } from '../security/image-verify';

const SAMPLE = [process.env.HEIC_SAMPLE, path.join(__dirname, '..', '..', 'test-assets', 'heic', 'sample.heic')].find(p => p && fs.existsSync(p));
const heic = SAMPLE ? fs.readFileSync(SAMPLE) : null;
const needsSample = { skip: heic ? false : 'no HEIC sample (set HEIC_SAMPLE)' };
const JPEG_1PX = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

describe('iPhone photos (HEIC)', () => {
  let base = '';
  let close: () => Promise<void>;
  const staged: { path: string; name: string; bytes: Buffer }[] = [];

  before(async () => {
    const selection = {
      stageUpload: async (p: string, name: string) => (staged.push({ path: p, name, bytes: fs.readFileSync(p) }), { token: 't' }),
      toPublic: () => ({ token: 't' })
    };
    @Module({ controllers: [ImageConvertController, ImageSelectionController], providers: [{ provide: ImageSelectionService, useValue: selection }] })
    class TestModule {}
    const app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    close = () => app.close();
  });
  after(() => close());

  const send = (route: string, bytes: Buffer, name: string, type: string) => {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type }), name);
    return fetch(`${base}${route}`, { method: 'POST', body: form });
  };

  it('the browser gets a full-quality JPEG back for previews', needsSample, async () => {
    const res = await send('/api/images/convert', heic!, 'IMG_0001.HEIC', 'image/heic');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('x-converted-from'), 'heic');
    const out = Buffer.from(await res.arrayBuffer());
    const v = await verifyImageBuffer(out);
    assert.equal(v.type, 'jpeg');
    assert.equal(`${v.width}x${v.height}`, `${res.headers.get('x-image-width')}x${res.headers.get('x-image-height')}`);
    assert.ok(out.length < heic!.length * 3, 'a photo-sized JPEG, not a huge PNG');
  });

  it('the convert endpoint refuses anything that is not HEIC (by content, not by name)', async () => {
    assert.equal((await send('/api/images/convert', JPEG_1PX, 'fake.heic', 'image/heic')).status, 415);
    assert.equal((await send('/api/images/convert', Buffer.from('<svg/>'), 'x.heic', 'image/heic')).status, 415);
  });

  for (const [label, type] of [['image/heic', 'image/heic'], ['no type (Windows)', ''], ['application/octet-stream (Android)', 'application/octet-stream']] as const) {
    it(`an upload with ${label} is accepted and stored as a JPEG`, needsSample, async () => {
      const before = staged.length;
      const res = await send('/api/staged-images/upload', heic!, 'IMG_0002.heic', type);
      assert.equal(res.status, 200, await res.text());
      const got = staged[before];
      assert.ok(got, 'the route received the picture');
      assert.equal(path.extname(got.path), '.jpg');
      assert.equal(isHeic(got.bytes), false);
      assert.equal((await verifyImageBuffer(got.bytes)).type, 'jpeg');
      assert.ok(!fs.existsSync(got.path), 'the temporary upload is cleaned up');
    });
  }

  it('a .heic name with non-image content is still refused', async () => {
    const res = await send('/api/staged-images/upload', Buffer.from('<html>not a photo</html>'), 'IMG_0003.heic', '');
    assert.equal(res.status, 400);
  });

  it('other types with a generic MIME are still refused at the door', async () => {
    const res = await send('/api/staged-images/upload', JPEG_1PX, 'photo.jpg', 'application/octet-stream');
    assert.equal(res.status, 400);
  });
});
