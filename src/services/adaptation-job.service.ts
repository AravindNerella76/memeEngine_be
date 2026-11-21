import { EventEmitter } from 'events';
/**
 * Runs viral adaptations in the background so the app can watch real progress, leave the page, refresh or close the
 * tab, and come back to the finished meme. The pipeline is the same one POST /api/memes/adapt-viral runs; this only
 * wraps it (the WhatsApp bot and the old endpoint do not use it).
 *
 * Jobs live in memory: they exist while the work runs and for a while after, so the app can collect the result.
 * The meme itself is saved by the pipeline, so a server restart loses only the progress view, never a finished meme.
 */
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AdaptationJob, JobError, JobView, ProgressSink } from '../jobs/adaptation-progress';

const KEEP_FINISHED_MS = 30 * 60 * 1000;
const MAX_JOBS = 20;

/** The same message and details the synchronous endpoint would have answered with. */
export function jobErrorFrom(err: unknown): JobError {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const body = err.getResponse();
    if (body && typeof body === 'object') {
      const o = body as { message?: unknown; details?: unknown };
      const message = Array.isArray(o.message) ? o.message.join(' ') : typeof o.message === 'string' ? o.message : err.message;
      return { status, message, details: o.details };
    }
    return { status, message: typeof body === 'string' ? body : err.message };
  }
  return { status: 500, message: 'The meme could not be made because of an unexpected error on the server. Nothing was published.' };
}

@Injectable()
export class AdaptationJobService {
  private readonly logger = new Logger(AdaptationJobService.name);
  private readonly jobs = new Map<string, AdaptationJob>();
  /** 'finished' (JobView) once a job is done or failed: push notifications listen. Listener errors never reach the job. */
  readonly events = new EventEmitter();

  /**
   * Starts `run` in the background and returns at once. `onFailure` runs if it fails (e.g. to delete the uploads
   * nothing references any more).
   */
  start(run: (sink: ProgressSink) => Promise<unknown>, onFailure?: () => void): JobView {
    this.purge();
    const job = new AdaptationJob(randomUUID());
    this.jobs.set(job.id, job);
    const sink: ProgressSink = e => {
      try {
        job.apply(e);
      } catch {
        /* progress is a courtesy: it must never break the pipeline */
      }
    };
    // not awaited on purpose: the caller gets the job id immediately
    void (async () => {
      try {
        job.succeed(await run(sink));
        this.announce(job);
      } catch (err) {
        const error = jobErrorFrom(err);
        if (error.status >= 500) this.logger.error(`Adaptation job ${job.id} failed: ${(err as Error)?.message || err}`);
        try {
          onFailure?.();
        } catch {
          /* cleanup is best effort */
        }
        job.fail(error);
        this.announce(job);
      }
    })();
    return job.view();
  }

  private announce(job: AdaptationJob): void {
    try {
      this.events.emit('finished', job.view());
    } catch (err) {
      this.logger.warn(`A job listener failed: ${(err as Error)?.message || err}`);
    }
  }

  get(id: string): JobView | undefined {
    return this.jobs.get(id)?.view();
  }

  /** The job still running, if any (so the app can pick it up again after a refresh). */
  active(): JobView | undefined {
    for (const j of this.jobs.values()) if (j.status === 'running') return j.view();
    return undefined;
  }

  private purge(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.finishedAt && now - j.finishedAt > KEEP_FINISHED_MS) this.jobs.delete(id);
    // never drop one that is running; drop the oldest finished ones beyond the cap
    const finished = Array.from(this.jobs.values()).filter(j => j.finishedAt).sort((a, b) => (a.finishedAt as number) - (b.finishedAt as number));
    while (this.jobs.size >= MAX_JOBS && finished.length) this.jobs.delete((finished.shift() as AdaptationJob).id);
  }
}
