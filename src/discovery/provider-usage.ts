/**
 * Monthly request caps for paid search APIs (Brave, Google Cloud Vision).
 *
 * The defaults equal each provider's free allowance, so the application never causes charges
 * unless the limit is raised explicitly (BRAVE_MONTHLY_REQUEST_LIMIT, GOOGLE_VISION_MONTHLY_UNIT_LIMIT).
 * Counting is per UTC calendar month and is persisted in MongoDB (collection provider_usage), so a
 * restart does not reset it. If the counter cannot be read, the paid API is NOT called (fail closed).
 * Failed requests are counted too (conservative).
 */
import { Injectable } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Model } from 'mongoose';

export interface UsageDecision {
  allowed: boolean;
  used: number;
  limit: number;
  month: string;
}

export interface ProviderUsageStore {
  /** Atomically reserves `units` if that keeps the month's total within `limit`. */
  consume(provider: string, limit: number, units?: number): Promise<UsageDecision>;
  current(provider: string): Promise<{ used: number; month: string }>;
}

/** UTC calendar month, e.g. "2026-11". */
export function usageMonth(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Process-memory store (tests, or when no database is available to the discovery service). */
export class InMemoryProviderUsageStore implements ProviderUsageStore {
  private readonly counts = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async consume(provider: string, limit: number, units = 1): Promise<UsageDecision> {
    const month = usageMonth(this.now());
    const key = `${provider}|${month}`;
    const used = this.counts.get(key) || 0;
    if (limit <= 0 || used + units > limit) return { allowed: false, used, limit, month };
    this.counts.set(key, used + units);
    return { allowed: true, used: used + units, limit, month };
  }

  async current(provider: string) {
    const month = usageMonth(this.now());
    return { used: this.counts.get(`${provider}|${month}`) || 0, month };
  }
}

@Schema({ collection: 'provider_usage', timestamps: true })
export class ProviderUsageRecord {
  @Prop({ required: true })
  provider: string;

  @Prop({ required: true })
  month: string;

  // No schema default: the atomic upsert below sets it with $inc.
  @Prop({ type: Number })
  count: number;
}
export type ProviderUsageDocument = ProviderUsageRecord & Document;
export const ProviderUsageSchema = SchemaFactory.createForClass(ProviderUsageRecord);
ProviderUsageSchema.index({ provider: 1, month: 1 }, { unique: true });

@Injectable()
export class ProviderUsageService implements ProviderUsageStore {
  private indexes: Promise<unknown> | null = null;

  constructor(@InjectModel(ProviderUsageRecord.name) private readonly model: Model<ProviderUsageDocument>) {}

  /** The unique index is what makes the limit atomic; make sure it exists before counting. */
  private ensureIndexes(): Promise<unknown> {
    if (!this.indexes) {
      this.indexes = this.model.createIndexes().catch(e => {
        this.indexes = null;
        throw e;
      });
    }
    return this.indexes;
  }

  async consume(provider: string, limit: number, units = 1): Promise<UsageDecision> {
    const month = usageMonth();
    if (limit <= 0) return { allowed: false, used: (await this.current(provider)).used, limit, month };
    await this.ensureIndexes();
    try {
      const doc = await this.model
        .findOneAndUpdate({ provider, month, count: { $lte: limit - units } }, { $inc: { count: units } }, { upsert: true, new: true, setDefaultsOnInsert: false })
        .lean()
        .exec();
      return { allowed: true, used: Number(doc?.count) || units, limit, month };
    } catch (e: any) {
      // The month's record exists but has no room left: the upsert's insert hits the unique index.
      if (e?.code === 11000) return { allowed: false, used: (await this.current(provider)).used, limit, month };
      throw e;
    }
  }

  async current(provider: string) {
    const month = usageMonth();
    const doc = await this.model.findOne({ provider, month }).lean().exec();
    return { used: Number(doc?.count) || 0, month };
  }
}

export class ProviderLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderLimitError';
  }
}

/** Per-provider guard: reserve before every paid request; blocks the provider for the rest of the month once the cap is hit. */
export class UsageGuard {
  private blockedMonth: string | null = null;

  constructor(
    private readonly store: ProviderUsageStore,
    readonly providerId: string,
    private readonly limit: () => number,
    private readonly label: string,
    private readonly limitEnv: string
  ) {}

  isBlocked(): boolean {
    return this.blockedMonth === usageMonth();
  }

  async consume(units = 1): Promise<void> {
    let d: UsageDecision;
    try {
      d = await this.store.consume(this.providerId, this.limit(), units);
    } catch (e: any) {
      throw new ProviderLimitError(`${this.label}: the monthly usage counter is unavailable (${String(e?.message || e).slice(0, 80)}), so the paid API was not called`);
    }
    if (!d.allowed) {
      this.blockedMonth = d.month;
      throw new ProviderLimitError(
        `${this.label}: monthly limit reached (${d.used} of ${d.limit} in ${d.month}), so no more requests are sent this month. Raise ${this.limitEnv} only if you accept paid usage.`
      );
    }
  }

  async status(): Promise<{ provider: string; used: number; limit: number; month: string }> {
    const c = await this.store.current(this.providerId);
    return { provider: this.providerId, used: c.used, limit: this.limit(), month: c.month };
  }
}
