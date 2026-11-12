import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MemeType, ImageArrangementMode } from '../types/meme.types';

export interface ViralMemeAnalysisResult {
  memeType: MemeType;
  arrangement: ImageArrangementMode;
  subjectCount: number;
  subjects: string[];
  headline?: string;
  bulletPoints?: string[];
  statement?: string;
  itemLabels?: string[];
  referenceReactionContext?: string;
}

@Injectable()
export class ViralMemeAnalyzerService {
  private readonly agyExecutable = 'C:\\Users\\hp\\.gemini\\bin\\agy.exe';

  /**
   * AI-powered vision analysis of viral meme reference screenshot.
   * Extracts layout archetype, section counts, subject identities, and overlaid text.
   * Strictly separates the subject content from the bottom reaction scene.
   */
  async analyzeViralReference(imagePath: string): Promise<ViralMemeAnalysisResult> {
    if (!fs.existsSync(imagePath)) {
      throw new BadRequestException(`Reference screenshot not found at: ${imagePath}`);
    }

    const normalizedPath = path.resolve(imagePath).replace(/\\/g, '/');

    const prompt = `You are an expert meme vision analysis engine.
Analyze the viral meme reference screenshot at: ${normalizedPath}

Your job is ONLY to deconstruct the visual composition and identify the subjects:
1. memeType: classify the layout archetype into one of:
   - "movie_update" (poster/movie stills with review or censor bullet points)
   - "facts_collage" (multi-tile factual grid like 2x2 with individual captions)
   - "comparison" (side-by-side columns or stacked horizontal rows comparing people or stats)
   - "trending_news" (hero image or dual subjects with an overlaid statement/quote)
   - "custom" (general custom arrangement)
2. arrangement: select one of:
   - "side_by_side" (2 columns)
   - "columns_3" (3 columns)
   - "columns_4" (4 columns)
   - "grid_2x2" (2x2 grid, 4 tiles)
   - "stacked_rows" (horizontal rows stacked vertically)
   - "single_hero" (1 main subject)
3. subjectCount: exact number of subject-image sections in the upper/middle content area.
4. subjects: array of strings naming each subject/celebrity/entity in the subject slots in exact visual order (e.g. ["Pawan Kalyan", "Pawan Kalyan"] or ["Thalapathy Vijay", "Jr NTR"] or ["YS Jagan Mohan Reddy", "Pema Khandu", "Mamata Banerjee"]).
5. headline: top banner headline text if present (e.g. "OG CENSOR REPORT"), or null.
6. bulletPoints: array of review/censor/update bullet point strings overlaid on the subject section (e.g. ["DECENT 1ST HALF", "MASSIVE INTERVAL SEQUENCE"]), or empty array.
7. statement: main overlaid statement or quote text if present, or null.
8. itemLabels: per-slot subcaptions/stats/labels if present, or empty array.
9. referenceReactionContext: reaction context tag above the reaction scene (e.g. "* THEATRE LO AUDIENCE RESPONSE" or "* BOSS AND AKHIL"), or null.

CRITICAL RULES:
- Do NOT treat the bottom reaction image as a subject.
- Do NOT extract or return the punchline from the bottom reaction image.
- Output ONLY a valid JSON object matching the requested schema. No markdown fences, no explanation.`;

    try {
      const rawOutput = await this.runAgyVision(prompt);
      const parsed = this.cleanAndParseJson(rawOutput);

      return {
        memeType: this.normalizeMemeType(parsed.memeType),
        arrangement: this.normalizeArrangement(parsed.arrangement, parsed.subjectCount || parsed.subjects?.length || 2),
        subjectCount: parsed.subjectCount || parsed.subjects?.length || 1,
        subjects: Array.isArray(parsed.subjects) ? parsed.subjects.map((s: any) => String(s).trim()) : [],
        headline: parsed.headline ? String(parsed.headline).trim() : undefined,
        bulletPoints: Array.isArray(parsed.bulletPoints) ? parsed.bulletPoints.map((b: any) => String(b).trim()).filter(Boolean) : undefined,
        statement: parsed.statement ? String(parsed.statement).trim() : undefined,
        itemLabels: Array.isArray(parsed.itemLabels) ? parsed.itemLabels.map((l: any) => String(l).trim()) : undefined,
        referenceReactionContext: parsed.referenceReactionContext ? String(parsed.referenceReactionContext).trim() : undefined
      };
    } catch (err: any) {
      console.error('Viral meme analysis error:', err);
      throw new BadRequestException(`Failed to analyze viral meme reference: ${err.message}`);
    }
  }

  private runAgyVision(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.agyExecutable,
        ['--dangerously-skip-permissions', '--print', prompt],
        { timeout: 45000 },
        (error, stdout, stderr) => {
          if (error) {
            return reject(new Error(stderr || error.message));
          }
          resolve(stdout);
        }
      );
    });
  }

  private cleanAndParseJson(raw: string): any {
    let clean = raw.trim();
    if (clean.startsWith('```json')) clean = clean.replace(/```json\s*/i, '');
    if (clean.startsWith('```')) clean = clean.replace(/```\s*/i, '');
    if (clean.endsWith('```')) clean = clean.replace(/```\s*$/i, '');
    clean = clean.trim();

    // In case of surrounding prose, match first '{' to last '}'
    const startIdx = clean.indexOf('{');
    const endIdx = clean.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      clean = clean.substring(startIdx, endIdx + 1);
    }

    return JSON.parse(clean);
  }

  private normalizeMemeType(val: any): MemeType {
    const valid: MemeType[] = ['movie_update', 'facts_collage', 'comparison', 'trending_news', 'custom'];
    if (valid.includes(val)) return val;
    return 'movie_update';
  }

  private normalizeArrangement(val: any, count: number): ImageArrangementMode {
    const valid: ImageArrangementMode[] = ['side_by_side', 'columns_3', 'columns_4', 'grid_2x2', 'stacked_rows', 'single_hero'];
    if (valid.includes(val)) return val;
    if (count === 1) return 'single_hero';
    if (count === 3) return 'columns_3';
    if (count === 4) return 'grid_2x2';
    return 'side_by_side';
  }
}
