import { Injectable, BadRequestException, InternalServerErrorException, Logger } from '@nestjs/common';
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

interface CliStructuredEnvelope {
  conversation_id?: string;
  status?: string;
  duration_seconds?: number;
  num_turns?: number;
  structured_output?: any;
  response?: string;
  error?: string;
}

@Injectable()
export class ViralMemeAnalyzerService {
  private readonly logger = new Logger(ViralMemeAnalyzerService.name);
  private readonly agyExecutable = 'C:\\Users\\hp\\.gemini\\bin\\agy.exe';
  private readonly schemaPath = path.join(__dirname, '..', 'schemas', 'viral-meme-analysis.schema.json');

  constructor() {
    // Ensure schema file exists on initialization
    this.ensureSchemaFileExists();
  }

  /**
   * AI-powered vision analysis of viral meme reference screenshot.
   * Extracts layout archetype, section counts, subject identities, and overlaid text.
   * Strictly separates the subject content from the bottom reaction scene.
   */
  async analyzeViralReference(imagePath: string): Promise<ViralMemeAnalysisResult> {
    // Step 2: Input Verification
    this.verifyImageInput(imagePath);

    const normalizedPath = path.resolve(imagePath).replace(/\\/g, '/');
    const imageDir = path.dirname(normalizedPath);
    const imageUri = 'file:///' + encodeURI(normalizedPath);

    const prompt = `Analyze the viral meme reference screenshot:
![viral reference](${imageUri})
Located at: ${normalizedPath}

IMPORTANT: The bottom section (bottom 25% to 35% of the meme) is a movie reaction scene. IGNORE this bottom reaction panel completely. Never treat the actor, character, scene, or punchline in the bottom reaction panel as a subject or content.

Your task is ONLY to deconstruct the UPPER content section and identify its subjects and layout:
1. memeType: classify layout into one of: 'movie_update', 'facts_collage', 'comparison', 'trending_news', 'custom'
2. arrangement: classify arrangement into one of: 'side_by_side', 'columns_3', 'columns_4', 'grid_2x2', 'stacked_rows', 'single_hero'
3. subjectCount: exact count of subject-image slots in the upper/middle content area
4. subjects: array of names of subjects/celebrities/entities in upper slots in visual order
5. headline: top banner headline text if present, or null
6. bulletPoints: array of review/censor/update bullet points overlaid on subjects, or empty array
7. statement: main overlaid statement or quote text if present, or null
8. itemLabels: per-slot subcaptions/stats/labels if present, or empty array
9. referenceReactionContext: reaction context tag above the reaction scene, or null

CRITICAL: Do NOT treat the bottom reaction image as a subject. Do NOT extract the reaction punchline.`;

    // Step 4: Execution with limited retry for transient failures
    let rawCliResult: CliStructuredEnvelope | null = null;
    let lastError: Error | null = null;
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        rawCliResult = await this.runAgyVision(prompt, imageDir, attempt);
        if (rawCliResult && rawCliResult.structured_output) {
          break;
        }
      } catch (err: any) {
        lastError = err;
        this.logger.warn(`Viral meme analysis attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) {
          // Brief pause before retry
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (!rawCliResult || !rawCliResult.structured_output) {
      const errorMsg = lastError ? lastError.message : 'No structured output returned by vision engine.';
      this.logger.error(`Viral meme analysis permanently failed after ${maxRetries} attempts: ${errorMsg}`);
      throw new BadRequestException(`Failed to analyze viral meme reference: ${errorMsg}`);
    }

    // Step 3: Validate structured output against expected domain contract
    const parsed = rawCliResult.structured_output;
    this.validateStructuredOutput(parsed);

    return {
      memeType: this.normalizeMemeType(parsed.memeType),
      arrangement: this.normalizeArrangement(parsed.arrangement, parsed.subjectCount || parsed.subjects?.length || 2),
      subjectCount: Number(parsed.subjectCount) || (Array.isArray(parsed.subjects) ? parsed.subjects.length : 1),
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects.map((s: any) => String(s).trim()) : [],
      headline: parsed.headline ? String(parsed.headline).trim() : undefined,
      bulletPoints: Array.isArray(parsed.bulletPoints) ? parsed.bulletPoints.map((b: any) => String(b).trim()).filter(Boolean) : undefined,
      statement: parsed.statement ? String(parsed.statement).trim() : undefined,
      itemLabels: Array.isArray(parsed.itemLabels) ? parsed.itemLabels.map((l: any) => String(l).trim()) : undefined,
      referenceReactionContext: parsed.referenceReactionContext ? String(parsed.referenceReactionContext).trim() : undefined
    };
  }

  /**
   * Step 2: Verify that uploaded image exists, is readable, and is a valid image.
   */
  private verifyImageInput(imagePath: string): void {
    if (!imagePath || typeof imagePath !== 'string') {
      throw new BadRequestException('Image input missing or invalid path provided.');
    }

    if (!fs.existsSync(imagePath)) {
      throw new BadRequestException(`Reference image does not exist at path: ${imagePath}`);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(imagePath);
    } catch (err: any) {
      throw new BadRequestException(`Cannot access image file at ${imagePath}: ${err.message}`);
    }

    if (stat.size === 0) {
      throw new BadRequestException(`Uploaded reference image is empty (0 bytes): ${imagePath}`);
    }

    try {
      fs.accessSync(imagePath, fs.constants.R_OK);
    } catch (err: any) {
      throw new BadRequestException(`Uploaded reference image is not readable by process: ${err.message}`);
    }

    // Verify image header magic bytes (JPEG, PNG, WEBP)
    try {
      const buffer = Buffer.alloc(12);
      const fd = fs.openSync(imagePath, 'r');
      fs.readSync(fd, buffer, 0, 12, 0);
      fs.closeSync(fd);

      const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
      const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
      const isWebp = buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

      if (!isJpeg && !isPng && !isWebp) {
        this.logger.warn(`File ${imagePath} does not match standard JPEG/PNG/WEBP magic bytes, proceeding with caution.`);
      }
    } catch (err: any) {
      this.logger.warn(`Header inspection warning for ${imagePath}: ${err.message}`);
    }
  }

  /**
   * Step 1 & 4: Executes agy CLI with strict JSON schema enforcement and comprehensive telemetry.
   */
  private runAgyVision(prompt: string, imageDir: string, attempt: number): Promise<CliStructuredEnvelope> {
    return new Promise((resolve, reject) => {
      const args = [
        '--dangerously-skip-permissions',
        '--output-format', 'json',
        '--json-schema', this.schemaPath,
        '--effort', 'low',
        '--add-dir', imageDir,
        '--print', prompt
      ];

      const startTime = Date.now();
      const processTimeout = 60000; // 60 seconds (effort low finishes in ~15-20s)

      this.logger.log(`Starting agy.exe vision analysis (attempt ${attempt}, timeout: ${processTimeout}ms)`);

      execFile(
        this.agyExecutable,
        args,
        { timeout: processTimeout, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);

          // Step 1: Detailed Telemetry Logging (Without exposing any credentials or secrets)
          this.logger.log(
            `agy.exe execution completed in ${duration}s. ExitCode: ${error ? error.code : 0}, ` +
            `Signal: ${error ? error.signal : 'none'}, StdoutLen: ${stdout?.length || 0}, StderrLen: ${stderr?.length || 0}`
          );

          if (error) {
            if ((error as any).code === 'ERR_CHILD_PROCESS_TIMEOUT' || error.signal === 'SIGTERM') {
              return reject(new Error(`Vision analysis timed out after ${processTimeout / 1000} seconds.`));
            }

            const stderrMsg = stderr ? stderr.trim() : '';
            if (stderrMsg.toLowerCase().includes('auth') || stderrMsg.toLowerCase().includes('login')) {
              return reject(new Error('Antigravity CLI authentication error. Please ensure agy CLI is signed in.'));
            }

            return reject(new Error(stderrMsg || error.message));
          }

          if (!stdout || !stdout.trim()) {
            return reject(new Error('CLI returned empty standard output.'));
          }

          try {
            const envelope: CliStructuredEnvelope = JSON.parse(stdout.trim());
            if (envelope.status && envelope.status !== 'SUCCESS') {
              return reject(new Error(`CLI reported failure status: ${envelope.status} - ${envelope.error || envelope.response}`));
            }
            if (!envelope.structured_output && envelope.response) {
              // Fallback parse if envelope placed JSON in response string
              envelope.structured_output = JSON.parse(envelope.response);
            }
            resolve(envelope);
          } catch (jsonErr: any) {
            reject(new Error(`Invalid JSON returned by CLI output: ${jsonErr.message}. Output was: ${stdout.slice(0, 200)}`));
          }
        }
      );
    });
  }

  /**
   * Step 3: Validate the result against domain schema before returning it.
   */
  private validateStructuredOutput(obj: any): void {
    if (!obj || typeof obj !== 'object') {
      throw new BadRequestException('Vision model did not return a valid JSON object.');
    }

    if (!obj.memeType || typeof obj.memeType !== 'string') {
      throw new BadRequestException('Vision model failed to detect a valid memeType.');
    }

    if (!obj.arrangement || typeof obj.arrangement !== 'string') {
      throw new BadRequestException('Vision model failed to detect a valid image arrangement.');
    }

    if (!Array.isArray(obj.subjects) || obj.subjects.length === 0) {
      throw new BadRequestException('Vision model could not detect any subjects in the reference meme.');
    }
  }

  private ensureSchemaFileExists(): void {
    const dir = path.dirname(this.schemaPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.schemaPath)) {
      const schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "memeType": {
            "type": "string",
            "enum": ["movie_update", "facts_collage", "comparison", "trending_news", "custom"]
          },
          "arrangement": {
            "type": "string",
            "enum": ["side_by_side", "columns_3", "columns_4", "grid_2x2", "stacked_rows", "single_hero"]
          },
          "subjectCount": { "type": "integer" },
          "subjects": { "type": "array", "items": { "type": "string" } },
          "headline": { "type": ["string", "null"] },
          "bulletPoints": { "type": "array", "items": { "type": "string" } },
          "statement": { "type": ["string", "null"] },
          "itemLabels": { "type": "array", "items": { "type": "string" } },
          "referenceReactionContext": { "type": ["string", "null"] }
        },
        "required": ["memeType", "arrangement", "subjectCount", "subjects"]
      };
      fs.writeFileSync(this.schemaPath, JSON.stringify(schema, null, 2));
    }
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
