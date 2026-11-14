/**
 * Offline tests for vision CLI configuration and the sandboxed runner, using a FAKE CLI
 * (a small Node script) so no real model is called.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { loadConfig, resolveVisionCliPath, VisionConfig } from '../config/app-config';
import { VisionCliRunner, VisionError, VisionOutputError, extractJsonObject } from '../vision/vision-cli.runner';
import { buildChildEnv, buildReadConfinementRules, DENIED_TOOL_RULES, pathVariants } from '../vision/vision-sandbox';
import { codesMatch, makeVerificationCode, prepareImageForVision } from '../vision/vision-image-prep';
import { createCanvas, loadImage } from '@napi-rs/canvas';

describe('vision CLI path resolution', () => {
  it('prefers VISION_CLI_PATH, then AGY_PATH, and ignores paths that do not exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipath-'));
    const fake = path.join(tmp, 'agy.exe');
    fs.writeFileSync(fake, 'x');
    try {
      assert.deepEqual(resolveVisionCliPath({ VISION_CLI_PATH: fake }), { cliPath: path.resolve(fake), cliPathSource: 'VISION_CLI_PATH' });
      assert.deepEqual(resolveVisionCliPath({ AGY_PATH: fake }), { cliPath: path.resolve(fake), cliPathSource: 'AGY_PATH' });
      const r = resolveVisionCliPath({ VISION_CLI_PATH: path.join(tmp, 'missing.exe'), USERPROFILE: tmp });
      assert.notEqual(r.cliPath, path.join(tmp, 'missing.exe'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('never hard-codes another user\'s profile path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config', 'app-config.ts'), 'utf8');
    assert.ok(!/Users\\\\hp|Users\/hp/.test(src));
  });

  it('reads models, timeouts and providers from the environment with safe defaults', () => {
    const cfg = loadConfig({ VISION_MODEL: 'gemini-3.8-flash-low', VISION_TIMEOUT_MS: '5', DISCOVERY_ALLOW_UNOFFICIAL: 'false' });
    assert.equal(cfg.vision.analysisModel, 'gemini-3.8-flash-low');
    assert.equal(cfg.vision.timeoutMs, 30_000, 'timeout is clamped to a sane minimum');
    assert.ok(!cfg.discovery.enabledProviders.includes('duckduckgo'));
    assert.equal(loadConfig({ VISION_MODEL: 'bad model; rm -rf /' }).vision.analysisModel, 'gemini-3.8-flash-medium');
    assert.equal(loadConfig({}).host, '127.0.0.1');
  });

  it('enables key-gated providers only when their keys are present', () => {
    assert.ok(!loadConfig({}).discovery.enabledProviders.includes('tmdb'));
    assert.ok(loadConfig({ TMDB_API_KEY: 'k' }).discovery.enabledProviders.includes('tmdb'));
    assert.ok(!loadConfig({ GOOGLE_SEARCH_API_KEY: 'k' }).discovery.enabledProviders.includes('google-cse'));
    assert.ok(loadConfig({ GOOGLE_SEARCH_API_KEY: 'k', GOOGLE_SEARCH_CX: 'c' }).discovery.enabledProviders.includes('google-cse'));
  });
});

describe('vision sandbox rules', () => {
  it('produces every spelling of a Windows path, including the /C:/ form used for file:/// links', () => {
    const v = pathVariants('E:\\a\\b');
    for (const want of ['E:\\a\\b', 'e:\\a\\b', 'E:/a/b', 'e:/a/b', '/E:/a/b', '/e:/a/b']) assert.ok(v.includes(want), want);
  });

  it('denies dangerous tools, other drives and siblings, but never the workspace or a bare root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
    const ws = path.join(tmp, 'runs', 'r1', 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'runs', 'r1', 'home'));
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 's');
    try {
      const { rules } = buildReadConfinementRules(ws);
      const has = (p: string) => rules.includes(`read_file(${p})`);
      assert.ok(has(path.join(tmp, 'secret.txt')));
      assert.ok(has(path.join(tmp, 'runs', 'r1', 'home')));
      assert.ok(!rules.some(r => r === 'read_file(/)' || r === 'read_file(\\\\)'), 'a bare root rule would also block the workspace');
      assert.ok(!rules.some(r => r.toLowerCase().startsWith(`read_file(${ws.toLowerCase()}`)), 'workspace must stay readable');
      if (process.platform === 'win32') {
        const own = path.parse(ws).root.charAt(0).toUpperCase();
        const other = own === 'Z' ? 'Y' : 'Z';
        assert.ok(has(`${other}:\\`) && has(`${other}:/`) && has(`/${other}:/`));
      }
      for (const t of DENIED_TOOL_RULES) assert.ok(['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)', 'unsandboxed(*)'].includes(t));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('strips secrets from the child environment and isolates the user profile', () => {
    const env = buildChildEnv('C:\\iso\\home', { PATH: 'p', MONGO_URI: 'mongodb://u:p@h', GOOGLE_SEARCH_API_KEY: 'k', TMDB_READ_ACCESS_TOKEN: 't', USERPROFILE: 'C:\\Users\\real', SystemRoot: 'C:\\Windows' });
    assert.equal(env.PATH, 'p');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.MONGO_URI, undefined);
    assert.equal(env.GOOGLE_SEARCH_API_KEY, undefined);
    assert.equal(env.TMDB_READ_ACCESS_TOKEN, undefined);
    assert.equal(env.USERPROFILE, path.resolve('C:\\iso\\home'));
    assert.equal(env.HOME, path.resolve('C:\\iso\\home'));
  });
});

describe('verification codes and image preparation', () => {
  it('codes use an unambiguous alphabet and match leniently', () => {
    const c = makeVerificationCode();
    assert.match(c, /^[ACDEFHJKMNPRTUVWXY3479]{6}$/);
    assert.ok(codesMatch(c, c.toLowerCase()));
    assert.ok(codesMatch('K7QXJ4', 'IMAGE CODE: K7Q-XJ4'));
    assert.ok(!codesMatch('K7QXJ4', 'K7QXJ5'));
    assert.ok(!codesMatch('K7QXJ4', undefined));
  });

  it('re-encodes, downsizes and appends a code strip below the picture', async () => {
    const big = createCanvas(4000, 3000);
    const ctx = big.getContext('2d');
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 4000, 3000);
    const prepared = await prepareImageForVision(big.toBuffer('image/png'), { code: 'ACDEFH', maxSide: 1600 });
    assert.equal(prepared.width, 1600);
    assert.equal(prepared.contentHeight, 1200);
    assert.ok(prepared.height > prepared.contentHeight);
    const decoded = await loadImage(prepared.buffer);
    assert.equal(decoded.width, 1600);
    assert.equal(prepared.buffer[0], 0xff, 'output is JPEG');
  });
});

describe('JSON extraction from model text', () => {
  it('finds the first complete object inside prose or code fences', () => {
    assert.deepEqual(extractJsonObject('```json\n{"a": {"b": "}"}, "c": [1]}\n```'), { a: { b: '}' }, c: [1] });
    assert.deepEqual(extractJsonObject('Sure! {"ok": true} hope that helps'), { ok: true });
    assert.throws(() => extractJsonObject('no json here'), VisionOutputError);
    assert.throws(() => extractJsonObject('{"a": '), VisionOutputError);
  });
});

// ------------------------------------------------------------------------------------------------
// Runner behaviour against a fake CLI (a Node script that imitates agy's JSON envelope)
// ------------------------------------------------------------------------------------------------
describe('VisionCliRunner with a fake CLI', () => {
  let tmp: string;
  let cfg: VisionConfig;
  let argLog: string;

  before(() => {
    Logger.overrideLogger(false);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecli-'));
    argLog = path.join(tmp, 'args.json');
    const script = path.join(tmp, 'fake-agy.js');
    fs.writeFileSync(script, `
      const fs = require('fs');
      const args = process.argv.slice(2);
      const prompt = args[args.indexOf('--print') + 1] || '';
      const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
      fs.writeFileSync(${JSON.stringify(argLog)}, JSON.stringify({ args, cwd: process.cwd(), home: process.env.USERPROFILE, secret: process.env.TMDB_API_KEY || null, settings, files: fs.readdirSync(process.cwd()) }));
      const mode = (prompt.match(/MODE=(\\w+)/) || [])[1];
      if (mode === 'sleep') { setTimeout(() => {}, 60000); return; }
      if (mode === 'auth') { process.stderr.write('Error: not authenticated, please sign in'); process.exit(1); }
      if (mode === 'garbage') { process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: 'I cannot help with that' })); return; }
      if (mode === 'failed') { process.stdout.write(JSON.stringify({ status: 'ERROR', error: 'model overloaded' })); return; }
      process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: '\`\`\`json\\n{"answer": 42}\\n\`\`\`', duration_seconds: 1.5, usage: { input_tokens: 100, output_tokens: 5, thinking_tokens: 0 }, denied_actions: [{ action: 'read_file' }] }));
    `);
    cfg = {
      cliPath: process.execPath,
      cliPrefixArgs: [script],
      cliPathSource: 'VISION_CLI_PATH',
      analysisModel: 'fake-model',
      verifyModel: 'fake-model',
      instructionModel: 'fake-model',
      timeoutMs: 30_000,
      maxAttempts: 2,
      maxConcurrent: 2,
      workRoot: path.join(tmp, 'work'),
      keepRunFiles: false,
      verifyCandidates: 'required'
    };
    process.env.TMDB_API_KEY = 'super-secret-test-key';
  });

  after(async () => {
    delete process.env.TMDB_API_KEY;
    // A process killed by the timeout test may hold its folder for a moment on Windows.
    for (let i = 0; i < 20; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 250));
      }
    }
  });

  const runner = () => new VisionCliRunner().useConfig(cfg);
  const task = (mode: string, extra: Partial<Parameters<VisionCliRunner['runJsonTask']>[0]> = {}) => ({
    purpose: 'probe' as const,
    model: 'fake-model',
    prompt: `MODE=${mode} look at {{IMAGE:ref.jpg}}`,
    images: [{ name: 'ref.jpg', data: Buffer.from('jpegbytes') }],
    validate: (j: any) => {
      if (typeof j?.answer !== 'number') throw new VisionOutputError('no answer');
      return j.answer as number;
    },
    ...extra
  });

  it('runs sandboxed: no skip-permissions flag, settings file, isolated home, no secrets, image in workspace, cleanup', async () => {
    const r = await runner().runJsonTask(task('ok'));
    assert.equal(r.value, 42);
    const log = JSON.parse(fs.readFileSync(argLog, 'utf8'));
    assert.ok(!log.args.includes('--dangerously-skip-permissions'));
    assert.ok(log.args.includes('--disable-slash-commands'));
    assert.equal(log.secret, null, 'API keys must not reach the CLI');
    assert.ok(String(log.home).includes(path.join('work', 'runs')), 'USERPROFILE must point to the isolated run home');
    assert.deepEqual(log.files, ['ref.jpg']);
    assert.ok(log.settings.permissions.deny.includes('command(*)'));
    assert.ok(log.args[log.args.indexOf('--print') + 1].includes('![ref.jpg](file:///'));
    assert.deepEqual(fs.readdirSync(path.join(cfg.workRoot, 'runs')), [], 'run folder removed');
    assert.equal(r.calls[0].inputTokens, 100);
    assert.deepEqual(r.calls[0].deniedActions, ['read_file']);
  });

  it('retries unusable output a bounded number of times, then fails', async () => {
    await assert.rejects(() => runner().runJsonTask(task('garbage')), (e: any) => e instanceof VisionError && e.code === 'BAD_OUTPUT' && e.calls.length === 2);
  });

  it('reports CLI failures and auth problems clearly', async () => {
    await assert.rejects(() => runner().runJsonTask(task('failed')), (e: any) => e.code === 'CLI_ERROR' && /model overloaded/.test(e.message));
    await assert.rejects(() => runner().runJsonTask(task('auth')), (e: any) => e.code === 'AUTH' && e.calls.length === 1);
  });

  it('kills a hung CLI at the timeout and cleans up', async () => {
    const started = Date.now();
    await assert.rejects(() => runner().runJsonTask(task('sleep', { timeoutMs: 1500, maxAttempts: 1 })), (e: any) => e.code === 'TIMEOUT');
    assert.ok(Date.now() - started < 10_000);
  });

  it('fails fast with a descriptive error when the CLI is not installed', async () => {
    const r = new VisionCliRunner().useConfig({ ...cfg, cliPath: path.join(tmp, 'missing.exe') });
    await assert.rejects(() => r.runJsonTask(task('ok')), (e: any) => e.code === 'NOT_CONFIGURED' && /VISION_CLI_PATH/.test(e.message));
  });

  it('rejects unsafe image names and prompts that reference missing images', async () => {
    await assert.rejects(() => runner().runJsonTask(task('ok', { images: [{ name: '../evil.jpg', data: Buffer.from('x') }], prompt: '{{IMAGE:../evil.jpg}}' })), /Unsafe image name/);
  });
});
