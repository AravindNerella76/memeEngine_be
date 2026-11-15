/**
 * Google Gemini API backend for the vision tasks (an alternative to the local Antigravity CLI).
 *
 * Why it exists: the CLI is installed and signed in on the owner's PC; a hosted server has neither.
 * The Gemini API needs only a key, so any server can run the same tasks.
 *
 * Safety by construction: the request carries only text and images and NO tools, so the model cannot
 * run commands, read files or open URLs; text inside an analysed image can only influence the JSON it
 * returns, which the caller validates exactly as it does for the CLI. The key travels in the
 * `x-goog-api-key` header (never in a URL) and is redacted from every message.
 *
 * Everything here is pure (no network) so it can be tested offline; the runner performs the call.
 */
import type { VisionPurpose } from './vision-cli.runner';

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
export const MAX_OUTPUT_TOKENS = 16384;

/** "off" omits the setting (for models that have no thinking levels). */
export type GeminiThinking = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH' | 'off';
export const GEMINI_THINKING_LEVELS: GeminiThinking[] = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'off'];

export interface GeminiModelSettings {
  analysisModel: string;
  verifyModel: string;
  instructionModel: string;
  analysisThinking: GeminiThinking;
  verifyThinking: GeminiThinking;
  instructionThinking: GeminiThinking;
}

/** Which model and thinking level a task uses (the CLI model names in the task are ignored here). */
export function geminiModelFor(s: GeminiModelSettings, purpose: VisionPurpose): { model: string; thinking: GeminiThinking } {
  if (purpose === 'reference_analysis') return { model: s.analysisModel, thinking: s.analysisThinking };
  if (purpose === 'instruction_interpretation') return { model: s.instructionModel, thinking: s.instructionThinking };
  return { model: s.verifyModel, thinking: s.verifyThinking };
}

const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const PLACEHOLDER = /\{\{IMAGE:([^}]*)\}\}/g;

/** A request that cannot be built (unsafe image name, placeholder without an image). Never retried. */
export class GeminiRequestError extends Error {}

/** MIME type from the first bytes (the images were re-encoded before they got here). */
export function sniffMime(b: Buffer): string {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

export interface GeminiRequestBody {
  contents: { role: 'user'; parts: any[] }[];
  generationConfig: { responseMimeType: 'application/json'; maxOutputTokens: number; thinkingConfig?: { thinkingLevel: string } };
}

/**
 * The prompt's {{IMAGE:name}} markers become the images themselves, in place, each preceded by a short
 * label so the prompt can keep referring to it by name.
 */
export function buildGeminiRequestBody(prompt: string, images: { name: string; data: Buffer }[] | undefined, thinking: GeminiThinking): GeminiRequestBody {
  const byName = new Map<string, Buffer>();
  for (const img of images || []) {
    if (!SAFE_NAME.test(img.name)) throw new GeminiRequestError(`Unsafe image name "${img.name}"`);
    byName.set(img.name, img.data);
  }
  const parts: any[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(prompt))) {
    const data = byName.get(m[1]);
    if (!data) throw new GeminiRequestError('Prompt references an image that was not provided');
    const before = prompt.slice(last, m.index);
    if (before.trim()) parts.push({ text: before });
    parts.push({ text: `[Image: ${m[1]}]` });
    parts.push({ inlineData: { mimeType: sniffMime(data), data: data.toString('base64') } });
    last = m.index + m[0].length;
  }
  const rest = prompt.slice(last);
  if (rest.trim()) parts.push({ text: rest });
  if (!parts.length) throw new GeminiRequestError('The prompt is empty');

  const generationConfig: GeminiRequestBody['generationConfig'] = { responseMimeType: 'application/json', maxOutputTokens: MAX_OUTPUT_TOKENS };
  if (thinking !== 'off') generationConfig.thinkingConfig = { thinkingLevel: thinking };
  return { contents: [{ role: 'user', parts }], generationConfig };
}

/** Removes the key (and anything shaped like one) from text that may be logged or shown. */
export function redactKey(text: string, key?: string): string {
  let out = String(text ?? '');
  if (key) out = out.split(key).join('***');
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '***').replace(/([?&]key=)[^&\s"']+/gi, '$1***');
}

export interface GeminiFailure {
  code: 'AUTH' | 'NOT_CONFIGURED' | 'CLI_ERROR' | 'BAD_OUTPUT';
  message: string;
  /** The outer attempt loop may try the whole task again. */
  retryable: boolean;
  /** Rate limit / overload: worth waiting briefly and repeating the same call. */
  transient: boolean;
  retryAfterMs?: number;
}

/** "23s", "0.5s" or "1500ms" -> milliseconds. */
export function parseRetryDelay(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(v.trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
}

/** Turns an HTTP error from the API into a user-readable failure and a retry decision. */
export function classifyGeminiHttpError(status: number, bodyText: string, key?: string, model?: string): GeminiFailure {
  let err: any = {};
  try {
    err = JSON.parse(bodyText)?.error || {};
  } catch {
    /* not JSON */
  }
  const googleMsg = redactKey(String(err.message || bodyText || '').replace(/\s+/g, ' ').trim(), key).slice(0, 240);
  const retryInfo = Array.isArray(err.details) ? err.details.find((d: any) => String(d?.['@type'] || '').includes('RetryInfo')) : undefined;
  const retryAfterMs = parseRetryDelay(retryInfo?.retryDelay);

  if (status === 401 || status === 403 || (status === 400 && /api key (not valid|expired)|API_KEY_INVALID/i.test(`${googleMsg} ${bodyText}`))) {
    return { code: 'AUTH', message: `Google rejected the Gemini API key (${status}${googleMsg ? `: ${googleMsg}` : ''}). Check GEMINI_API_KEY and that the Gemini API is enabled for it.`, retryable: false, transient: false };
  }
  if (status === 404) {
    return { code: 'NOT_CONFIGURED', message: `The Gemini model "${model || 'configured'}" was not found (${googleMsg}). Set GEMINI_ANALYSIS_MODEL / GEMINI_VERIFY_MODEL / GEMINI_INSTRUCTION_MODEL to a model your key can use.`, retryable: false, transient: false };
  }
  if (status === 429) {
    return { code: 'CLI_ERROR', message: `Gemini API rate limit reached${googleMsg ? `: ${googleMsg}` : ''}. A paid key has much higher limits.`, retryable: true, transient: true, retryAfterMs };
  }
  if (status === 503 || status === 502 || status === 504) {
    return { code: 'CLI_ERROR', message: `Gemini API is busy (${status})${googleMsg ? `: ${googleMsg}` : ''}`, retryable: true, transient: true, retryAfterMs };
  }
  if (status >= 500) {
    return { code: 'CLI_ERROR', message: `Gemini API error ${status}${googleMsg ? `: ${googleMsg}` : ''}`, retryable: true, transient: false };
  }
  const thinkingHint = /think/i.test(googleMsg) ? ' If the model does not support thinking levels, set the matching GEMINI_*_THINKING variable to "off".' : '';
  return { code: 'CLI_ERROR', message: `Gemini API rejected the request (${status}${googleMsg ? `: ${googleMsg}` : ''}).${thinkingHint}`, retryable: false, transient: false };
}

export interface GeminiParsed {
  text: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}

/** Reads a successful response: the answer text (thoughts excluded), why it stopped, token counts. Throws a GeminiFailure-like object when blocked or empty. */
export function parseGeminiResponse(json: any): GeminiParsed {
  const usage = json?.usageMetadata || {};
  const base = {
    inputTokens: Number.isFinite(usage.promptTokenCount) ? usage.promptTokenCount : undefined,
    outputTokens: Number.isFinite(usage.candidatesTokenCount) ? usage.candidatesTokenCount : undefined,
    thinkingTokens: Number.isFinite(usage.thoughtsTokenCount) ? usage.thoughtsTokenCount : undefined
  };
  const blockReason = json?.promptFeedback?.blockReason;
  if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
    const f: GeminiFailure = { code: 'BAD_OUTPUT', message: `Google blocked this request (${blockReason}). The picture or prompt was refused by its safety filter.`, retryable: false, transient: false };
    throw f;
  }
  const cand = json?.candidates?.[0];
  const parts: any[] = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
  const text = parts
    .filter(p => typeof p?.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');
  const finishReason: string | undefined = cand?.finishReason;
  if (!text.trim()) {
    const refused = finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason);
    const f: GeminiFailure = {
      code: 'BAD_OUTPUT',
      message: refused ? `Gemini returned no answer (${finishReason}${cand?.finishMessage ? `: ${String(cand.finishMessage).slice(0, 120)}` : ''}).` : 'Gemini returned an empty answer.',
      // a safety/policy stop will not change on a retry; an empty or cut-off answer might
      retryable: !(refused && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|IMAGE_SAFETY|SPII/.test(String(finishReason))),
      transient: false
    };
    throw f;
  }
  return { text, finishReason, ...base };
}

export function isGeminiFailure(e: any): e is GeminiFailure {
  return e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string' && typeof e.retryable === 'boolean' && !(e instanceof Error);
}
