/**
 * The background adaptation endpoints over real HTTP: the real MemeController (multipart upload, validation, image
 * check) and the real job service, with a fake pipeline that reports progress like the real one. No database, no AI.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import type { AddressInfo } from 'net';
import { createCanvas } from '@napi-rs/canvas';
import { Module, UnprocessableEntityException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MemeController } from '../controllers/meme.controller';
import { MemeEngineService } from '../services/meme-engine.service';
import { ThumbnailService } from '../services/thumbnail.service';
import { ViralAdaptationService, ViralAdaptInput } from '../services/viral-adaptation.service';
import { AdaptationJobService } from '../services/adaptation-job.service';

const png = (n: number): Buffer => {
  const c = createCanvas(120 + n, 160);
  const g = c.getContext('2d');
  g.fillStyle = `hsl(${n * 37 % 360} 70% 50%)`;
  g.fillRect(0, 0, 400, 400);
  g.fillStyle = '#fff';
  g.fillRect(10, 10, 50, 50);
  return c.toBuffer('image/png');
};

/** Stands in for the real pipeline: reports progress, then waits for the test to let it finish or fail. */
class FakeViral {
  busy = false;
  inputs: ViralAdaptInput[] = [];
  gate: { release: () => void; fail: (e: Error) => void } | null = null;
  isBusy() {
    return this.busy;
  }
  adapt(input: ViralAdaptInput) {
    this.inputs.push(input);
    this.busy = true;
    input.onProgress?.({ type: 'stage', stage: 'analysis', state: 'active', note: 'reading' });
    input.onProgress?.({ type: 'slots', slots: [{ slotId: 'slot_1', index: 0, subject: 'Mahesh Babu' }] });
    input.onProgress?.({ type: 'slot', slotId: 'slot_1', state: 'searching' });
    return new Promise<{ meme: unknown; adaptationMetadata: Record<string, unknown> }>((resolve, reject) => {
      this.gate = {
        release: () => {
          this.busy = false;
          resolve({ meme: { memeId: 'meme_1', content: { punchline: input.punchline } }, adaptationMetadata: { pipelineVersion: 2 } });
        },
        fail: e => {
          this.busy = false;
          reject(e);
        }
      };
    });
  }
}

const fake = new FakeViral();

/** Stands in for the engine's in-memory preview: records what it was given, and can be held open. */
const preview = {
  calls: [] as any[],
  hold: null as null | Promise<void>,
  generated: 0
};
const fakeEngine = {
  previewManual: async (input: any) => {
    preview.calls.push(input);
    if (preview.hold) await preview.hold;
    return { image: 'data:image/jpeg;base64,AAAA', width: 1080, height: 1350 };
  },
  generateMeme: async () => {
    preview.generated++;
    return {};
  }
};

@Module({
  controllers: [MemeController],
  providers: [
    { provide: ViralAdaptationService, useValue: fake },
    { provide: MemeEngineService, useValue: fakeEngine },
    { provide: ThumbnailService, useValue: {} },
    AdaptationJobService
  ]
})
class TestModule {}

describe('background adaptation over HTTP', () => {
  let base = '';
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  const leftovers: string[] = [];

  before(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  after(async () => {
    await app.close();
    leftovers.forEach(p => fs.rmSync(p, { force: true }));
  });

  const form = (over: { punchline?: string | null; reaction?: boolean; reference?: boolean } = {}) => {
    const f = new FormData();
    if (over.reference !== false) f.append('referenceImage', new Blob([new Uint8Array(png(1))], { type: 'image/png' }), 'ref.png');
    if (over.reaction !== false) f.append('reactionImage', new Blob([new Uint8Array(png(2))], { type: 'image/png' }), 'rx.png');
    if (over.punchline !== null) f.append('punchline', over.punchline ?? 'సూపర్ సార్ మీరు');
    return f;
  };
  const post = (f: FormData) => fetch(`${base}/api/memes/adapt-viral/jobs`, { method: 'POST', body: f });
  const get = (p: string) => fetch(`${base}/api/memes/adapt-viral/jobs/${p}`);
  const settle = () => new Promise(r => setTimeout(r, 30));
  const track = () => fake.inputs.forEach(i => leftovers.push(i.reaction.path, ...(i.reference ? [i.reference.path] : [])));

  it('answers 202 with a job at once, shows live progress, then hands over the meme', async () => {
    const res = await post(form());
    assert.equal(res.status, 202);
    const job = (await res.json()) as { id: string; status: string };
    assert.equal(job.status, 'running');
    assert.match(job.id, /^[0-9a-f-]{36}$/);
    track();

    // the pipeline is mid-way: the app sees the real stage and the slot being searched
    const mid = (await (await get(job.id)).json()) as any;
    assert.equal(mid.status, 'running');
    assert.equal(mid.stages[0].state, 'active');
    assert.deepEqual(mid.slots.map((s: any) => [s.subject, s.state]), [['Mahesh Babu', 'searching']]);

    // after a refresh the app finds the same job without knowing its id
    const active = (await (await get('active')).json()) as any;
    assert.equal(active.job?.id, job.id);

    fake.gate!.release();
    await settle();
    const done = (await (await get(job.id)).json()) as any;
    assert.equal(done.status, 'done');
    // the same shape the synchronous endpoint answers with: the meme itself plus adaptationMetadata
    assert.equal(done.result.memeId, 'meme_1');
    assert.deepEqual(done.result.adaptationMetadata, { pipelineVersion: 2 });
    // the punchline travelled through the upload untouched
    assert.equal(done.result.content.punchline, 'సూపర్ సార్ మీరు');
    assert.equal(((await (await get('active')).json()) as any).job, null);
  });

  it('refuses a second meme while one is being made (429) and says so before starting anything', async () => {
    const first = await post(form());
    assert.equal(first.status, 202);
    track();
    const before = fake.inputs.length;
    const second = await post(form());
    assert.equal(second.status, 429);
    assert.match(((await second.json()) as any).message, /still being made/i);
    assert.equal(fake.inputs.length, before, 'the pipeline was not started twice');
    fake.gate!.release();
    await settle();
  });

  it('turns a pipeline failure into the same message and details as the synchronous endpoint', async () => {
    const res = await post(form());
    const job = (await res.json()) as { id: string };
    track();
    fake.gate!.fail(new UnprocessableEntityException({ statusCode: 422, message: 'Could not safely identify slot 2.', details: { stage: 'identity', slots: [{ slot: 2, status: 'ambiguous' }] } }));
    await settle();
    const v = (await (await get(job.id)).json()) as any;
    assert.equal(v.status, 'failed');
    assert.equal(v.error.status, 422);
    assert.equal(v.error.message, 'Could not safely identify slot 2.');
    assert.equal(v.error.details.stage, 'identity');
    // the uploads nothing references any more are deleted
    const i = fake.inputs[fake.inputs.length - 1];
    assert.equal(fs.existsSync(i.reaction.path), false);
    assert.equal(fs.existsSync((i.reference as { path: string }).path), false);
  });

  it('rejects a bad request before any work starts, with the same messages as adapt-viral', async () => {
    const before = fake.inputs.length;
    for (const [bad, text] of [
      [form({ reference: false }), /Input 1 missing/],
      [form({ reaction: false }), /Input 2 missing/],
      [form({ punchline: null }), /Input 3 missing/],
      [form({ punchline: '   ' }), /Input 3 missing/]
    ] as [FormData, RegExp][]) {
      const res = await post(bad);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as any).message, text);
    }
    assert.equal(fake.inputs.length, before);
  });

  it('refuses a file that is not really an image, whatever it is called', async () => {
    const f = form();
    f.set('reactionImage', new Blob(['<html>not an image</html>'], { type: 'image/png' }), 'rx.png');
    const res = await post(f);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /rejected/i);
  });

  describe('manual meme preview (upload-and-preview)', () => {
    const payload = (over: any = {}) => JSON.stringify({ content: { topic: 'T', headline: 'H', punchline: 'సూపర్', ...over.content }, layout: { memeType: 'comparison', arrangement: 'auto' }, design: { canvasPreset: 'portrait_4_5' }, subjectLabels: ['A', 'B'], ...over.rest });
    const previewForm = (n = 2, withReaction = true, body = payload()) => {
      const f = new FormData();
      for (let i = 0; i < n; i++) f.append('subjectImages', new Blob([new Uint8Array(png(10 + i))], { type: 'image/png' }), `s${i}.png`);
      if (withReaction) f.append('reactionImage', new Blob([new Uint8Array(png(20))], { type: 'image/png' }), 'rx.png');
      f.append('payload', body);
      return f;
    };
    const send = (f: FormData) => fetch(`${base}/api/memes/upload-and-preview`, { method: 'POST', body: f });
    const uploadsOf = (calls: any[]) => calls.flatMap(c => [...c.assets.subjectImages, ...(c.assets.reactionImage ? [c.assets.reactionImage] : [])].map((a: any) => a.path as string));

    it('answers with the picture, hands the engine the words and pictures in order, and saves nothing', async () => {
      const calls0 = preview.calls.length;
      const res = await send(previewForm());
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.match(body.image, /^data:image\/jpeg;base64,/);
      assert.deepEqual([body.width, body.height], [1080, 1350]);
      const call = preview.calls[calls0];
      assert.equal(call.content.punchline, 'సూపర్');
      assert.deepEqual(call.assets.subjectImages.map((s: any) => s.label), ['A', 'B']);
      assert.deepEqual(call.assets.subjectImages.map((s: any) => s.orderIndex), [0, 1]);
      assert.equal(call.assets.reactionImage.role, 'reaction_punchline');
      assert.equal(preview.generated, 0, 'previewing never creates a meme');
    });

    it('deletes every uploaded copy afterwards, success or not', async () => {
      const calls0 = preview.calls.length;
      await send(previewForm(3));
      const paths = uploadsOf(preview.calls.slice(calls0));
      assert.equal(paths.length, 4);
      assert.ok(paths.every(p => !fs.existsSync(p)), 'nothing is left in uploads');
    });

    it('a bad request is refused with the same messages as Generate, and its uploads are removed too', async () => {
      const calls0 = preview.calls.length;
      const noPunch = await send(previewForm(1, false, payload({ content: { punchline: '' } })));
      assert.equal(noPunch.status, 400);
      assert.match(((await noPunch.json()) as any).message, /punchline/i);
      const notJson = await send(previewForm(1, false, 'not json'));
      assert.equal(notJson.status, 400);
      const f = previewForm(1, false);
      f.set('subjectImages', new Blob(['<html>not an image</html>'], { type: 'image/png' }), 's.png');
      assert.equal((await send(f)).status, 400);
      assert.equal(preview.calls.length, calls0, 'the engine was never asked');
    });

    it('allows two previews at once and asks a third to wait, then recovers', async () => {
      let open!: () => void;
      preview.hold = new Promise<void>(r => (open = r));
      const first = send(previewForm(1, false));
      const second = send(previewForm(1, false));
      await settle();
      const third = await send(previewForm(1, false));
      assert.equal(third.status, 429);
      assert.match(((await third.json()) as any).message, /already being drawn/i);
      preview.hold = null;
      open();
      assert.equal((await first).status, 200);
      assert.equal((await second).status, 200);
      assert.equal((await send(previewForm(1, false))).status, 200, 'the cap is released');
    });
  });

  it('does not know a job it never started, or an id that is not one', async () => {
    assert.equal((await get('00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await get('not-a-job')).status, 404);
    assert.equal((await get('%2e%2e%2fsecret')).status, 404);
  });
});
