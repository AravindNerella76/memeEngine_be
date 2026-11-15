/**
 * What the WhatsApp bot needs to bring the reaction library and the "which frame?" question into a chat:
 * numbered picture sheets (WhatsApp has no picture grid to tap, so one image carries many numbered pictures), the choices for
 * a stacked picture and how to read the answer, and the small-picture warning. Pure functions: pixels and text in, pixels and
 * text out, so every rule here is tested without a phone.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ReactionAnalysis, ReactionFraming, drawReactionPlan, planReactionPanel, reactionPanelHeight } from './reaction-framing';

/** Pictures per sheet (4 columns x 3 rows). */
export const SHEET_PAGE = 12;
/** Above this enlargement a picture looks soft (the same limit as the studio). */
export const SOFT_ABOVE = 2;

const INK = '#0E0E0C';
const MARKER = '#FFE500';
const FONT = '"Anton", "Arial Black", Impact, sans-serif';

export interface SheetTile {
  /** An encoded picture (JPEG/PNG bytes) or anything the canvas can draw (a canvas, a decoded image). */
  image: Buffer | { width: number; height: number };
  label?: string;
}

export interface SheetOptions {
  title: string;
  subtitle?: string;
  columns?: number;
  tileW?: number;
  tileH?: number;
}

/** A sheet of numbered pictures as one JPEG: yellow number badges, an optional caption under each picture. */
export async function renderSheet(tiles: SheetTile[], opts: SheetOptions): Promise<Buffer> {
  const cols = Math.max(1, Math.min(opts.columns ?? 4, tiles.length || 1));
  const tw = opts.tileW ?? 300;
  const th = opts.tileH ?? 225;
  const pad = 10;
  const header = 58;
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  const W = cols * tw + (cols + 1) * pad;
  const H = header + rows * th + (rows + 1) * pad;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#1d1d1a';
  g.fillRect(0, 0, W, H);

  g.fillStyle = INK;
  g.fillRect(0, 0, W, header);
  g.fillStyle = MARKER;
  g.font = `30px ${FONT}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(opts.title.toUpperCase().slice(0, 40), pad + 6, header / 2 + 1);
  if (opts.subtitle) {
    g.fillStyle = '#cfcab8';
    g.font = `18px ${FONT}`;
    g.textAlign = 'right';
    g.fillText(opts.subtitle, W - pad - 6, header / 2 + 1);
  }

  for (let i = 0; i < tiles.length; i++) {
    const x = pad + (i % cols) * (tw + pad);
    const y = header + pad + Math.floor(i / cols) * (th + pad);
    g.fillStyle = '#0a0a09';
    g.fillRect(x, y, tw, th);
    try {
      const img: any = Buffer.isBuffer(tiles[i].image) ? await loadImage(tiles[i].image as Buffer) : tiles[i].image;
      const s = Math.min(tw / img.width, th / img.height);
      const w = img.width * s;
      const h = img.height * s;
      g.drawImage(img, x + (tw - w) / 2, y + (th - h) / 2, w, h);
    } catch {
      /* a picture that cannot be drawn leaves its tile dark; the number still works */
    }
    if (tiles[i].label) {
      g.fillStyle = 'rgba(0, 0, 0, 0.62)';
      g.fillRect(x, y + th - 30, tw, 30);
      g.fillStyle = '#ffffff';
      g.font = `17px ${FONT}`;
      g.textAlign = 'left';
      g.fillText(String(tiles[i].label).slice(0, 30), x + 10, y + th - 14);
    }
    // the number to reply with
    g.beginPath();
    g.arc(x + 28, y + 28, 22, 0, Math.PI * 2);
    g.fillStyle = MARKER;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = INK;
    g.font = `26px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(String(i + 1), x + 28, y + 30);
  }
  return c.toBuffer('image/jpeg', 84);
}

// ---------------------------------------------------------------------------------------------
// A stacked reaction picture: the choices, and reading the answer
// ---------------------------------------------------------------------------------------------

export interface FramingOption {
  /** The number the owner can reply with. */
  n: number;
  /** Stable key (used by WhatsApp list rows): split | 0 | 1 | 2 | whole | single */
  id: string;
  title: string;
  hint: string;
  framing: ReactionFraming;
}

const ORDINAL = ['First', 'Second', 'Third'];

/** The same choices the studio offers: both frames, each frame alone, the whole picture, or one scene. */
export function framingOptions(a: ReactionAnalysis): FramingOption[] {
  const out: FramingOption[] = [{ n: 1, id: 'split', title: 'Both frames', hint: 'side by side', framing: { split: true } }];
  a.frames.forEach((_, i) => out.push({ n: i + 2, id: String(i), title: `${ORDINAL[i] || `Frame ${i + 1}`} frame`, hint: 'only this one', framing: { frame: i } }));
  out.push({ n: a.frames.length + 2, id: 'whole', title: 'Whole picture', hint: 'nothing cropped', framing: { fit: 'whole' } });
  out.push({ n: a.frames.length + 3, id: 'single', title: 'One picture', hint: 'cropped, not split', framing: { split: false } });
  return out;
}

/** An answer typed in a chat: a number, or words like "both", "first", "top", "whole", "frame 2". Null when unclear. */
export function parseFramingAnswer(text: string, options: FramingOption[]): FramingOption | null {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return null;
  if (/^\d{1,2}$/.test(t)) return options.find(o => o.n === Number(t)) || null;
  const byId = (id: string) => options.find(o => o.id === id) || null;
  const frame = /^(?:frame|only|just)?\s*(\d)(?:st|nd|rd|th)?(?:\s*frame)?$/.exec(t);
  if (/^(both|side|side by side|split|auto|default|together)$/.test(t)) return byId('split');
  if (/^(first|1st|top|upper|above)(\s+frame)?$/.test(t)) return byId('0');
  if (/^(second|2nd|bottom|lower|below)(\s+frame)?$/.test(t)) return byId('1');
  if (/^(third|3rd|last)(\s+frame)?$/.test(t)) return byId('2');
  if (/^(whole|all|full|everything|uncropped|entire)(\s+picture)?$/.test(t)) return byId('whole');
  if (/^(one|single|crop|cropped|one picture|one scene)$/.test(t)) return byId('single');
  if (frame && /frame|only|just/.test(t)) return byId(String(Number(frame[1]) - 1));
  return null;
}

/** An answer from a WhatsApp list row (`fr:<id>`). */
export function framingFromRow(rowId: string, options: FramingOption[]): FramingOption | null {
  const m = /^fr:(.+)$/.exec(String(rowId || ''));
  return m ? options.find(o => o.id === m[1]) || null : null;
}

/** The question as plain text (also the fallback when a list message cannot be sent). */
export function framingQuestionText(a: ReactionAnalysis, options: FramingOption[]): string {
  return (
    `🎞️ *This picture has ${a.frames.length} frames.* Which do you want in the meme?\n\n` +
    options.map(o => `${o.n}. *${o.title}* — ${o.hint}`).join('\n') +
    `\n\nReply with a number.`
  );
}

/** The default reaction panel on the 1080 px canvas for a picture (what the render will use without a plan's own ratio). */
export function defaultPanel(a: { width: number; height: number }): { width: number; height: number } {
  return { width: 1080, height: reactionPanelHeight(1080, 1350, a.width / a.height) };
}

/** One image showing every choice as a small numbered drawing of the reaction panel. */
export async function renderFramingSheet(img: any, a: ReactionAnalysis, options: FramingOption[]): Promise<Buffer> {
  const panel = defaultPanel(a);
  const w = 420;
  const k = w / panel.width;
  const h = Math.round(panel.height * k);
  const tiles: SheetTile[] = options.map(o => {
    const c = createCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = '#0a0a09';
    g.fillRect(0, 0, w, h);
    g.scale(k, k);
    drawReactionPlan(g, img, planReactionPanel(a, o.framing, panel), { x: 0, y: 0 });
    return { image: c as any, label: o.title };
  });
  return renderSheet(tiles, { title: 'Which frame?', subtitle: 'reply with a number', columns: Math.min(3, tiles.length), tileW: w, tileH: h });
}

/** A warning when the picture is small enough to look soft, or null. */
export function softWarning(a: ReactionAnalysis, framing: ReactionFraming | undefined): string | null {
  const plan = planReactionPanel(a, framing, defaultPanel(a));
  if (plan.enlargement <= SOFT_ABOVE) return null;
  return `⚠️ This picture is only ${a.width} px wide and is shown ${plan.enlargement.toFixed(1)}× larger, so it may look soft in the meme. A bigger copy of the same picture looks sharper.`;
}

/** A short name for a choice, for confirmations ("first frame only"). */
export function describeFraming(f: ReactionFraming | undefined | null): string {
  if (!f) return 'automatic framing';
  if (f.fit === 'whole') return 'the whole picture';
  if (typeof f.frame === 'number') return `the ${(ORDINAL[f.frame] || `frame ${f.frame + 1}`).toLowerCase()} frame only`;
  if (f.split === false) return 'one picture (cropped)';
  return 'both frames side by side';
}

// ---------------------------------------------------------------------------------------------
// The library in a chat
// ---------------------------------------------------------------------------------------------

export interface FolderEntry {
  category: string;
  count: number;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * The folder list. Entry 0 is "recently used" when there is one; the folders follow, numbered from 1 in the order
 * given. Folder names can also be typed.
 */
export function folderListText(folders: FolderEntry[], total: number, recentCount: number): string {
  return (
    `🗂️ *Your reaction library* — ${total} picture${total === 1 ? '' : 's'}\n\n` +
    (recentCount ? `0. ⭐ *Recently used* (${recentCount})\n` : '') +
    folders.map((f, i) => `${i + 1}. ${cap(f.category)} (${f.count})`).join('\n') +
    `\n\nReply with a *number* or a folder name, or type words to search (for example _brahmanandam_).\n*Back* returns to your meme.`
  );
}

/** Reads a reply at the folder list: a number, "recent", a folder name, or search words. */
export function parseFolderReply(text: string, folders: FolderEntry[], hasRecent: boolean): { kind: 'recent' } | { kind: 'folder'; category: string } | { kind: 'search'; words: string } {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  if (/^\d{1,3}$/.test(t)) {
    const n = Number(t);
    if (n === 0 && hasRecent) return { kind: 'recent' };
    if (n >= 1 && n <= folders.length) return { kind: 'folder', category: folders[n - 1].category };
  }
  if (hasRecent && /^(recent|recently used|used)$/.test(lower)) return { kind: 'recent' };
  const byName = folders.find(f => f.category.toLowerCase() === lower);
  if (byName) return { kind: 'folder', category: byName.category };
  return { kind: 'search', words: t.slice(0, 100) };
}
