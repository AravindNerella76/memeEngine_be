/**
 * Offline tests for the Gemini API vision engine (the alternative to the local CLI). Google's API is
 * faked with a replacement for fetch; nothing leaves the machine and no real key is used.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VisionCliRunner, VisionError, VisionOutputError } from '../vision/vision-cli.runner';
import { buildGeminiRequestBody, classifyGeminiHttpError, parseGeminiResponse, parseRetryDelay, redactKey, sniffMime, GeminiRequestError } from '../vision/vision-gemini-api';
import { loadConfig, resolveVisionBackend } from '../config/app-config';

const KEY = 'AIzaSyTESTKEY' + 'k'.repeat(26);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const realFetch = globalThis.fetch;

function visionCfg(over: Record<string, unknown> = {}) {
  return { ...loadConfig({ GEMINI_API_KEY: KEY, VISION_BACKEND: 'gemini-api' } as any).vision, maxAttempts: 2, timeoutMs: 30_000, ...over } as any;
}

type Reply = { status: number; body: any };
function mockFetch(replies: Reply[] | ((n: number) => Reply)) {
  const calls: { url: string; init: any; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const n = calls.length;
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const r = typeof replies === 'function' ? replies(n) : replies[Math.min(n, replies.length - 1)];
    const text = JSON.stringify(r.body);
    return { ok: r.status < 400, status: r.status, text: async () => text, json: async () => r.body, headers: new Headers() };
  }) as any;
  return calls;
}
const answer = (text: string, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80, thoughtsTokenCount: 300 }, ...extra }
});
const task = (over: Record<string, unknown> = {}) => ({
  purpose: 'reference_analysis' as const,
  model: 'gemini-3.8-flash-medium',
  prompt: 'Look at {{IMAGE:reference.jpg}} and answer as JSON.',
  images: [{ name: 'reference.jpg', data: JPEG }],
  validate: (j: any) => j as { ok: boolean },
  ...over
});
const runner = (over: Record<string, unknown> = {}) => new VisionCliRunner().useConfig(visionCfg(over));

describe('Gemini API vision engine', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('sends the images inline in place, the key only in a header, and no tools', async () => {
    const calls = mockFetch([answer('{"ok":true}')]);
    const { value, calls: meta } = await runner().runJsonTask(task());
    assert.deepEqual(value, { ok: true });

    const c = calls[0];
    assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.ok(!c.url.includes(KEY), 'the key is never in the URL');
    assert.equal(c.init.headers['x-goog-api-key'], KEY);
    assert.deepEqual(Object.keys(c.body).sort(), ['contents', 'generationConfig'], 'no tools, no extra fields');

    const parts = c.body.contents[0].parts;
    assert.equal(parts[0].text, 'Look at ');
    assert.equal(parts[1].text, '[Image: reference.jpg]');
    assert.equal(parts[2].inlineData.mimeType, 'image/jpeg');
    assert.equal(parts[2].inlineData.data, JPEG.toString('base64'));
    assert.equal(parts[3].text, ' and answer as JSON.');
    assert.equal(c.body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(c.body.generationConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' });

    assert.equal(meta.length, 1);
    assert.equal(meta[0].ok, true);
    assert.equal(meta[0].model, 'gemini-3.8-flash', 'telemetry shows the Gemini model that really ran');
    assert.deepEqual([meta[0].inputTokens, meta[0].outputTokens, meta[0].thinkingTokens], [1200, 80, 300]);
  });

  it('uses the thinking level of each task kind and the CLI model names are ignored', async () => {
    const calls = mockFetch([answer('{"ok":true}')]);
    await runner().runJsonTask(task({ purpose: 'candidate_verification' }));
    await runner({ gemini: { ...visionCfg().gemini, instructionModel: 'gemini-3.6-flash', instructionThinking: 'off' } }).runJsonTask(task({ purpose: 'instruction_interpretation' }));
    assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    assert.ok(calls[1].url.includes('/models/gemini-3.6-flash:'));
    assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined, '"off" leaves the setting out');
  });

  it('answers text without thoughts: thought parts are ignored', async () => {
    mockFetch([{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'let me think', thought: true }, { text: '```json\n{"ok":true}\n```' }] }, finishReason: 'STOP' }] } }]);
    assert.deepEqual((await runner().runJsonTask(task())).value, { ok: true });
  });

  it('a rejected key is reported once, without retrying, and the key is never shown', async () => {
    const calls = mockFetch([{ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: `API key not valid. Please pass a valid API key. (key=${KEY})` } } }]);
    await assert.rejects(
      () => runner().runJsonTask(task()),
      (e: any) => e instanceof VisionError && e.code === 'AUTH' && !e.message.includes(KEY) && /GEMINI_API_KEY/.test(e.message) && e.calls?.length === 1
    );
    assert.equal(calls.length, 1, 'not retried');
    mockFetch([{ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'API has not been used' } } }]);
    await assert.rejects(() => runner().runJsonTask(task()), (e: any) => e.code === 'AUTH');
  });

  it('a missing model says which setting to change', async () => {
    mockFetch([{ status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'models/nope is not found' } } }]);
    await assert.rejects(() => runner().runJsonTask(task()), (e: any) => e.code === 'NOT_CONFIGURED' && /GEMINI_ANALYSIS_MODEL/.test(e.message));
  });

  it('waits out a rate limit and repeats the same call', async () => {
    const calls = mockFetch(n => (n === 0 ? { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' }] } } } : answer('{"ok":true}')));
    const { value, calls: meta } = await runner().runJsonTask(task());
    assert.deepEqual(value, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(meta.length, 1, 'one task attempt: the rate limit was handled inside the call');
  });

  it('a persistent server error uses the normal task attempts, then fails with telemetry', async () => {
    const calls = mockFetch([{ status: 500, body: { error: { code: 500, status: 'INTERNAL', message: 'oops' } } }]);
    await assert.rejects(() => runner().runJsonTask(task()), (e: any) => e instanceof VisionError && e.retryable && e.calls?.length === 2);
    assert.equal(calls.length, 2);
  });

  it('unreadable JSON is retried, then accepted', async () => {
    const calls = mockFetch(n => (n === 0 ? answer('I cannot do that') : answer('{"ok":true}')));
    const { value } = await runner().runJsonTask(task());
    assert.deepEqual(value, { ok: true });
    assert.equal(calls.length, 2);
  });

  it('the caller validator still decides (a wrong shape is rejected like for the CLI)', async () => {
    mockFetch([answer('{"ok":false}')]);
    await assert.rejects(
      () => runner().runJsonTask(task({ validate: (j: any) => { if (!j.ok) throw new VisionOutputError('not ok'); return j; } })),
      (e: any) => e instanceof VisionOutputError
    );
  });

  it('a safety block is final and explained', async () => {
    const calls = mockFetch([{ status: 200, body: { promptFeedback: { blockReason: 'IMAGE_SAFETY' } } }]);
    await assert.rejects(() => runner().runJsonTask(task()), (e: any) => e.code === 'BAD_OUTPUT' && /IMAGE_SAFETY/.test(e.message) && !e.retryable);
    assert.equal(calls.length, 1);
  });

  it('a network failure is retryable and does not leak the key', async () => {
    globalThis.fetch = (async () => { throw new Error(`connect ECONNREFUSED https://x/?key=${KEY}`); }) as any;
    await assert.rejects(() => runner().runJsonTask(task()), (e: any) => e.code === 'CLI_ERROR' && e.retryable && !e.message.includes(KEY));
  });

  it('refuses an unsafe image name and a prompt that points at a missing image', async () => {
    const calls = mockFetch([answer('{"ok":true}')]);
    await assert.rejects(() => runner().runJsonTask(task({ images: [{ name: '../evil.jpg', data: JPEG }] })), /Unsafe image name/);
    await assert.rejects(() => runner().runJsonTask(task({ images: [] })), /not provided/);
    assert.equal(calls.length, 0, 'nothing was sent');
  });

  it('is configured only with a key, and says what to do otherwise', async () => {
    const r = runner({ geminiApiKey: undefined });
    assert.equal(r.isConfigured(), false);
    assert.equal(r.describe().backend, 'gemini-api');
    await assert.rejects(() => r.runJsonTask(task()), (e: any) => e.code === 'NOT_CONFIGURED' && /GEMINI_API_KEY/.test(e.message));
    const ok = runner();
    assert.equal(ok.isConfigured(), true);
    assert.deepEqual(ok.describe().models, { analysis: 'gemini-3.8-flash', verify: 'gemini-3.8-flash', instruction: 'gemini-3.8-flash' });
  });

  it('the CLI engine keeps its behaviour (and mentions the Gemini key as the server alternative)', async () => {
    const cli = new VisionCliRunner().useConfig({ ...visionCfg(), backend: 'cli', cliPath: null } as any);
    assert.equal(cli.backend, 'cli');
    await assert.rejects(() => cli.runJsonTask(task()), (e: any) => e.code === 'NOT_CONFIGURED' && /VISION_CLI_PATH/.test(e.message) && /GEMINI_API_KEY/.test(e.message));
  });
});

describe('Gemini API pieces', () => {
  it('builds requests: no image needs no placeholder, odd mime types fall back to jpeg', () => {
    const b = buildGeminiRequestBody('just text', undefined, 'LOW');
    assert.deepEqual(b.contents[0].parts, [{ text: 'just text' }]);
    assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0])), 'image/png');
    assert.equal(sniffMime(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
    assert.equal(sniffMime(Buffer.from('????')), 'image/jpeg');
    assert.throws(() => buildGeminiRequestBody('', [], 'LOW'), GeminiRequestError);
  });

  it('classifies HTTP errors', () => {
    assert.equal(classifyGeminiHttpError(429, '{"error":{"details":[{"@type":"x.RetryInfo","retryDelay":"23s"}]}}').retryAfterMs, 23000);
    assert.equal(classifyGeminiHttpError(503, '{}').transient, true);
    assert.equal(classifyGeminiHttpError(500, '{}').transient, false);
    assert.equal(classifyGeminiHttpError(500, '{}').retryable, true);
    const think = classifyGeminiHttpError(400, '{"error":{"message":"thinking_level is not supported by this model"}}');
    assert.equal(think.retryable, false);
    assert.match(think.message, /GEMINI_\*_THINKING/);
    assert.equal(parseRetryDelay('1.5s'), 1500);
    assert.equal(parseRetryDelay('250ms'), 250);
    assert.equal(parseRetryDelay('soon'), undefined);
  });

  it('understands the real answer Google gives for a bad key (captured from the live endpoint)', () => {
    const real = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } },
          { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'API key not valid. Please pass a valid API key.' }
        ]
      }
    });
    const f = classifyGeminiHttpError(400, real, 'AIzaSyNOT-A-REAL-KEY-0000000000000000', 'gemini-3.8-flash');
    assert.equal(f.code, 'AUTH');
    assert.equal(f.retryable, false);
    assert.match(f.message, /GEMINI_API_KEY/);
  });

  it('redacts keys everywhere they could appear', () => {
    assert.ok(!redactKey(`failed for ${KEY} at https://x?key=${KEY}&a=1`, KEY).includes(KEY));
    assert.ok(!redactKey('url ?key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345', undefined).includes('AIzaSyABC'));
  });

  it('parses answers and reports empty or blocked ones', () => {
    assert.equal(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }] }).text, '{"a":1}');
    assert.throws(() => parseGeminiResponse({ candidates: [{ finishReason: 'SAFETY' }] }), (e: any) => e.code === 'BAD_OUTPUT' && e.retryable === false);
    assert.throws(() => parseGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }), (e: any) => e.retryable === true);
    assert.throws(() => parseGeminiResponse({}), (e: any) => e.code === 'BAD_OUTPUT');
  });
});

describe('choosing the vision engine', () => {
  it('automatic: the CLI when it is installed, otherwise the Gemini API when a key exists', () => {
    assert.equal(resolveVisionBackend({}, true, true), 'cli');
    assert.equal(resolveVisionBackend({}, false, true), 'gemini-api');
    assert.equal(resolveVisionBackend({}, false, false), 'cli', 'nothing configured: the old behaviour and message');
  });
  it('an explicit VISION_BACKEND wins', () => {
    assert.equal(resolveVisionBackend({ VISION_BACKEND: 'gemini-api' } as any, true, true), 'gemini-api');
    assert.equal(resolveVisionBackend({ VISION_BACKEND: 'cli' } as any, false, true), 'cli');
  });
  it('reads the key, models and thinking levels from the environment', () => {
    const v = loadConfig({ GEMINI_API_KEY: KEY, VISION_BACKEND: 'gemini-api', GEMINI_ANALYSIS_MODEL: 'gemini-3.6-flash', GEMINI_ANALYSIS_THINKING: 'high', GEMINI_VERIFY_THINKING: 'off', GEMINI_INSTRUCTION_THINKING: 'nonsense' } as any).vision;
    assert.equal(v.backend, 'gemini-api');
    assert.equal(v.geminiApiKey, KEY);
    assert.equal(v.gemini?.analysisModel, 'gemini-3.6-flash');
    assert.equal(v.gemini?.analysisThinking, 'HIGH');
    assert.equal(v.gemini?.verifyThinking, 'off');
    assert.equal(v.gemini?.instructionThinking, 'LOW', 'an unknown level falls back to the default');
    assert.equal(v.gemini?.verifyModel, 'gemini-3.8-flash');
  });
  it('ignores a key that is not shaped like one', () => {
    assert.equal(loadConfig({ GEMINI_API_KEY: 'short' } as any).vision.geminiApiKey, undefined);
    assert.equal(loadConfig({ GEMINI_API_KEY: 'has spaces and !!! not a key at all' } as any).vision.geminiApiKey, undefined);
  });
});
