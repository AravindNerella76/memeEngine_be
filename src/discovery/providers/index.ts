import { AppConfig } from '../../config/app-config';
import { ImageSearchProvider } from '../discovery.types';
import { InMemoryProviderUsageStore, ProviderUsageStore, UsageGuard } from '../provider-usage';
import { defaultProviderHttp, ProviderHttp } from './provider-http';
import { WikimediaCommonsProvider, WikipediaProvider } from './wikimedia.providers';
import { DuckDuckGoProvider, GoogleCseProvider, OpenverseProvider, TmdbProvider } from './web.providers';
import { BraveImageProvider } from './brave.provider';
import { GoogleVisionWebProvider } from './vision-web.provider';

export interface ProviderSet {
  providers: ImageSearchProvider[];
  /** Monthly usage guards of the paid providers (for the status endpoint). */
  guards: UsageGuard[];
}

/**
 * All providers, each enabled/disabled by configuration (DISCOVERY_PROVIDERS, keys).
 * Paid providers (Brave, Google Cloud Vision) are capped per month by `usage`.
 */
export function createProviderSet(getCfg: () => AppConfig, http: ProviderHttp = defaultProviderHttp, usage: ProviderUsageStore = new InMemoryProviderUsageStore()): ProviderSet {
  const on = (id: string) => () => getCfg().discovery.enabledProviders.includes(id);
  const d = () => getCfg().discovery;
  const braveGuard = new UsageGuard(usage, 'brave-images', () => d().braveMonthlyLimit, 'Brave Image Search', 'BRAVE_MONTHLY_REQUEST_LIMIT');
  const visionGuard = new UsageGuard(usage, 'google-vision-web', () => d().googleVisionMonthlyLimit, 'Google Cloud Vision reverse image search', 'GOOGLE_VISION_MONTHLY_UNIT_LIMIT');
  const providers: ImageSearchProvider[] = [
    new WikimediaCommonsProvider(on('wikimedia-commons'), http),
    new WikipediaProvider(on('wikipedia'), http, () => d().rightsPolicy === 'allow_copyrighted'),
    new OpenverseProvider(on('openverse'), http),
    new GoogleVisionWebProvider(() => d().googleVisionApiKey, on('google-vision-web'), visionGuard, http),
    new BraveImageProvider(() => ({ apiKey: d().braveApiKey, country: d().braveCountry }), on('brave-images'), braveGuard, http),
    new TmdbProvider(() => ({ apiKey: d().tmdbApiKey, token: d().tmdbReadAccessToken, agreement: d().tmdbCommercialAgreement }), on('tmdb'), http),
    new GoogleCseProvider(() => ({ apiKey: d().googleApiKey, cx: d().googleCx }), on('google-cse'), http),
    new DuckDuckGoProvider(() => on('duckduckgo')() && d().allowUnofficialProviders, http)
  ];
  return { providers, guards: [braveGuard, visionGuard] };
}

/** Back-compatible helper: the providers only. */
export function createProviders(getCfg: () => AppConfig, http: ProviderHttp = defaultProviderHttp, usage?: ProviderUsageStore): ImageSearchProvider[] {
  return createProviderSet(getCfg, http, usage).providers;
}

export function describeProviders(providers: ImageSearchProvider[]) {
  return providers.map(p => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    capability: p.capability || 'text',
    resultStorage: p.resultStorage || 'full',
    enabled: p.isEnabled(),
    disabledReason: (p as any).disabledReason || null,
    keyConfigured: typeof (p as any).isKeyConfigured === 'function' ? (p as any).isKeyConfigured() : true
  }));
}
