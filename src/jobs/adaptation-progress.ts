/**
 * Live progress of one viral adaptation. The pipeline reports what it is really doing (a stage began, a picture
 * was found for slot 2); this folds those events into the snapshot the app polls. Pure and in memory: no timers,
 * no I/O, nothing is stored with the meme.
 *
 * Nothing in here is a guess: a stage is "active" only while the pipeline is inside it.
 */

export type StageId = 'analysis' | 'identity' | 'discovery' | 'render';
export type StageState = 'pending' | 'active' | 'done' | 'skipped';
export type SlotState = 'waiting' | 'searching' | 'found' | 'yours' | 'failed';

export type ProgressEvent =
  | { type: 'stage'; stage: StageId; state: 'active' | 'done' | 'skipped'; note?: string }
  | { type: 'slots'; slots: { slotId: string; index: number; subject: string }[] }
  | { type: 'slot'; slotId: string; state: Exclude<SlotState, 'waiting'>; note?: string }
  | { type: 'log'; text: string };

/** What the pipeline calls. Always optional, and must never throw into the pipeline. */
export type ProgressSink = (event: ProgressEvent) => void;

export const STAGE_ORDER: StageId[] = ['analysis', 'identity', 'discovery', 'render'];
const MAX_LOG = 40;
const MAX_NOTE = 160;

export interface JobError {
  status: number;
  message: string;
  details?: unknown;
}

export interface JobView {
  id: string;
  status: 'running' | 'done' | 'failed';
  /** Milliseconds since the job began (the app turns this into a clock without trusting the two machines' clocks). */
  elapsedMs: number;
  stages: { id: StageId; state: StageState; note?: string }[];
  slots: { slotId: string; index: number; subject: string; state: SlotState; note?: string }[];
  log: { atMs: number; text: string }[];
  result?: unknown;
  error?: JobError;
}

const clip = (s: string | undefined) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE) : undefined);

export class AdaptationJob {
  readonly createdAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'failed' = 'running';
  result?: unknown;
  error?: JobError;
  private readonly stages = new Map<StageId, { state: StageState; note?: string }>(STAGE_ORDER.map(s => [s, { state: 'pending' as StageState }]));
  private slots: { slotId: string; index: number; subject: string; state: SlotState; note?: string }[] = [];
  private log: { atMs: number; text: string }[] = [];

  constructor(readonly id: string, private readonly now: () => number = Date.now) {
    this.createdAt = now();
  }

  /** Feed one pipeline event. Unknown or malformed events are ignored, never thrown. */
  apply(e: ProgressEvent): void {
    if (this.status !== 'running' || !e || typeof e !== 'object') return;
    switch (e.type) {
      case 'stage': {
        const st = this.stages.get(e.stage);
        if (!st) return;
        st.state = e.state;
        st.note = clip(e.note);
        // a stage that began means every earlier one is over (a skipped stage never reports)
        const at = STAGE_ORDER.indexOf(e.stage);
        STAGE_ORDER.slice(0, at).forEach(id => {
          const earlier = this.stages.get(id)!;
          if (earlier.state === 'pending' || earlier.state === 'active') earlier.state = 'done';
        });
        return;
      }
      case 'slots':
        this.slots = (e.slots || []).slice(0, 12).map(s => ({ slotId: String(s.slotId), index: Number(s.index) || 0, subject: clip(s.subject) || `Picture ${(Number(s.index) || 0) + 1}`, state: 'waiting' as SlotState }));
        return;
      case 'slot': {
        const slot = this.slots.find(s => s.slotId === e.slotId);
        if (!slot) return;
        slot.state = e.state;
        slot.note = clip(e.note);
        return;
      }
      case 'log': {
        const text = clip(e.text);
        if (!text) return;
        this.log.push({ atMs: this.now() - this.createdAt, text });
        if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
        return;
      }
    }
  }

  succeed(result: unknown): void {
    this.status = 'done';
    this.result = result;
    this.finishedAt = this.now();
    this.stages.forEach(s => {
      if (s.state === 'pending' || s.state === 'active') s.state = 'done';
    });
  }

  fail(error: JobError): void {
    this.status = 'failed';
    this.error = error;
    this.finishedAt = this.now();
  }

  view(): JobView {
    const end = this.finishedAt ?? this.now();
    return {
      id: this.id,
      status: this.status,
      elapsedMs: Math.max(0, end - this.createdAt),
      stages: STAGE_ORDER.map(id => ({ id, ...this.stages.get(id)! })),
      slots: this.slots.map(s => ({ ...s })),
      log: this.log.slice(-12),
      ...(this.status === 'done' ? { result: this.result } : {}),
      ...(this.status === 'failed' ? { error: this.error } : {})
    };
  }
}
