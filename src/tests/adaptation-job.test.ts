/**
 * Live progress of a viral adaptation: the snapshot folds what the pipeline reports, the job service runs work in the
 * background, keeps the result for the app to collect, and turns every failure into the same message and details the
 * synchronous endpoint gives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { AdaptationJob } from '../jobs/adaptation-progress';
import { AdaptationJobService, jobErrorFrom } from '../services/adaptation-job.service';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('AdaptationJob snapshot', () => {
  it('starts with every stage pending and the clock at zero', () => {
    let now = 1000;
    const job = new AdaptationJob('j1', () => now);
    const v = job.view();
    assert.equal(v.status, 'running');
    assert.deepEqual(v.stages.map(s => s.state), ['pending', 'pending', 'pending', 'pending']);
    assert.equal(v.elapsedMs, 0);
    now = 4500;
    assert.equal(job.view().elapsedMs, 3500);
  });

  it('marks earlier stages done when a later one begins, and keeps a skipped stage skipped', () => {
    const job = new AdaptationJob('j1');
    job.apply({ type: 'stage', stage: 'analysis', state: 'skipped', note: 'reused' });
    job.apply({ type: 'stage', stage: 'discovery', state: 'active' });
    const states = Object.fromEntries(job.view().stages.map(s => [s.id, s.state]));
    assert.deepEqual(states, { analysis: 'skipped', identity: 'done', discovery: 'active', render: 'pending' });
  });

  it('tracks each picture slot on its own and ignores events for slots it does not know', () => {
    const job = new AdaptationJob('j1');
    job.apply({ type: 'slots', slots: [{ slotId: 's1', index: 0, subject: 'Mahesh Babu' }, { slotId: 's2', index: 1, subject: 'Allu Arjun' }] });
    job.apply({ type: 'slot', slotId: 's1', state: 'found', note: '4 candidates weighed' });
    job.apply({ type: 'slot', slotId: 's2', state: 'searching' });
    job.apply({ type: 'slot', slotId: 'nope', state: 'found' });
    const slots = job.view().slots;
    assert.deepEqual(slots.map(s => [s.subject, s.state]), [['Mahesh Babu', 'found'], ['Allu Arjun', 'searching']]);
    assert.equal(slots[0].note, '4 candidates weighed');
  });

  it('keeps a short log, newest last, with each line timed from the start', () => {
    let now = 0;
    const job = new AdaptationJob('j1', () => now);
    for (let i = 0; i < 60; i++) {
      now += 100;
      job.apply({ type: 'log', text: `line ${i}` });
    }
    const log = job.view().log;
    assert.equal(log.length, 12);
    assert.equal(log[log.length - 1].text, 'line 59');
    assert.equal(log[log.length - 1].atMs, 6000);
  });

  it('flattens whitespace and clips long notes, and ignores malformed events instead of throwing', () => {
    const job = new AdaptationJob('j1');
    job.apply({ type: 'log', text: `a\n\n   b ${'x'.repeat(500)}` });
    job.apply(null as never);
    job.apply({ type: 'bogus' } as never);
    job.apply({ type: 'stage', stage: 'nonsense' as never, state: 'active' });
    const [line] = job.view().log;
    assert.ok(line.text.startsWith('a b x'));
    assert.ok(line.text.length <= 160);
    assert.equal(job.view().stages.every(s => s.state === 'pending'), true);
  });

  it('shows the result only when done and the error only when failed, and stops the clock', () => {
    let now = 0;
    const done = new AdaptationJob('d', () => now);
    now = 5000;
    done.succeed({ memeId: 'm1' });
    now = 90_000;
    assert.deepEqual(done.view().result, { memeId: 'm1' });
    assert.equal(done.view().elapsedMs, 5000, 'the clock stops when the meme is ready');
    assert.deepEqual(done.view().stages.map(s => s.state), ['done', 'done', 'done', 'done']);

    const failed = new AdaptationJob('f', () => now);
    failed.fail({ status: 422, message: 'no' });
    assert.equal(failed.view().status, 'failed');
    assert.equal('result' in failed.view(), false);
    assert.deepEqual(failed.view().error, { status: 422, message: 'no' });
  });

  it('ignores events after it has finished', () => {
    const job = new AdaptationJob('j1');
    job.succeed({});
    job.apply({ type: 'log', text: 'too late' });
    assert.equal(job.view().log.length, 0);
  });
});

describe('jobErrorFrom', () => {
  it('keeps the status, message and details the synchronous endpoint would have answered', () => {
    const e = jobErrorFrom(new UnprocessableEntityException({ statusCode: 422, message: 'Could not find a picture', details: { stage: 'discovery', slots: [] } }));
    assert.deepEqual(e, { status: 422, message: 'Could not find a picture', details: { stage: 'discovery', slots: [] } });
  });
  it('joins a list of validation messages and handles a plain string', () => {
    assert.equal(jobErrorFrom(new BadRequestException({ message: ['a', 'b'] })).message, 'a b');
    assert.equal(jobErrorFrom(new BadRequestException('plain')).message, 'plain');
  });
  it('never leaks an unexpected error: it becomes a calm 500', () => {
    const e = jobErrorFrom(new Error('ECONNREFUSED mongodb://user:secret@host'));
    assert.equal(e.status, 500);
    assert.ok(!/secret|mongodb/.test(e.message));
  });
});

describe('AdaptationJobService', () => {
  it('answers at once, and the result is collected when the work finishes', async () => {
    const svc = new AdaptationJobService();
    let release!: (v: unknown) => void;
    const started = svc.start(() => new Promise(r => (release = r)));
    assert.equal(started.status, 'running');
    assert.equal(svc.get(started.id)?.status, 'running');
    assert.equal(svc.active()?.id, started.id);
    release({ memeId: 'abc' });
    await tick();
    const v = svc.get(started.id)!;
    assert.equal(v.status, 'done');
    assert.deepEqual(v.result, { memeId: 'abc' });
    assert.equal(svc.active(), undefined, 'nothing is running any more');
  });

  it('lets the work report progress, and a sink that is fed garbage never breaks it', async () => {
    const svc = new AdaptationJobService();
    let release!: (v: unknown) => void;
    const started = svc.start(sink => {
      sink({ type: 'stage', stage: 'analysis', state: 'active', note: 'reading' });
      sink(undefined as never);
      return new Promise(r => (release = r));
    });
    await tick();
    assert.equal(svc.get(started.id)!.stages[0].state, 'active');
    release({});
    await tick();
    assert.equal(svc.get(started.id)!.status, 'done');
  });

  it('a failure becomes the job error, runs the cleanup once, and does not crash the process', async () => {
    const svc = new AdaptationJobService();
    let cleaned = 0;
    const started = svc.start(
      async () => {
        throw new UnprocessableEntityException({ statusCode: 422, message: 'Could not safely identify slot 2', details: { stage: 'identity' } });
      },
      () => cleaned++
    );
    await tick();
    const v = svc.get(started.id)!;
    assert.equal(v.status, 'failed');
    assert.equal(v.error?.status, 422);
    assert.deepEqual(v.error?.details, { stage: 'identity' });
    assert.equal(cleaned, 1);
  });

  it('a cleanup that throws still ends the job as failed', async () => {
    const svc = new AdaptationJobService();
    const started = svc.start(
      async () => {
        throw new Error('boom');
      },
      () => {
        throw new Error('cleanup boom');
      }
    );
    await tick();
    assert.equal(svc.get(started.id)!.status, 'failed');
  });

  it('does not know a job it never started', () => {
    assert.equal(new AdaptationJobService().get('00000000-0000-0000-0000-000000000000'), undefined);
  });

  it('keeps a running job no matter how many finished ones pile up, and caps the finished ones', async () => {
    const svc = new AdaptationJobService();
    let release!: (v: unknown) => void;
    const running = svc.start(() => new Promise(r => (release = r)));
    for (let i = 0; i < 40; i++) {
      svc.start(async () => i);
      await tick();
    }
    assert.equal(svc.get(running.id)?.status, 'running', 'the running job is never dropped');
    assert.ok(((svc as unknown) as { jobs: Map<string, unknown> }).jobs.size <= 21);
    release({});
    await tick();
  });
});
