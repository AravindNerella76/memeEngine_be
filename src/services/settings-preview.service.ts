import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import { DesignProfileService } from '../design/design-profile.service';
import { designFromSettings } from '../design/render-style';
import { AppSettings, mergeSettingsPatch } from '../design/settings';
import { ImageArrangementMode, MemeContent, MemeType, UploadedAsset } from '../types/meme.types';
import { LayoutEngineService } from './layout-engine.service';
import { CanvasRendererService } from './canvas-renderer.service';
import { layoutAndRender } from './render-pipeline';

interface PreviewSample {
  label: string;
  memeType: MemeType;
  arrangement?: ImageArrangementMode;
  /** Generated sample pictures ("kind:seed"). They contain no text, so only the meme's own text is judged. */
  subjects: string[];
  labels?: string[];
  reaction: string;
  content: Omit<MemeContent, 'topic'>;
}

/**
 * Sample memes for the live preview. Together they show every text role, Telugu and English text,
 * and the white / yellow highlight rules (first lines, numbers, alternating bullets).
 */
export const PREVIEW_SAMPLES: Record<string, PreviewSample> = {
  comparison: {
    label: 'Comparison: heading, subject labels, caption, Telugu punchline',
    memeType: 'comparison',
    subjects: ['tall:cmp1', 'tall:cmp2', 'tall:cmp3'],
    labels: ['931 CRORES\nCHANDRABABU', '30 CRORES\nREVANTH', '15 LAKHS\nMAMATA'],
    reaction: 'landscape:cmp-r',
    content: { headline: 'NET WORTH OF CHIEF MINISTERS OF INDIA', reactionContext: '* TELUGU PEOPLE', punchline: 'మీ అంత పూరెస్ట్ చీఫ్ మినిస్టర్ ని చూడలేదు మేడం!' }
  },
  news: {
    label: 'News: supporting text with attribution, caption, Telugu punchline',
    memeType: 'trending_news',
    subjects: ['portrait:news1', 'portrait:news2'],
    reaction: 'landscape:news-r',
    content: {
      statement: 'CHIRANJEEVI GAVE UP REMUNERATION FOR BHOLA SHANKAR AND AKHIL FOR AGENT\n- PRODUCER ANIL SUNKARA',
      reactionContext: '* BOSS AND AKHIL',
      punchline: 'ఎక్కేసారు అయ్యా ఒక మెట్టు ఎక్కేసారు'
    }
  },
  review: {
    label: 'Review: heading, bullet points, mixed Telugu + English punchline',
    memeType: 'movie_update',
    subjects: ['portrait:rev1', 'portrait:rev2'],
    reaction: 'landscape:rev-r',
    content: {
      headline: 'OG CENSOR REPORT',
      bulletPoints: ['DECENT 1ST HALF', 'MASSIVE INTERVAL SEQUENCE', 'TERRIFIC 2ND HALF'],
      reactionContext: '* THEATRE AUDIENCE',
      punchline: 'చిన్న పాజిటివ్ టాక్ వచ్చినా 500 CR కొట్టే దాకా ఆగదు!'
    }
  },
  long: {
    label: 'Long punchline: automatic fitting',
    memeType: 'comparison',
    arrangement: 'stacked_rows',
    subjects: ['wide:long1', 'wide:long2'],
    labels: ['THALAPATHY AT 50', 'NTR AT 19'],
    reaction: 'landscape:long-r',
    content: { punchline: 'మీరు ఒప్పుకున్నా ఒప్పుకోకపోయినా 19 ఇయర్స్ కే ఈ రేంజ్ ఫ్యాన్స్ ఇండియా లో ఏ హీరో కి లేరు, ఇది మాత్రం పక్కా గుర్తుపెట్టుకోండి!' }
  }
};

const TEXT_KEYS = ['heading', 'labels', 'supporting', 'caption', 'punchline'] as const;
type TextKey = (typeof TEXT_KEYS)[number];
const MAX_CONCURRENT = 2;

export interface PreviewResult {
  image: string;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  sample: string;
  textFit: Record<string, { size: number; lines: number }>;
  renderMs: number;
}

/**
 * Live preview of the Settings with the production layout engine and Skia renderer. Renders in
 * memory only: no meme record, no output file, no upload. Unsaved settings are validated exactly
 * like a save (invalid values are refused with the same errors).
 */
@Injectable()
export class SettingsPreviewService {
  private active = 0;
  private readonly images = new Map<string, any>();

  constructor(
    private readonly profiles: DesignProfileService,
    private readonly layoutEngine: LayoutEngineService,
    private readonly renderer: CanvasRendererService
  ) {}

  /** A generated sample picture (cached in memory). */
  private image(name: string): any {
    let img = this.images.get(name);
    if (!img) {
      img = samplePicture(name);
      this.images.set(name, img);
    }
    return img;
  }

  async render(body: unknown): Promise<PreviewResult> {
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) throw new BadRequestException('Preview request must be a JSON object');
    const b = (body || {}) as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!['settings', 'sample', 'text'].includes(k)) throw new BadRequestException(`"${k}" is not a preview option`);
    const sampleKey = b.sample === undefined ? 'comparison' : String(b.sample);
    const sample = Object.prototype.hasOwnProperty.call(PREVIEW_SAMPLES, sampleKey) ? PREVIEW_SAMPLES[sampleKey] : undefined;
    if (!sample) throw new BadRequestException(`sample must be one of ${Object.keys(PREVIEW_SAMPLES).join(', ')}`);
    const text = validateText(b.text);

    const saved = await this.profiles.getSettings();
    const draft: AppSettings = b.settings === undefined ? saved : mergeSettingsPatch(saved, b.settings);

    if (this.active >= MAX_CONCURRENT) throw new HttpException({ statusCode: 429, message: 'The preview is busy; it will refresh in a moment.' }, 429);
    this.active++;
    const started = Date.now();
    try {
      // drawn at layout size (1080 px wide) for speed; the final output size is reported
      const design = designFromSettings({ ...draft, canvas: { ...draft.canvas, outputScale: 1 } });
      const content = contentFor(sample, text);
      const asset = (name: string, i: number, role: UploadedAsset['role'], label?: string): UploadedAsset => ({
        id: `preview-${i}`,
        originalName: name,
        filename: name,
        path: name,
        mimeType: 'image/png',
        role,
        orderIndex: i,
        label
      });
      const subjectImages = sample.subjects.map((n, i) => asset(n, i, 'subject_item', content.itemLabels?.[i]));
      const reactionImage = asset(sample.reaction, 99, 'reaction_punchline');
      const imgs = sample.subjects.map(n => this.image(n));
      const rx = this.image(sample.reaction);
      const { render } = await layoutAndRender(
        this.layoutEngine,
        this.renderer,
        design,
        { memeType: sample.memeType, arrangement: sample.arrangement },
        content,
        { subjectImages, reactionImage },
        { subjectAspectRatios: imgs.map(i => i.width / i.height), reactionAspectRatio: rx.width / rx.height },
        { formats: ['jpeg'], loadImage: async p => this.image(p) }
      );
      return {
        image: `data:image/jpeg;base64,${render.jpegBuffer.toString('base64')}`,
        width: render.width,
        height: render.height,
        outputWidth: Math.round(render.width * draft.canvas.outputScale),
        outputHeight: Math.round(render.height * draft.canvas.outputScale),
        sample: sampleKey,
        textFit: render.textFit,
        renderMs: Date.now() - started
      };
    } finally {
      this.active--;
    }
  }
}

function validateText(raw: unknown): Partial<Record<TextKey, string>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('text must be an object');
  const out: Partial<Record<TextKey, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(TEXT_KEYS as readonly string[]).includes(k)) throw new BadRequestException(`text.${k} is not a sample text (use ${TEXT_KEYS.join(', ')})`);
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > 600) throw new BadRequestException(`text.${k} must be a string of at most 600 characters`);
    // control characters other than line breaks are dropped
    const clean = Array.from(v).filter(ch => ch === '\n' || ch.charCodeAt(0) >= 32).join('').trim();
    if (clean) out[k as TextKey] = clean;
  }
  return out;
}

/** Sample content with the user's own preview texts (if any). The preview is never stored. */
function contentFor(sample: PreviewSample, text: Partial<Record<TextKey, string>>): MemeContent {
  const c: MemeContent = { topic: 'Settings preview', ...JSON.parse(JSON.stringify(sample.content)), itemLabels: sample.labels ? [...sample.labels] : undefined };
  if (text.heading) c.headline = text.heading;
  if (text.punchline) c.punchline = text.punchline;
  if (text.caption) c.reactionContext = text.caption;
  if (text.labels && c.itemLabels?.length) c.itemLabels[0] = text.labels;
  if (text.supporting) {
    if (c.bulletPoints?.length) c.bulletPoints = text.supporting.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 8);
    else c.statement = text.supporting;
  }
  return c;
}

const PICTURE_SIZES: Record<string, [number, number]> = { portrait: [600, 800], tall: [450, 820], landscape: [1280, 720], wide: [1300, 540] };

/**
 * A deterministic stand-in photo: sky-to-ground gradient, soft highlights and one or two person
 * silhouettes, so text is seen over light, dark and busy areas and crop positions are visible.
 */
export function samplePicture(name: string) {
  const [kind, seedText = kind] = name.split(':');
  const [w, h] = PICTURE_SIZES[kind] || PICTURE_SIZES.portrait;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  let seed = Array.from(seedText).reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const hue = Math.round(rnd() * 360);
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, `hsl(${hue}, 55%, 78%)`);
  sky.addColorStop(0.55, `hsl(${(hue + 30) % 360}, 45%, 48%)`);
  sky.addColorStop(1, `hsl(${(hue + 60) % 360}, 40%, 16%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = (0.03 + rnd() * 0.12) * Math.max(w, h);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${Math.round(rnd() * 360)}, 70%, ${55 + Math.round(rnd() * 35)}%, 0.55)`);
    g.addColorStop(1, 'hsla(0, 0%, 50%, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  const people = kind === 'landscape' || kind === 'wide' ? 2 : 1;
  for (let p = 0; p < people; p++) {
    const cx = people === 1 ? w * 0.5 : w * (0.3 + 0.4 * p);
    const unit = Math.min(w / (people === 1 ? 2.2 : 4.2), h * 0.42);
    const headY = h * (people === 1 ? 0.3 : 0.38);
    ctx.fillStyle = `hsl(${(hue + 200) % 360}, 25%, ${14 + p * 6}%)`;
    ctx.beginPath();
    ctx.ellipse(cx, h + unit * 0.2, unit * 1.05, h - headY - unit * 0.1, 0, Math.PI, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = `hsl(${(hue + 20) % 360}, 35%, ${38 + p * 8}%)`;
    ctx.beginPath();
    ctx.ellipse(cx, headY, unit * 0.42, unit * 0.52, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}
