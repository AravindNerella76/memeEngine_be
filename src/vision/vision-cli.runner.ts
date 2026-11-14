/**
 * Runs the Antigravity CLI (agy) as a sandboxed, single-purpose vision/text model.
 *
 * Every run:
 *  - gets a fresh folder <workRoot>/runs/<id>/ with a private `workspace` (only the images for
 *    this task), an isolated `home` (USERPROFILE) and a settings file with deny rules;
 *  - never uses --dangerously-skip-permissions; commands, writes, URL access, MCP and reads
 *    outside the workspace are denied (see vision-sandbox.ts);
 *  - is bounded by a timeout (the whole process tree is killed) and a concurrency limit;
 *  - must return JSON that the caller's validator accepts, otherwise it is retried a bounded
 *    number of times;
 *  - is deleted afterwards (images, transcripts, CLI state).
 */
import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, VisionConfig } from '../config/app-config';
import { buildChildEnv, buildCliSettings } from './vision-sandbox';

export type VisionPurpose = 'reference_analysis' | 'candidate_verification' | 'instruction_interpretation' | 'probe';

export type VisionErrorCode = 'NOT_CONFIGURED' | 'TIMEOUT' | 'AUTH' | 'CLI_ERROR' | 'BAD_OUTPUT' | 'UNSEEN_IMAGE';

export class VisionError extends Error {
  /** Per-attempt telemetry, attached when a task finally fails. */
  calls?: VisionCallMeta[];
  constructor(public readonly code: VisionErrorCode, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'VisionError';
  }
}

/** Thrown by validators when the model output is unusable (retryable). */
export class VisionOutputError extends VisionError {
  constructor(message: string, code: VisionErrorCode = 'BAD_OUTPUT') {
    super(code, message, true);
    this.name = 'VisionOutputError';
  }
}

export interface VisionImageInput {
  /** Base file name inside the workspace, e.g. "reference.jpg". [a-z0-9_.-] only. */
  name: string;
  data: Buffer;
}

export interface VisionCallMeta {
  purpose: VisionPurpose;
  model: string;
  attempt: number;
  ok: boolean;
  durationMs: number;
  modelSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  deniedActions: string[];
  error?: string;
}

export interface VisionJsonTask<T> {
  purpose: VisionPurpose;
  model: string;
  /** Prompt text. Use {{IMAGE:name}} where an image should be referenced. */
  prompt: string;
  images?: VisionImageInput[];
  timeoutMs?: number;
  maxAttempts?: number;
  /** Converts the parsed JSON into a trusted value; throw VisionOutputError if unusable. */
  validate: (json: unknown, rawText: string) => T;
}

export interface VisionJsonResult<T> {
  value: T;
  calls: VisionCallMeta[];
}

interface CliEnvelope {
  status?: string;
  response?: string;
  duration_seconds?: number;
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number };
  denied_actions?: { action?: string; display_name?: string }[];
  error?: string;
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]{0,60}$/;

/** Extracts the first complete JSON object from model text (tolerates ``` fences and prose). */
export function extractJsonObject(text: string): unknown {
  if (typeof text !== 'string') throw new VisionOutputError('Model returned no text');
  const s = text.replace(/^﻿/, '');
  const start = s.indexOf('{');
  if (start < 0) throw new VisionOutputError('Model output contains no JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch (e: any) {
          throw new VisionOutputError(`Model JSON is malformed: ${e.message}`);
        }
      }
    }
  }
  throw new VisionOutputError('Model JSON object is incomplete');
}

function parseEnvelope(stdout: string): CliEnvelope {
  const trimmed = stdout.trim();
  if (!trimmed) throw new VisionError('CLI_ERROR', 'Vision CLI produced no output', true);
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const l of lines) {
      try {
        return JSON.parse(l);
      } catch {
        /* keep looking */
      }
    }
    throw new VisionError('CLI_ERROR', 'Vision CLI output was not JSON', true);
  }
}

@Injectable()
export class VisionCliRunner {
  private readonly logger = new Logger(VisionCliRunner.name);
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private lastSweep = 0;
  private cfgOverride: VisionConfig | null = null;

  /** Test hook: use a specific configuration (e.g. a fake CLI) instead of the process config. */
  useConfig(cfg: VisionConfig | null): this {
    this.cfgOverride = cfg;
    return this;
  }

  get cfg(): VisionConfig {
    return this.cfgOverride ?? getConfig().vision;
  }

  isConfigured(): boolean {
    return Boolean(this.cfg.cliPath && fs.existsSync(this.cfg.cliPath));
  }

  describe(): { configured: boolean; cliPath: string | null; source: string; models: Record<string, string> } {
    return {
      configured: this.isConfigured(),
      cliPath: this.cfg.cliPath,
      source: this.cfg.cliPathSource,
      models: { analysis: this.cfg.analysisModel, verify: this.cfg.verifyModel, instruction: this.cfg.instructionModel }
    };
  }

  async runJsonTask<T>(task: VisionJsonTask<T>): Promise<VisionJsonResult<T>> {
    if (!this.isConfigured()) {
      throw new VisionError(
        'NOT_CONFIGURED',
        'The vision CLI (Antigravity "agy") was not found. Install it, or set VISION_CLI_PATH in memeEngine_be/.env to the full path of agy.exe.'
      );
    }
    const attempts = Math.max(1, task.maxAttempts ?? this.cfg.maxAttempts);
    const calls: VisionCallMeta[] = [];
    let lastError: VisionError | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const started = Date.now();
      const meta: VisionCallMeta = { purpose: task.purpose, model: task.model, attempt, ok: false, durationMs: 0, deniedActions: [] };
      calls.push(meta);
      try {
        const envelope = await this.withSlot(() => this.runOnce(task, meta));
        const text = String(envelope.response ?? '');
        const json = extractJsonObject(text);
        const value = task.validate(json, text);
        meta.ok = true;
        meta.durationMs = Date.now() - started;
        this.logger.log(
          `vision[${task.purpose}] ok model=${task.model} attempt=${attempt} ${(meta.durationMs / 1000).toFixed(1)}s ` +
          `tokens in/out/think=${meta.inputTokens ?? '?'}/${meta.outputTokens ?? '?'}/${meta.thinkingTokens ?? '?'}` +
          (meta.deniedActions.length ? ` denied=${meta.deniedActions.join(',')}` : '')
        );
        return { value, calls };
      } catch (err: any) {
        meta.durationMs = Date.now() - started;
        const ve = err instanceof VisionError ? err : new VisionError('CLI_ERROR', err?.message || String(err), true);
        meta.error = `${ve.code}: ${ve.message}`.slice(0, 300);
        lastError = ve;
        this.logger.warn(`vision[${task.purpose}] attempt ${attempt}/${attempts} failed: ${meta.error}`);
        if (!ve.retryable) break;
      }
    }
    const err = lastError ?? new VisionError('CLI_ERROR', 'Vision task failed');
    err.calls = calls;
    throw err;
  }

  private async withSlot<R>(fn: () => Promise<R>): Promise<R> {
    while (this.active >= this.cfg.maxConcurrent) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  private sweepStaleRuns(runsRoot: string): void {
    if (Date.now() - this.lastSweep < 10 * 60 * 1000) return;
    this.lastSweep = Date.now();
    try {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const name of fs.readdirSync(runsRoot)) {
        const p = path.join(runsRoot, name);
        try {
          if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  private removeRunDir(runDir: string): void {
    if (this.cfg.keepRunFiles) return;
    try {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e: any) {
      this.logger.warn(`Could not remove vision run folder (will be swept later): ${e.message}`);
    }
  }

  private runOnce<T>(task: VisionJsonTask<T>, meta: VisionCallMeta): Promise<CliEnvelope> {
    const runsRoot = path.join(this.cfg.workRoot, 'runs');
    fs.mkdirSync(runsRoot, { recursive: true });
    this.sweepStaleRuns(runsRoot);

    const runDir = path.join(runsRoot, randomUUID());
    const workspace = path.join(runDir, 'workspace');
    const home = path.join(runDir, 'home');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home, { recursive: true });

    let prompt = task.prompt;
    for (const img of task.images || []) {
      if (!SAFE_NAME.test(img.name)) throw new VisionError('CLI_ERROR', `Unsafe image name "${img.name}"`);
      const p = path.join(workspace, img.name);
      fs.writeFileSync(p, img.data);
      const link = `![${img.name}](file:///${p.split(path.sep).join('/')})`;
      prompt = prompt.split(`{{IMAGE:${img.name}}}`).join(link);
    }
    if (/\{\{IMAGE:[^}]*\}\}/.test(prompt)) {
      this.removeRunDir(runDir);
      throw new VisionError('CLI_ERROR', 'Prompt references an image that was not provided');
    }

    const { settings, truncatedLevels } = buildCliSettings(workspace);
    if (truncatedLevels.length) this.logger.warn(`Sandbox rule list truncated for very large folders: ${truncatedLevels.join(', ')}`);
    const settingsPath = path.join(runDir, 'cli-settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const timeoutMs = task.timeoutMs ?? this.cfg.timeoutMs;
    const cliTimeoutSec = Math.max(20, Math.floor(timeoutMs / 1000) - 10);
    const args = [
      ...(this.cfg.cliPrefixArgs || []),
      '--model', task.model,
      '--output-format', 'json',
      '--print-timeout', `${cliTimeoutSec}s`,
      '--disable-slash-commands',
      '--settings', settingsPath,
      '--print', prompt
    ];

    return new Promise<CliEnvelope>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let exited = false;
      const child = spawn(this.cfg.cliPath as string, args, {
        cwd: workspace,
        env: buildChildEnv(home),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A killed process may still hold its working folder for a moment (Windows): only delete
        // the run folder once the process has exited (the 'close' handler does it otherwise).
        if (exited) this.removeRunDir(runDir);
        fn();
      };

      const timer = setTimeout(() => {
        this.killTree(child.pid);
        finish(() => reject(new VisionError('TIMEOUT', `Vision model did not answer within ${Math.round(timeoutMs / 1000)}s`, true)));
      }, timeoutMs);
      child.on('exit', () => {
        exited = true;
        if (settled) setTimeout(() => this.removeRunDir(runDir), 300);
      });

      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += d.toString('utf8');
      });
      child.on('error', (err: any) => {
        finish(() => reject(new VisionError(err?.code === 'ENOENT' ? 'NOT_CONFIGURED' : 'CLI_ERROR', `Could not start the vision CLI: ${err.message}`)));
      });
      child.on('close', (code: number | null) => {
        finish(() => {
          const errText = stderr.trim();
          if (/not authenticated|sign[ -]?in|log ?in required|unauthenticated|credentials/i.test(errText) && !stdout.trim()) {
            return reject(new VisionError('AUTH', 'The vision CLI is not signed in. Run "agy" once in a terminal and sign in, then try again.'));
          }
          if (code === 3) {
            return reject(new VisionError('TIMEOUT', 'Vision CLI print timeout reached', true));
          }
          let env: CliEnvelope;
          try {
            env = parseEnvelope(stdout);
          } catch (e: any) {
            return reject(e instanceof VisionError ? e : new VisionError('CLI_ERROR', e.message, true));
          }
          meta.modelSeconds = env.duration_seconds;
          meta.inputTokens = env.usage?.input_tokens;
          meta.outputTokens = env.usage?.output_tokens;
          meta.thinkingTokens = env.usage?.thinking_tokens;
          meta.deniedActions = (env.denied_actions || []).map(a => String(a.action || a.display_name || 'unknown')).slice(0, 10);
          if (env.status && env.status !== 'SUCCESS') {
            return reject(new VisionError('CLI_ERROR', `Vision CLI reported ${env.status}${env.error ? ': ' + String(env.error).slice(0, 200) : ''}`, true));
          }
          if (code !== 0 && code !== null && !env.response) {
            return reject(new VisionError('CLI_ERROR', `Vision CLI exited with code ${code}: ${errText.slice(0, 200)}`, true));
          }
          resolve(env);
        });
      });
    });
  }

  private killTree(pid?: number): void {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* already gone */
    }
  }
}
