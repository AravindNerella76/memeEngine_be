/**
 * Central application configuration, read from environment variables (optionally loaded from
 * memeEngine_be/.env at startup). Every value has a safe default so the app runs without a .env.
 *
 * Secrets (API keys) are only ever read here and passed to the code that needs them. They are
 * never logged: use describeConfig() for a redacted view.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizePhoneList } from './phone-list';
import { GEMINI_DEFAULT_BASE, GEMINI_DEFAULT_MODEL, GEMINI_THINKING_LEVELS, GeminiModelSettings, GeminiThinking } from '../vision/vision-gemini-api';

export const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

export type VisionVerifyMode = 'required' | 'off';

/** Which engine runs the vision tasks: the local Antigravity CLI, or the Gemini API (needs only a key). */
export type VisionBackend = 'cli' | 'gemini-api';

/**
 * Which images discovery may use for subject slots.
 *  - 'allow_copyrighted' (default): copyrighted images (film stills, studio promotional images,
 *    celebrity, news and editorial photos) may be discovered and used. Every selected image is
 *    labelled either "openly licensed" or "copyrighted, reuse permission not confirmed".
 *  - 'open_license_only': only openly licensed images (public domain, CC0, CC BY, CC BY-SA ...).
 * Identity, visual verification, relevance and image-quality checks are identical in both modes.
 */
export type RightsPolicy = 'allow_copyrighted' | 'open_license_only';

export interface VisionConfig {
  /** Resolved path of the Antigravity CLI (agy), or null when it cannot be found. */
  cliPath: string | null;
  cliPathSource: 'VISION_CLI_PATH' | 'AGY_PATH' | 'home' | 'USERPROFILE' | 'not_found';
  /** Test-only: arguments placed before the CLI flags (e.g. a script path when cliPath is node). */
  cliPrefixArgs?: string[];
  /** Engine for the vision tasks. Missing = 'cli'. Automatic choice: the CLI when it is installed, else the Gemini API when a key is set. */
  backend?: VisionBackend;
  /** Gemini API key (GEMINI_API_KEY). Used only when backend is 'gemini-api'. Never logged or sent to the browser. */
  geminiApiKey?: string;
  /** GEMINI_API_KEY is set but does not look like a key (spaces, too short ...), so it is not used. */
  geminiKeyIgnored?: boolean;
  geminiApiBase?: string;
  /** Gemini model ids and thinking levels per task (the CLI model names above are not used by the API). */
  gemini?: GeminiModelSettings;
  analysisModel: string;
  verifyModel: string;
  instructionModel: string;
  /** Hard limit for a single CLI run (the CLI's own --print-timeout is set a little lower). */
  timeoutMs: number;
  /** Attempts per vision task for transient failures (timeouts, unreadable output). */
  maxAttempts: number;
  /** Maximum number of CLI processes running at the same time. */
  maxConcurrent: number;
  /** Root folder for per-run sandbox workspaces and isolated CLI profiles. */
  workRoot: string;
  /** Keep per-run folders after a run (debugging only). */
  keepRunFiles: boolean;
  /** "required": every selected subject image must pass visual verification. "off": metadata ranking only. */
  verifyCandidates: VisionVerifyMode;
}

export interface DiscoveryConfig {
  enabledProviders: string[];
  allowUnofficialProviders: boolean;
  rightsPolicy: RightsPolicy;
  googleApiKey?: string;
  googleCx?: string;
  tmdbApiKey?: string;
  tmdbReadAccessToken?: string;
  /**
   * TMDB's standard API terms forbid commercial use, use in AI-based applications and derivative
   * works. The TMDB provider only runs when this is true, i.e. you have a written agreement with
   * TMDB that permits this application's use.
   */
  tmdbCommercialAgreement: boolean;
  /** Brave Search API key (image search). Paid per request; see braveMonthlyLimit. */
  braveApiKey?: string;
  /** Hard cap on Brave requests per calendar month (default 1000, about the $5 monthly free credit). */
  braveMonthlyLimit: number;
  /** Brave country code (e.g. IN) or ALL. */
  braveCountry: string;
  /** Brave requests per subject slot (each costs one request). */
  braveMaxQueriesPerSlot: number;
  /** Google Cloud Vision API key (Web Detection = reverse image search of the reference crop). */
  googleVisionApiKey?: string;
  /** Hard cap on Web Detection units per calendar month (default 1000 = Google's free tier). */
  googleVisionMonthlyLimit: number;
  /** Unused legacy variable (DISCOVERY_MAX_CANDIDATES_PER_SLOT); see maxDownloadsPerSlot. */
  maxCandidatesPerSlot: number;
  shortlistSize: number;
  maxRounds: number;
  requestTimeoutMs: number;
  downloadTimeoutMs: number;
  slotTimeoutMs: number;
  /** Allow a type-compatible image when the exact requested type (e.g. movie still) cannot be found. */
  allowImageTypeFallback: boolean;
  userAgent: string;
  /** Candidates downloaded and checked per slot. */
  maxDownloadsPerSlot: number;
  /** Minimum confidence of an accepted visual verdict (never below 0.6). */
  visualMinConfidence: number;
  /** Picture-hash distance at or below which two images count as the same picture. */
  duplicateHamming: number;
  /** Minimum width/height of an internet image (px; never below 250). */
  minImageSide: number;
  /** Largest allowed enlargement of an internet image (never above 2.5). */
  maxUpscale: number;
  /** 'prefer_clean': watermarked/overlaid-text pictures only when no clean verified one exists. 'reject': never. */
  watermarkPolicy: 'prefer_clean' | 'reject';
}

export interface IdentityConfig {
  /** Minimum AI confidence for accepting an AI-provided identity for an unnamed or ambiguous subject. */
  aiMinConfidence: number;
}

export interface InstagramConfig {
  metaAppId: string;
  metaAppSecret?: string;
  instagramAppId?: string;
  loginConfigId: string;
  redirectUri: string;
  tokenEncryptionKey?: string;
  targetUsername: string;
  /** Public HTTPS origin Meta fetches generated images from (PUBLIC_BASE_URL). */
  publicBaseUrl: string;
}

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  /** Digits with country code; several numbers are comma-separated (see phone-list.ts). Empty = nobody is allowed. */
  allowedPhone: string;
  apiVersion: string;
  /** Meta app secret used to verify webhook signatures (WHATSAPP_APP_SECRET, falls back to META_APP_SECRET). */
  appSecret?: string;
}

export type LogLevelSetting = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

/**
 * Login and hosting. Everything here comes from .env only (never from Settings): a saved setting must
 * not be able to weaken the sign-in rules.
 */
export interface AuthConfig {
  /** AUTH_ENABLED (default true). The server refuses to start with login off while reachable from outside. */
  enabled: boolean;
  /** APP_HOSTS: host names (no port) that serve the whole app behind login, e.g. "studio.example.com". */
  appHosts: string[];
  /** APP_PUBLIC_URL: the address the owner opens in the browser. OAuth returns the browser here. */
  appPublicUrl: string;
  /**
   * AUTH_STATIC_USERNAME + AUTH_STATIC_PASSWORD: a fixed login from the environment, no command needed.
   * For development and first deploys only: the password sits in plain text in .env / the host's settings.
   */
  staticUsername?: string;
  staticPassword?: string;
  /** AUTH_COOKIE_SECURE: send the session cookie over HTTPS only. Default: on when APP_PUBLIC_URL is https. */
  cookieSecure: boolean;
  /** AUTH_SESSION_IDLE_DAYS: a session ends after this many days without use. */
  sessionIdleDays: number;
  /** AUTH_SESSION_MAX_DAYS: a session ends this many days after sign-in, however active. */
  sessionMaxDays: number;
  /** TRUST_PROXY: number of reverse proxies in front of the server (0 = none). Needed for client IPs and HTTPS detection. */
  trustProxy: number;
  /** AUTH_MAX_FAILURES wrong passwords for one username (or AUTH_MAX_FAILURES_PER_IP*4 from one address) lock sign-in. */
  maxFailures: number;
  /** AUTH_LOCK_MINUTES: how long a lock lasts. */
  lockMinutes: number;
}

export interface AppConfig {
  mongoUri: string;
  host: string;
  port: number;
  adaptationMaxConcurrent: number;
  vision: VisionConfig;
  discovery: DiscoveryConfig;
  identity: IdentityConfig;
  instagram: InstagramConfig;
  whatsapp: WhatsAppConfig;
  auth: AuthConfig;
  limits: { maxUploadBytes: number };
  /** Adds a redacted configuration snapshot to generation reports and logs pipeline details. */
  diagnostics: boolean;
  logLevel: LogLevelSetting;
}

/** Hard upload limit (also enforced by the upload middleware). Settings can only lower it. */
export const HARD_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Pipeline values saved in Settings (database), applied on top of the .env configuration.
 * They cannot enable a provider whose .env key/list does not allow it, raise monthly caps, or make
 * identity, visual-verification or image-quality checks less strict than the .env/built-in values.
 */
export interface RuntimeOverrides {
  discovery?: {
    disabledProviders?: string[];
    rightsPolicy?: RightsPolicy;
    maxDownloadsPerSlot?: number;
    maxRounds?: number;
    visualMinConfidence?: number;
    duplicateHamming?: number;
    minImageSide?: number;
    maxUpscale?: number;
    watermarkPolicy?: 'prefer_clean' | 'reject';
    downloadTimeoutMs?: number;
  };
  vision?: { timeoutMs?: number; maxAttempts?: number };
  identity?: { aiMinConfidence?: number };
  adaptationMaxConcurrent?: number;
  limits?: { maxUploadBytes?: number };
  diagnostics?: boolean;
  logLevel?: LogLevelSetting;
}

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  let v = env[key];
  if (typeof v !== 'string') return undefined;
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v ? v : undefined;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = str(env, key);
  if (raw === undefined) return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

/** "https://Studio.Example.com:443/, other.host" -> ["studio.example.com", "other.host"] (host names only). */
export function parseHostList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''))
    .filter(Boolean);
}

function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const staticUser = str(env, 'AUTH_STATIC_USERNAME');
  const staticPass = typeof env.AUTH_STATIC_PASSWORD === 'string' && env.AUTH_STATIC_PASSWORD.length > 0 ? env.AUTH_STATIC_PASSWORD : undefined; // exact, not trimmed
  const hasStatic = Boolean(staticUser && staticPass);
  const appPublicUrl =(str(env, 'APP_PUBLIC_URL') || 'http://localhost:5173').replace(/\/+$/, '');
  return {
    enabled: bool(env, 'AUTH_ENABLED', true),
    appHosts: parseHostList(env.APP_HOSTS),
    appPublicUrl,
    staticUsername: hasStatic ? staticUser : undefined,
    staticPassword: hasStatic ? staticPass : undefined,
    cookieSecure: bool(env, 'AUTH_COOKIE_SECURE', /^https:\/\//i.test(appPublicUrl)),
    sessionIdleDays: int(env, 'AUTH_SESSION_IDLE_DAYS', 7, 1, 90),
    sessionMaxDays: int(env, 'AUTH_SESSION_MAX_DAYS', 30, 1, 365),
    trustProxy: int(env, 'TRUST_PROXY', 0, 0, 5),
    maxFailures: int(env, 'AUTH_MAX_FAILURES', 5, 3, 20),
    lockMinutes: int(env, 'AUTH_LOCK_MINUTES', 15, 1, 1440)
  };
}

function model(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = str(env, key);
  return v && MODEL_RE.test(v) ? v : fallback;
}

/** Finds the agy CLI: explicit env path first, then the standard per-user install location. */
export function resolveVisionCliPath(env: NodeJS.ProcessEnv = process.env): Pick<VisionConfig, 'cliPath' | 'cliPathSource'> {
  const binary = process.platform === 'win32' ? 'agy.exe' : 'agy';
  for (const key of ['VISION_CLI_PATH', 'AGY_PATH'] as const) {
    const p = str(env, key);
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return { cliPath: path.resolve(p), cliPathSource: key };
  }
  const homeCandidate = path.join(os.homedir(), '.gemini', 'bin', binary);
  if (fs.existsSync(homeCandidate)) return { cliPath: homeCandidate, cliPathSource: 'home' };
  const profile = str(env, 'USERPROFILE');
  if (profile) {
    const p = path.join(profile, '.gemini', 'bin', binary);
    if (fs.existsSync(p)) return { cliPath: p, cliPathSource: 'USERPROFILE' };
  }
  return { cliPath: null, cliPathSource: 'not_found' };
}

/**
 * Google issues keys in more than one shape (the older "AIza..." and newer ones such as "AQ.Ab8..." that
 * contain a dot), so only what would be unsafe in an HTTP header is refused: whitespace and control characters.
 */
const GEMINI_KEY_RE = /^[\x21-\x7E]{20,300}$/;

/** A pasted value often arrives with quotes around it ("AQ...") or after a copy of the whole line. */
function cleanKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/^["'`]+|["'`]+$/g, '').trim() || undefined;
}

function thinking(env: NodeJS.ProcessEnv, key: string, fallback: GeminiThinking): GeminiThinking {
  const v = (str(env, key) || '').toUpperCase();
  const found = GEMINI_THINKING_LEVELS.find(l => l.toUpperCase() === v);
  return found || fallback;
}

/** Chooses the vision engine: an explicit VISION_BACKEND wins; otherwise the CLI when found, else the API when a key exists. */
export function resolveVisionBackend(env: NodeJS.ProcessEnv, cliFound: boolean, hasKey: boolean): VisionBackend {
  const want = (str(env, 'VISION_BACKEND') || 'auto').toLowerCase();
  if (want === 'cli') return 'cli';
  if (want === 'gemini-api' || want === 'gemini' || want === 'api') return 'gemini-api';
  return cliFound ? 'cli' : hasKey ? 'gemini-api' : 'cli';
}

const DEFAULT_PROVIDERS = ['wikimedia-commons', 'wikipedia', 'openverse', 'duckduckgo'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cli = resolveVisionCliPath(env);
  // Analysis needs the richer model; verification and instruction parsing are simpler and called
  // more often, so they default to the faster variant. VISION_MODEL overrides all three.
  const explicitBase = str(env, 'VISION_MODEL') && MODEL_RE.test(str(env, 'VISION_MODEL') as string) ? (str(env, 'VISION_MODEL') as string) : undefined;
  const baseModel = explicitBase || 'gemini-3.8-flash-medium';
  const fastModel = explicitBase || 'gemini-3.8-flash-low';

  const rawKey = cleanKey(str(env, 'GEMINI_API_KEY') || str(env, 'GOOGLE_API_KEY'));
  const geminiApiKey = rawKey && GEMINI_KEY_RE.test(rawKey) ? rawKey : undefined;
  // a key was provided but could not be used: say so (otherwise the failure is silent)
  const geminiKeyIgnored = Boolean(rawKey) && !geminiApiKey;
  const visionBackend = resolveVisionBackend(env, Boolean(cli.cliPath), Boolean(geminiApiKey));

  const keyed: string[] = [];
  const tmdbApiKey = str(env, 'TMDB_API_KEY');
  const tmdbReadAccessToken = str(env, 'TMDB_READ_ACCESS_TOKEN');
  if (tmdbApiKey || tmdbReadAccessToken) keyed.push('tmdb');
  const googleApiKey = str(env, 'GOOGLE_SEARCH_API_KEY');
  const googleCx = str(env, 'GOOGLE_SEARCH_CX');
  if (googleApiKey && googleCx) keyed.push('google-cse');
  const braveApiKey = str(env, 'BRAVE_SEARCH_API_KEY');
  if (braveApiKey) keyed.push('brave-images');
  const googleVisionApiKey = str(env, 'GOOGLE_CLOUD_VISION_API_KEY');
  if (googleVisionApiKey) keyed.push('google-vision-web');
  const braveCountryRaw = (str(env, 'BRAVE_SEARCH_COUNTRY') || 'IN').toUpperCase();
  const rightsRaw = (str(env, 'DISCOVERY_RIGHTS_POLICY') || 'allow_copyrighted').toLowerCase();

  const explicit = str(env, 'DISCOVERY_PROVIDERS');
  let enabledProviders = explicit
    ? explicit.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [...DEFAULT_PROVIDERS, ...keyed];
  // The DuckDuckGo provider uses an undocumented endpoint with a browser user agent: opt-in only.
  const allowUnofficialProviders = bool(env, 'DISCOVERY_ALLOW_UNOFFICIAL', false);
  if (!allowUnofficialProviders) enabledProviders = enabledProviders.filter(p => p !== 'duckduckgo');

  const verifyRaw = (str(env, 'VISION_VERIFY_CANDIDATES') || 'required').toLowerCase();

  return {
    mongoUri:
      str(env, 'MONGO_URI') ||
      str(env, 'MONGODB_URI') ||
      'mongodb://127.0.0.1:27017/kanyaraasi_memes',
    host: str(env, 'HOST') || (env.PORT || env.RENDER || env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: int(env, 'PORT', 3000, 1, 65535),
    adaptationMaxConcurrent: int(env, 'ADAPTATION_MAX_CONCURRENT', 1, 1, 4),
    vision: {
      ...cli,
      analysisModel: model(env, 'VISION_ANALYSIS_MODEL', baseModel),
      verifyModel: model(env, 'VISION_VERIFY_MODEL', fastModel),
      instructionModel: model(env, 'VISION_INSTRUCTION_MODEL', fastModel),
      timeoutMs: int(env, 'VISION_TIMEOUT_MS', 180_000, 30_000, 600_000),
      maxAttempts: int(env, 'VISION_MAX_ATTEMPTS', 2, 1, 4),
      maxConcurrent: int(env, 'VISION_MAX_CONCURRENT', 2, 1, 4),
      workRoot: path.resolve(str(env, 'VISION_WORK_ROOT') || path.join(BACKEND_ROOT, '.vision')),
      keepRunFiles: bool(env, 'VISION_KEEP_RUN_FILES', false),
      verifyCandidates: verifyRaw === 'off' ? 'off' : 'required',
      backend: visionBackend,
      geminiApiKey,
      geminiKeyIgnored,
      geminiApiBase: (str(env, 'GEMINI_API_BASE') || GEMINI_DEFAULT_BASE).replace(/\/+$/, ''),
      gemini: {
        analysisModel: model(env, 'GEMINI_ANALYSIS_MODEL', GEMINI_DEFAULT_MODEL),
        verifyModel: model(env, 'GEMINI_VERIFY_MODEL', GEMINI_DEFAULT_MODEL),
        instructionModel: model(env, 'GEMINI_INSTRUCTION_MODEL', GEMINI_DEFAULT_MODEL),
        // the analysis is the hard task (medium); checking candidates and reading instructions are simpler (low)
        analysisThinking: thinking(env, 'GEMINI_ANALYSIS_THINKING', 'MEDIUM'),
        verifyThinking: thinking(env, 'GEMINI_VERIFY_THINKING', 'LOW'),
        instructionThinking: thinking(env, 'GEMINI_INSTRUCTION_THINKING', 'LOW')
      }
    },
    discovery: {
      enabledProviders,
      allowUnofficialProviders,
      rightsPolicy: rightsRaw === 'open_license_only' ? 'open_license_only' : 'allow_copyrighted',
      googleApiKey,
      googleCx,
      tmdbApiKey,
      tmdbReadAccessToken,
      tmdbCommercialAgreement: bool(env, 'TMDB_COMMERCIAL_AGREEMENT', false),
      braveApiKey,
      braveMonthlyLimit: int(env, 'BRAVE_MONTHLY_REQUEST_LIMIT', 1000, 0, 10_000_000),
      braveCountry: /^([A-Z]{2}|ALL)$/.test(braveCountryRaw) ? braveCountryRaw : 'IN',
      braveMaxQueriesPerSlot: int(env, 'DISCOVERY_BRAVE_QUERIES_PER_SLOT', 2, 1, 6),
      googleVisionApiKey,
      googleVisionMonthlyLimit: int(env, 'GOOGLE_VISION_MONTHLY_UNIT_LIMIT', 1000, 0, 10_000_000),
      maxCandidatesPerSlot: int(env, 'DISCOVERY_MAX_CANDIDATES_PER_SLOT', 40, 5, 200),
      shortlistSize: int(env, 'DISCOVERY_SHORTLIST_SIZE', 4, 1, 8),
      maxRounds: int(env, 'DISCOVERY_MAX_ROUNDS', 3, 1, 5),
      requestTimeoutMs: int(env, 'DISCOVERY_REQUEST_TIMEOUT_MS', 12_000, 2_000, 60_000),
      downloadTimeoutMs: int(env, 'DISCOVERY_DOWNLOAD_TIMEOUT_MS', 20_000, 2_000, 120_000),
      slotTimeoutMs: int(env, 'DISCOVERY_SLOT_TIMEOUT_MS', 420_000, 30_000, 1_800_000),
      allowImageTypeFallback: bool(env, 'DISCOVERY_ALLOW_TYPE_FALLBACK', false),
      userAgent: str(env, 'HTTP_USER_AGENT') || 'MemeAdaptationEngine/2.0 (local meme layout tool; non-commercial)',
      maxDownloadsPerSlot: 14,
      visualMinConfidence: 0.6,
      duplicateHamming: 6,
      minImageSide: 250,
      maxUpscale: 2.5,
      watermarkPolicy: 'prefer_clean'
    },
    identity: {
      aiMinConfidence: num(env, 'IDENTITY_AI_MIN_CONFIDENCE', 0.8, 0.5, 0.99)
    },
    instagram: {
      metaAppId: str(env, 'META_APP_ID') || '1157226127472052',
      metaAppSecret: str(env, 'META_APP_SECRET'),
      instagramAppId: str(env, 'INSTAGRAM_APP_ID') || '2049776039055092',
      loginConfigId: str(env, 'INSTAGRAM_LOGIN_CONFIG_ID') || '1684279023426778',
      redirectUri: str(env, 'INSTAGRAM_REDIRECT_URI') || 'https://jailer-effective-wiring.ngrok-free.dev/api/instagram/auth/callback',
      tokenEncryptionKey: str(env, 'INSTAGRAM_TOKEN_ENCRYPTION_KEY'),
      targetUsername: str(env, 'INSTAGRAM_TARGET_USERNAME') || 'kanyaraasi_memes',
      publicBaseUrl: (
        str(env, 'PUBLIC_BASE_URL') ||
        // Render sets this to the service's own public address, so a hosted server needs no setting at all
        str(env, 'RENDER_EXTERNAL_URL') ||
        (str(env, 'INSTAGRAM_REDIRECT_URI') || 'https://jailer-effective-wiring.ngrok-free.dev/api/instagram/auth/callback').replace(/\/api\/instagram\/auth\/callback\/?$/, '')
      ).replace(/\/+$/, '')
    },
    whatsapp: {
      phoneNumberId: str(env, 'WHATSAPP_PHONE_NUMBER_ID') || '1081083728429962',
      accessToken: str(env, 'WHATSAPP_ACCESS_TOKEN') || '',
      // No guessable defaults: an empty verify token / allowed phone makes the bot refuse everything.
      verifyToken: str(env, 'WHATSAPP_VERIFY_TOKEN') || '',
      allowedPhone: normalizePhoneList(str(env, 'WHATSAPP_ALLOWED_PHONE')), // one or several numbers, comma-separated
      apiVersion: str(env, 'WHATSAPP_API_VERSION') || 'v21.0',
      appSecret: str(env, 'WHATSAPP_APP_SECRET') || str(env, 'META_APP_SECRET')
    },
    auth: loadAuthConfig(env),
    limits: { maxUploadBytes: HARD_MAX_UPLOAD_BYTES },
    diagnostics: false,
    logLevel: 'log'
  };
}

const clampN = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Applies saved pipeline settings to the .env configuration (pure; never weakens checks or raises caps). */
export function applyRuntimeOverrides(base: AppConfig, o: RuntimeOverrides | null): AppConfig {
  if (!o) return base;
  const d = o.discovery || {};
  const disabled = new Set(d.disabledProviders || []);
  return {
    ...base,
    adaptationMaxConcurrent: clampN(o.adaptationMaxConcurrent, 1, 4, base.adaptationMaxConcurrent),
    vision: {
      ...base.vision,
      timeoutMs: clampN(o.vision?.timeoutMs, 30_000, 600_000, base.vision.timeoutMs),
      maxAttempts: clampN(o.vision?.maxAttempts, 1, 4, base.vision.maxAttempts)
    },
    discovery: {
      ...base.discovery,
      // switching a provider OFF only; a provider not enabled in .env (or without its key) stays off
      enabledProviders: base.discovery.enabledProviders.filter(p => !disabled.has(p)),
      rightsPolicy: d.rightsPolicy === 'open_license_only' || d.rightsPolicy === 'allow_copyrighted' ? d.rightsPolicy : base.discovery.rightsPolicy,
      maxDownloadsPerSlot: clampN(d.maxDownloadsPerSlot, 4, 30, base.discovery.maxDownloadsPerSlot),
      maxRounds: clampN(d.maxRounds, 1, 3, base.discovery.maxRounds),
      visualMinConfidence: Math.max(base.discovery.visualMinConfidence, clampN(d.visualMinConfidence, 0.6, 0.95, 0)),
      duplicateHamming: clampN(d.duplicateHamming, 4, 10, base.discovery.duplicateHamming),
      minImageSide: Math.max(base.discovery.minImageSide, clampN(d.minImageSide, 250, 1000, 0)),
      maxUpscale: Math.min(base.discovery.maxUpscale, clampN(d.maxUpscale, 1.25, 2.5, Infinity)),
      watermarkPolicy: d.watermarkPolicy === 'reject' || d.watermarkPolicy === 'prefer_clean' ? d.watermarkPolicy : base.discovery.watermarkPolicy,
      downloadTimeoutMs: clampN(d.downloadTimeoutMs, 5_000, 120_000, base.discovery.downloadTimeoutMs)
    },
    identity: { aiMinConfidence: Math.max(base.identity.aiMinConfidence, clampN(o.identity?.aiMinConfidence, 0.8, 0.99, 0)) },
    limits: { maxUploadBytes: Math.min(HARD_MAX_UPLOAD_BYTES, clampN(o.limits?.maxUploadBytes, 1024 * 1024, HARD_MAX_UPLOAD_BYTES, base.limits.maxUploadBytes)) },
    diagnostics: typeof o.diagnostics === 'boolean' ? o.diagnostics : base.diagnostics,
    logLevel: o.logLevel && ['error', 'warn', 'log', 'debug', 'verbose'].includes(o.logLevel) ? o.logLevel : base.logLevel
  };
}

let cached: AppConfig | null = null;
let runtimeOverrides: RuntimeOverrides | null = null;
let effective: AppConfig | null = null;

/** The .env configuration without saved settings (the defaults shown in Settings). */
export function getEnvConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Process-wide configuration: .env + saved pipeline settings. Tests should call loadConfig() with their own env instead. */
export function getConfig(): AppConfig {
  const base = getEnvConfig();
  if (!runtimeOverrides) return base;
  if (!effective) effective = applyRuntimeOverrides(base, runtimeOverrides);
  return effective;
}

/** Applies (or clears) saved pipeline settings. Takes effect for every following request. */
export function setRuntimeOverrides(o: RuntimeOverrides | null): void {
  runtimeOverrides = o;
  effective = null;
}

/** Test hook: replace the cached configuration. */
export function setConfigForTests(cfg: AppConfig | null): void {
  cached = cfg;
  effective = null;
}

/** Redacted, log-safe summary. */
export function describeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    host: cfg.host,
    port: cfg.port,
    mongo: cfg.mongoUri.replace(/\/\/[^@/]*@/, '//***@'),
    visionBackend: cfg.vision.backend || 'cli',
    visionCli: cfg.vision.cliPath ? `${cfg.vision.cliPath} (${cfg.vision.cliPathSource})` : 'NOT FOUND',
    geminiKeyConfigured: Boolean(cfg.vision.geminiApiKey),
    visionModels:
      cfg.vision.backend === 'gemini-api' && cfg.vision.gemini
        ? { analysis: cfg.vision.gemini.analysisModel, verify: cfg.vision.gemini.verifyModel, instruction: cfg.vision.gemini.instructionModel }
        : { analysis: cfg.vision.analysisModel, verify: cfg.vision.verifyModel, instruction: cfg.vision.instructionModel },
    visionVerifyCandidates: cfg.vision.verifyCandidates,
    providers: cfg.discovery.enabledProviders,
    rightsPolicy: cfg.discovery.rightsPolicy,
    braveKeyConfigured: Boolean(cfg.discovery.braveApiKey),
    braveMonthlyLimit: cfg.discovery.braveMonthlyLimit,
    googleVisionKeyConfigured: Boolean(cfg.discovery.googleVisionApiKey),
    googleVisionMonthlyLimit: cfg.discovery.googleVisionMonthlyLimit,
    googleKeyConfigured: Boolean(cfg.discovery.googleApiKey),
    tmdbKeyConfigured: Boolean(cfg.discovery.tmdbApiKey || cfg.discovery.tmdbReadAccessToken),
    tmdbCommercialAgreement: cfg.discovery.tmdbCommercialAgreement,
    instagram: {
      metaAppId: cfg.instagram.metaAppId,
      hasMetaAppSecret: Boolean(cfg.instagram.metaAppSecret),
      instagramAppId: cfg.instagram.instagramAppId,
      loginConfigId: cfg.instagram.loginConfigId,
      redirectUri: cfg.instagram.redirectUri,
      targetUsername: cfg.instagram.targetUsername,
      hasEncryptionKey: Boolean(cfg.instagram.tokenEncryptionKey)
    },
    auth: {
      enabled: cfg.auth.enabled,
      appHosts: cfg.auth.appHosts,
      appPublicUrl: cfg.auth.appPublicUrl,
      staticLogin: Boolean(cfg.auth.staticUsername), // never the credentials themselves
      cookieSecure: cfg.auth.cookieSecure,
      trustProxy: cfg.auth.trustProxy,
      sessionIdleDays: cfg.auth.sessionIdleDays,
      sessionMaxDays: cfg.auth.sessionMaxDays
    },
    whatsapp: {
      phoneNumberId: cfg.whatsapp.phoneNumberId,
      hasAccessToken: Boolean(cfg.whatsapp.accessToken),
      hasVerifyToken: Boolean(cfg.whatsapp.verifyToken),
      hasAppSecret: Boolean(cfg.whatsapp.appSecret),
      allowedPhone: cfg.whatsapp.allowedPhone,
      apiVersion: cfg.whatsapp.apiVersion
    }
  };
}
