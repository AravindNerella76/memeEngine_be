import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import { getConfig } from '../config/app-config';
import { buildReferenceAnalysisPrompt, REFERENCE_IMAGE_NAME } from '../analysis/reference-analysis.prompt';
import { normalizeReferenceAnalysis, toLegacyAnalysis } from '../analysis/reference-analysis.normalizer';
import { LegacyViralAnalysis, ReferenceAnalysis } from '../analysis/reference-analysis.types';
import { inspectImageFileHeader, ImageValidationError } from '../security/image-verify';
import { makeVerificationCode, prepareImageForVision } from '../vision/vision-image-prep';
import { VisionCallMeta, VisionCliRunner, VisionError } from '../vision/vision-cli.runner';

/** Kept for backward compatibility with the original pipeline. */
export type ViralMemeAnalysisResult = LegacyViralAnalysis;

export interface ReferenceAnalysisRun {
  analysis: ReferenceAnalysis;
  legacy: LegacyViralAnalysis;
  calls: VisionCallMeta[];
  durationMs: number;
  model: string;
  /** Size of the meme area that was analysed (all bbox fractions refer to it). */
  imageWidth: number;
  imageHeight: number;
}

/**
 * Analyses a viral meme reference screenshot with the sandboxed vision CLI and returns a
 * validated, per-slot description of its structure and subjects.
 */
@Injectable()
export class ViralMemeAnalyzerService {
  private readonly logger = new Logger(ViralMemeAnalyzerService.name);

  constructor(private readonly runner: VisionCliRunner) {}

  async analyzeReference(imagePath: string): Promise<ReferenceAnalysisRun> {
    this.verifyImageInput(imagePath);
    const started = Date.now();
    const code = makeVerificationCode();
    const prepared = await prepareImageForVision(imagePath, { code, maxSide: 1600 });
    const model = getConfig().vision.analysisModel;

    try {
      const { value, calls } = await this.runner.runJsonTask({
        purpose: 'reference_analysis',
        model,
        prompt: buildReferenceAnalysisPrompt(),
        images: [{ name: REFERENCE_IMAGE_NAME, data: prepared.buffer }],
        validate: json => normalizeReferenceAnalysis(json, { expectedCode: code, contentAspect: prepared.width / prepared.contentHeight })
      });
      if (value.slots.length === 0) {
        throw new BadRequestException(
          'The reference analysis found no subject image sections above the reaction panel, so there is nothing to adapt. Please use a meme screenshot with at least one subject image.'
        );
      }
      if (value.suspectedPromptInjection) {
        this.logger.warn('Reference screenshot contained text that tried to instruct the AI; it was treated as plain data.');
      }
      return {
        analysis: value,
        legacy: toLegacyAnalysis(value),
        calls,
        durationMs: Date.now() - started,
        model,
        imageWidth: prepared.width,
        imageHeight: prepared.contentHeight
      };
    } catch (err: any) {
      if (err instanceof VisionError) {
        const message = `Failed to analyze viral meme reference: ${err.message}`;
        if (err.code === 'NOT_CONFIGURED' || err.code === 'AUTH') throw new ServiceUnavailableException(message);
        throw new BadRequestException(message);
      }
      throw err;
    }
  }

  /** Original API: returns only the legacy fields. */
  async analyzeViralReference(imagePath: string): Promise<ViralMemeAnalysisResult> {
    return (await this.analyzeReference(imagePath)).legacy;
  }

  private verifyImageInput(imagePath: string): void {
    if (!imagePath || typeof imagePath !== 'string' || !fs.existsSync(imagePath)) {
      throw new BadRequestException('Reference image is missing.');
    }
    try {
      inspectImageFileHeader(imagePath);
    } catch (err: any) {
      if (err instanceof ImageValidationError) throw new BadRequestException(`Reference image is not usable: ${err.message}`);
      throw err;
    }
  }
}
