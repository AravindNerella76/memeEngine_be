/**
 * The Instagram caption of a meme: punchline, headline, topic, a follow line and hashtags. One place, so a meme
 * published from WhatsApp reads like one published from the studio (fe/src/components/InstagramPublishModal.jsx builds
 * the same text for its editable box; keep the two in step).
 */
import type { MemeContent } from '../types/meme.types';

export const FOLLOW_LINE = 'Follow @kanyaraasi_memes for more Telugu memes & comedy! 🎯';
export const DEFAULT_HASHTAGS = ['#telugumemes', '#kanyaraasi_memes', '#telugucinema', '#memes', '#trending'];

/** Instagram allows 2200 characters; stay under it whatever the meme says. */
export const MAX_CAPTION = 2200;

export function buildCaption(content: Partial<MemeContent> | undefined | null, hashtags: string[] = DEFAULT_HASHTAGS): string {
  const punchline = String(content?.punchline || '').trim();
  const headline = String(content?.headline || '').trim();
  const topic = String(content?.topic || '').trim();

  const lines: string[] = [];
  if (punchline) lines.push(punchline);
  if (headline && headline !== punchline) lines.push(`\n${headline}`);
  if (topic && topic !== headline && topic !== punchline) lines.push(`\n📌 ${topic}`);
  lines.push(`\n${FOLLOW_LINE}`);

  const body = lines.join('\n').trim();
  const tags = hashtags.join(' ');
  const full = tags ? `${body}\n\n${tags}` : body;
  if (full.length <= MAX_CAPTION) return full;
  // never cut the meme's own words to make room for hashtags: drop the hashtags first, then trim
  return body.length <= MAX_CAPTION ? body : `${body.slice(0, MAX_CAPTION - 1)}…`;
}
