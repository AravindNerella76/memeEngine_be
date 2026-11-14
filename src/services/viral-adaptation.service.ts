/**
 * Viral meme adaptation pipeline (v2). Three user inputs: reference screenshot, own reaction image,
 * exact punchline. Responsibilities are separated:
 *
 *   AI (sandboxed vision CLI)   reference understanding, visual verification of candidate images
 *   application logic           identity rules, query planning, ranking, downloads, validation,
 *                               layout maths, persistence, explainability report
 *   canvas renderer             pixels
 *
 *  1. analyse the reference (per-slot structure, subjects, context, text)
 *  2. resolve every slot's identity (fail safe: ambiguous -> explain, never guess)
 *  3. build content: reference text + the user's EXACT punchline (never the reference punchline)
 *  4. apply the personal design profile; plan the layout from the reference structure
 *  5. discover, rank and visually verify one real image per slot (internet only)
 *  6. render (text fitting, structural output checks) and persist with the generation report
 */
import { GoneException, HttpException, Injectable, InternalServerErrorException, Logger, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { loadImage } from '@napi-rs/canvas';
import { describeConfig, getConfig } from '../config/app-config';
import { ReferenceAnalysis, ReferenceSlot } from '../analysis/reference-analysis.types';
import { arrangementFromAnalysis } from '../analysis/reference-analysis.normalizer';
import { deriveGridFromAnalysis, headerRatioFromAnalysis, reactionRatioFromAnalysis } from '../analysis/layout-planner';
import { IdentityDecision, resolveSlotIdentity } from '../identity/slot-identity';
import { DiscoveryRunResult, SlotDiscoveryError } from '../discovery/discovery-engine';
import { cropRegionToJpeg } from '../vision/vision-image-prep';
import { assertSlot, ImageSelectionService, StagedImage } from './image-selection.service';
import { SlotDiscoveryPlan, SlotDiscoveryReport } from '../discovery/discovery.types';
import { DesignProfileService } from '../design/design-profile.service';
import { DEFAULT_HEADER_RATIO, DEFAULT_PROFILE_ID } from '../design/design-profile';
import { layoutStyleFromDesign } from '../design/render-style';
import { MemeContent, UploadedAsset } from '../types/meme.types';
import { SubjectKind } from '../analysis/reference-analysis.types';
import { safeDeleteFile, sanitizeDisplayName, UPLOADS_ROOT } from '../security/path-guard';
import { ViralMemeAnalyzerService } from './viral-meme-analyzer.service';
import { InternetSubjectDiscoveryService } from './internet-subject-discovery.service';
import { MemeEngineService } from './meme-engine.service';
import { LayoutEngineService } from './layout-engine.service';
import { CanvasRendererService } from './canvas-renderer.service';

export interface ViralUpload {
  path: string;
  filename: string;
  originalName: string;
  mimeType: string;
}

/** A slot the user supplied their own picture for (a staged, validated image). */
export interface SlotOverride {
  slot: number;
  token: string;
}

export interface ViralAdaptInput {
  /** The reference upload. Omitted when `draftId` (an earlier analysis of the reference) is given. */
  reference?: ViralUpload;
  /** Reuse the analysis from POST /api/memes/viral-analyze (no second analysis). */
  draftId?: string;
  /** Slots the user filled with their own pictures: they skip identity checks and internet discovery. */
  overrides?: SlotOverride[];
  reaction: ViralUpload;
  /** Exact punchline (only surrounding whitespace removed by validation). */
  punchline: string;
  reactionContext?: string;
  fontFamily?: string;
  selectedProviders?: string[];
}

function scriptOf(s: string): 'telugu' | 'english' | 'mixed' {
  const te = /[ఀ-౿]/.test(s);
  const en = /[A-Za-z]/.test(s);
  return te && en ? 'mixed' : te ? 'telugu' : 'english';
}

function groundingTextOf(a: ReferenceAnalysis): string {
  return [
    a.header.text,
    a.overlayText.statement,
    a.overlayText.attribution,
    ...a.overlayText.bulletPoints,
    ...a.slots.flatMap(s => [s.label, s.nameAsWritten, s.identifiedName, s.characterName, s.context.movieTitle, s.context.eventName, s.context.otherContext]),
    a.summary
  ].filter(Boolean).join(' . ');
}

function filmEvidenceFor(a: ReferenceAnalysis, slot: ReferenceSlot): string {
  return [slot.context.movieTitle, a.header.text, a.overlayText.statement, ...a.overlayText.bulletPoints, ...a.slots.filter(s => s !== slot).map(s => s.label)].filter(Boolean).join(' . ');
}

interface AnalysisDraft {
  id: string;
  reference: ViralUpload;
  run: Awaited<ReturnType<ViralMemeAnalyzerService['analyzeReference']>>;
  createdAt: number;
}

const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 4;

@Injectable()
export class ViralAdaptationService {
  private readonly logger = new Logger(ViralAdaptationService.name);
  private active = 0;
  private readonly drafts = new Map<string, AnalysisDraft>();

  constructor(
    private readonly analyzer: ViralMemeAnalyzerService,
    private readonly discovery: InternetSubjectDiscoveryService,
    private readonly memeEngine: MemeEngineService,
    private readonly layoutEngine: LayoutEngineService,
    private readonly profiles: DesignProfileService,
    private readonly selection: ImageSelectionService
  ) {}

  private dropDraft(d: AnalysisDraft, deleteFile: boolean) {
    this.drafts.delete(d.id);
    if (deleteFile) safeDeleteFile(d.reference.path, UPLOADS_ROOT);
  }

  private purgeDrafts() {
    const now = Date.now();
    for (const d of Array.from(this.drafts.values())) if (now - d.createdAt > DRAFT_TTL_MS) this.dropDraft(d, true);
    const all = Array.from(this.drafts.values()).sort((a, b) => a.createdAt - b.createdAt);
    while (all.length > MAX_DRAFTS) this.dropDraft(all.shift() as AnalysisDraft, true);
  }

  /**
   * Step 1 of the optional "choose your own images" flow: analyses the reference once and returns the
   * image slots (with a crop of each from the reference). The analysis is kept for 30 minutes so
   * generating afterwards does not repeat it. Nothing is searched or generated here.
   */
  async analyzeDraft(reference: ViralUpload) {
    const cfg = getConfig();
    if (this.active >= cfg.adaptationMaxConcurrent) {
      throw new HttpException({ statusCode: 429, message: 'Another viral adaptation is still running. Please wait for it to finish and try again.' }, 429);
    }
    this.active++;
    try {
      this.purgeDrafts();
      const run = await this.analyzer.analyzeReference(reference.path);
      const analysis = run.analysis;
      const groundingText = groundingTextOf(analysis);
      const slots = await Promise.all(
        analysis.slots.map(async slot => {
          const decision = resolveSlotIdentity(
            {
              nameAsWritten: slot.nameAsWritten,
              aiIdentifiedName: slot.identifiedName,
              aiCharacterName: slot.characterName,
              aiEvidence: slot.identificationEvidence,
              aiConfidence: slot.identityConfidence,
              subjectKind: slot.subjectKind,
              context: groundingText,
              filmEvidence: filmEvidenceFor(analysis, slot)
            },
            cfg.identity.aiMinConfidence
          );
          let crop: string | null = null;
          try {
            const c = slot.bbox ? await cropRegionToJpeg(reference.path, slot.bbox, { maxSide: 260, minSide: 40 }) : null;
            if (c) crop = `data:image/jpeg;base64,${c.buffer.toString('base64')}`;
          } catch {
            /* the crop is only a convenience */
          }
          return {
            slot: slot.index + 1,
            label: slot.label || null,
            subject: decision.searchName || slot.nameAsWritten || slot.identifiedName || null,
            imageType: slot.imageType,
            identity: decision.status,
            referenceCrop: crop
          };
        })
      );
      const draft: AnalysisDraft = { id: randomUUID(), reference, run, createdAt: Date.now() };
      this.drafts.set(draft.id, draft);
      return {
        draftId: draft.id,
        expiresInSeconds: DRAFT_TTL_MS / 1000,
        memeFormat: analysis.memeFormat,
        slots,
        warnings: analysis.suspectedPromptInjection ? ['The reference screenshot contained text addressed to the AI. It was treated as plain data and ignored.'] : []
      };
    } finally {
      this.active--;
    }
  }

  async adapt(input: ViralAdaptInput): Promise<{ meme: any; adaptationMetadata: Record<string, unknown> }> {
    const cfg = getConfig();
    if (this.active >= cfg.adaptationMaxConcurrent) {
      throw new HttpException({ statusCode: 429, message: 'Another viral adaptation is still running. Please wait for it to finish and try again.' }, 429);
    }
    this.purgeDrafts();
    const draft = input.draftId ? this.drafts.get(input.draftId) : undefined;
    if (input.draftId && !draft) {
      throw new GoneException('The analysis of the reference has expired. Analyse the reference again, or generate without choosing images.');
    }
    const reference = (draft ? draft.reference : input.reference) as ViralUpload;
    if (!reference) throw new UnprocessableEntityException('Input 1 missing: Viral Meme Reference screenshot is required.');
    this.active++;
    const startedAt = new Date();
    const timings: Record<string, number> = {};
    const warnings: string[] = [];
    let discovered: UploadedAsset[] = [];
    try {
      // 1. Reference analysis (sandboxed vision model, verification-code checked); reused from a draft when there is one
      let t = Date.now();
      const run = draft ? draft.run : await this.analyzer.analyzeReference(reference.path);
      timings.analysisMs = draft ? 0 : Date.now() - t;
      if (draft) warnings.push('The analysis of the reference was done earlier (when you chose your own images) and reused.');
      const analysis = run.analysis;
      if (analysis.suspectedPromptInjection) warnings.push('The reference screenshot contained text addressed to the AI. It was treated as plain data and ignored.');
      if (!analysis.reactionPanel.present) warnings.push('No reaction panel was detected in the reference; your reaction image and punchline were added at the bottom.');

      // User-chosen pictures: validated against the number of slots found in the reference
      const overrideBySlot = new Map<number, StagedImage>();
      for (const o of input.overrides || []) {
        const n = assertSlot(o.slot, analysis.slots.length);
        if (overrideBySlot.has(n - 1)) throw new UnprocessableEntityException(`Image ${n} was given twice.`);
        overrideBySlot.set(n - 1, this.selection.get(o.token));
      }

      // 2. Identity of every slot
      t = Date.now();
      const groundingText = groundingTextOf(analysis);
      const identities = analysis.slots.map(slot => ({
        slot,
        decision: resolveSlotIdentity(
          {
            nameAsWritten: slot.nameAsWritten,
            aiIdentifiedName: slot.identifiedName,
            aiCharacterName: slot.characterName,
            aiEvidence: slot.identificationEvidence,
            aiConfidence: slot.identityConfidence,
            subjectKind: slot.subjectKind,
            context: groundingText,
            filmEvidence: filmEvidenceFor(analysis, slot)
          },
          cfg.identity.aiMinConfidence
        )
      }));
      timings.identityMs = Date.now() - t;
      // a slot the user filled with their own picture needs no identity: nothing is searched for it
      const unresolved = identities.filter(x => x.decision.status !== 'resolved' && !overrideBySlot.has(x.slot.index));
      if (unresolved.length) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          message:
            `Could not safely identify ${unresolved.length === 1 ? 'the subject of slot ' + (unresolved[0].slot.index + 1) : unresolved.length + ' subjects'}: ` +
            unresolved.map(u => `slot ${u.slot.index + 1}: ${u.decision.reasons.join(' ')}${u.decision.candidates.length ? ` Possible: ${u.decision.candidates.map(c => `${c.name} (${c.note})`).join(', ')}.` : ''}`).join(' | ') +
            ' Nothing was searched for these slots, so no wrong person could be used.',
          details: {
            stage: 'identity',
            slots: identities.map(i => ({ slot: i.slot.index + 1, status: i.decision.status, reasons: i.decision.reasons, candidates: i.decision.candidates }))
          }
        });
      }
      identities.filter(i => !overrideBySlot.has(i.slot.index)).forEach(i => i.decision.warnings.forEach(w => warnings.push(`slot ${i.slot.index + 1}: ${w}`)));

      // 3. Content: reference text + the user's exact punchline (the reference punchline is never read)
      const statement = analysis.overlayText.statement
        ? analysis.overlayText.attribution
          ? `${analysis.overlayText.statement}\n- ${analysis.overlayText.attribution.replace(/^[\s\-–—]+/, '')}`
          : analysis.overlayText.statement
        : undefined;
      const labels = analysis.slots.map(s => s.label || '');
      const content: MemeContent = {
        topic: `Viral adaptation: ${analysis.header.text || identities.map(i => i.decision.searchName).join(' & ')}`.slice(0, 300),
        headline: analysis.header.present ? analysis.header.text || undefined : undefined,
        statement,
        bulletPoints: analysis.overlayText.bulletPoints.length ? analysis.overlayText.bulletPoints : undefined,
        reactionContext: input.reactionContext || undefined,
        punchline: input.punchline,
        itemLabels: labels.some(Boolean) ? labels : undefined
      };

      // 4. Settings (house style, snapshotted into the meme) + layout plan from the reference
      const settings = await this.profiles.getSettings();
      const design = await this.profiles.newMemeDesign(input.fontFamily);
      if (input.fontFamily && !CanvasRendererService.ENGLISH_FONTS.includes(input.fontFamily)) {
        warnings.push(`Font "${input.fontFamily}" is not installed on the server; the Settings font ${design.fontFamily} was used.`);
      }
      const layoutStyle = layoutStyleFromDesign(design);
      const arrangement = arrangementFromAnalysis(analysis);
      const grid = deriveGridFromAnalysis(analysis);
      const headerHeightRatio = content.headline ? headerRatioFromAnalysis(analysis, settings.canvas.headerRatio ?? DEFAULT_HEADER_RATIO) : undefined;
      const reactionHeightRatio = reactionRatioFromAnalysis(analysis);
      let reactionAspect = 16 / 9;
      try {
        const rx = await loadImage(input.reaction.path);
        reactionAspect = rx.width / rx.height;
      } catch {
        throw new UnprocessableEntityException('Your reaction image could not be decoded.');
      }
      const prelim = this.layoutEngine.calculateLayout({
        memeType: analysis.legacyMemeType,
        canvasPreset: design.canvasPreset,
        width: design.width,
        height: design.height,
        subjectCount: analysis.slots.length,
        hasHeader: Boolean(content.headline),
        hasStatement: Boolean(content.statement),
        hasBulletPoints: Boolean(content.bulletPoints?.length),
        hasReactionContext: Boolean(content.reactionContext),
        hasPunchline: true,
        arrangementPreference: arrangement,
        grid,
        headerHeightRatio,
        reactionHeightRatio,
        reactionAspectRatio: reactionAspect,
        style: layoutStyle
      });

      // 5. Internet discovery (exclusive source of subject images) with visual verification
      const plans: SlotDiscoveryPlan[] = identities.filter(x => !overrideBySlot.has(x.slot.index)).map(({ slot, decision }: { slot: ReferenceSlot; decision: IdentityDecision }) => {
        const i = slot.index;
        const box = prelim.subjectSlots[i]?.box || prelim.subjectSectionBox;
        return {
          slotId: slot.slotId,
          index: i,
          identity: decision,
          subjectName: decision.searchName as string,
          subjectKind: (slot.subjectKind === 'movie_character' ? 'person' : slot.subjectKind) as SubjectKind,
          desiredImageType: slot.imageType,
          context: { ...slot.context, characterName: decision.profile?.character?.name || slot.characterName },
          label: slot.label,
          visualPurpose: slot.visualPurpose,
          visualCharacteristics: slot.visualCharacteristics,
          orientation: slot.orientation,
          targetWidth: box.width,
          targetHeight: box.height,
          aiSearchTerms: slot.searchTerms,
          groundingText,
          referenceBox: slot.bbox
        } as SlotDiscoveryPlan;
      });
      t = Date.now();
      const empty: DiscoveryRunResult = { assets: [], reports: [], visionCalls: [], warnings: [] };
      const found = plans.length ? await this.discovery.discoverForSlots(plans, reference.path, input.selectedProviders) : empty;
      timings.discoveryMs = Date.now() - t;
      discovered = [...found.assets];
      warnings.push(...found.warnings);

      // Merge AI-found pictures with the user's own, in slot order. A user's picture is never replaced by the AI.
      const subjectAssets: UploadedAsset[] = [];
      const slotReports: any[] = [];
      let aiIndex = 0;
      for (const { slot } of identities) {
        const ov = overrideBySlot.get(slot.index);
        if (!ov) {
          subjectAssets.push(found.assets[aiIndex]);
          slotReports.push(found.reports[aiIndex]);
          aiIndex++;
          continue;
        }
        const file = this.selection.writeToDisk(ov);
        const asset = this.selection.assetFor(ov, file, { role: slot.index === 0 ? 'subject_primary' : slot.index === 1 ? 'subject_secondary' : 'subject_item', orderIndex: slot.index, label: slot.label || undefined }, true);
        discovered.push(asset);
        subjectAssets.push(asset);
        slotReports.push({
          slotId: slot.slotId,
          subject: slot.label || slot.nameAsWritten || `image ${slot.index + 1}`,
          desiredImageType: slot.imageType,
          context: {},
          queries: [],
          droppedSearchTerms: [],
          providersUsed: [],
          providerErrors: [],
          rounds: 0,
          candidatesConsidered: 0,
          downloads: 0,
          visualChecks: 0,
          alternates: [],
          rejected: [],
          warnings: [],
          notes: ['You chose this picture yourself, so nothing was searched for this slot and the AI did not check it.'],
          durationMs: 0,
          userProvided: true,
          sourceType: asset.sourceType
        });
        warnings.push(`slot ${slot.index + 1}: picture chosen by you (${ov.sourceType === 'user_upload' ? 'your upload' : 'online search'}); it was not identity-checked by the AI.`);
      }
      const disc = { assets: subjectAssets, reports: slotReports, visionCalls: found.visionCalls };

      // 6. Render + persist (with explainability report)
      const reactionImage: UploadedAsset = {
        id: randomUUID(),
        originalName: sanitizeDisplayName(input.reaction.originalName),
        filename: input.reaction.filename,
        path: input.reaction.path,
        mimeType: input.reaction.mimeType,
        role: 'reaction_punchline',
        orderIndex: 99
      };
      const referenceImage: UploadedAsset = {
        id: randomUUID(),
        originalName: sanitizeDisplayName(reference.originalName),
        filename: reference.filename,
        path: reference.path,
        mimeType: reference.mimeType,
        role: 'reference',
        orderIndex: -1
      };
      const allCalls = [...run.calls, ...disc.visionCalls];
      const report: Record<string, any> = {
        version: 2,
        pipeline: 'viral_adaptation_v2',
        startedAt: startedAt.toISOString(),
        models: { analysis: run.model, verification: cfg.vision.verifyModel, verifyMode: cfg.vision.verifyCandidates },
        referenceAnalysis: analysis,
        identities: identities.map(({ slot, decision }) => ({
          slotId: slot.slotId,
          nameAsWritten: slot.nameAsWritten,
          aiIdentifiedName: slot.identifiedName,
          aiEvidence: slot.identificationEvidence,
          aiConfidence: slot.identityConfidence,
          characterName: slot.characterName,
          status: decision.status,
          resolvedName: decision.searchName,
          method: decision.method,
          confidence: decision.confidence,
          reasons: decision.reasons,
          warnings: decision.warnings,
          character: decision.profile?.character || null
        })),
        slots: disc.reports,
        rights: {
          policy: cfg.discovery.rightsPolicy,
          selected: disc.assets.map(a => ({ slot: a.orderIndex + 1, provider: a.provider, classification: a.rights?.classification, label: a.rights?.label, sourceStored: a.rights?.sourceStored !== false }))
        },
        layout: {
          arrangement,
          grid: grid || null,
          headerHeightRatio: headerHeightRatio ?? null,
          reactionHeightRatio: reactionHeightRatio ?? null,
          preliminarySlots: prelim.subjectSlots.map(s => s.box)
        },
        userSelections: Array.from(overrideBySlot.entries()).map(([i, st]) => ({ slot: i + 1, sourceType: st.sourceType, originalName: st.originalName, aiVerified: false })),
        design: {
          profileId: DEFAULT_PROFILE_ID,
          profileName: settings.name,
          settingsUpdatedAt: settings.updatedAt || null,
          englishFont: design.fontFamily,
          teluguFont: design.teluguFontFamily,
          primary: design.primaryTextColor,
          secondary: design.secondaryTextColor,
          canvas: `${design.width}x${design.height}`
        },
        inputs: { punchlineLength: input.punchline.length, punchlineScript: scriptOf(input.punchline), reactionContextProvided: Boolean(input.reactionContext), fontRequested: input.fontFamily || null },
        visionCalls: allCalls.map(c => ({ purpose: c.purpose, model: c.model, attempt: c.attempt, ok: c.ok, durationMs: c.durationMs, inputTokens: c.inputTokens, outputTokens: c.outputTokens, thinkingTokens: c.thinkingTokens, deniedActions: c.deniedActions, error: c.error })),
        retries: {
          analysisAttempts: run.calls.length,
          verificationCalls: disc.visionCalls.length,
          discoveryRounds: disc.reports.reduce((a: number, r: SlotDiscoveryReport) => a + (r.rounds || 0), 0)
        },
        security: {
          suspectedPromptInjection: analysis.suspectedPromptInjection,
          deniedToolActions: Array.from(new Set(allCalls.flatMap(c => c.deniedActions)))
        },
        warnings
      };
      if (cfg.diagnostics) {
        // Settings > Advanced > Diagnostics: the effective (redacted) pipeline configuration of this run
        report.diagnostics = {
          config: describeConfig(cfg),
          pipeline: {
            maxDownloadsPerSlot: cfg.discovery.maxDownloadsPerSlot,
            maxRounds: cfg.discovery.maxRounds,
            shortlistSize: cfg.discovery.shortlistSize,
            visualMinConfidence: cfg.discovery.visualMinConfidence,
            identityAiMinConfidence: cfg.identity.aiMinConfidence,
            duplicateHamming: cfg.discovery.duplicateHamming,
            minImageSide: cfg.discovery.minImageSide,
            maxUpscale: cfg.discovery.maxUpscale,
            watermarkPolicy: cfg.discovery.watermarkPolicy,
            downloadTimeoutMs: cfg.discovery.downloadTimeoutMs,
            visionTimeoutMs: cfg.vision.timeoutMs,
            visionMaxAttempts: cfg.vision.maxAttempts
          },
          selectedProviders: input.selectedProviders || null,
          layoutStyle: layoutStyle || null
        };
      }

      t = Date.now();
      const meme = await this.memeEngine.generateMeme(
        {
          content,
          assets: { subjectImages: disc.assets, reactionImage },
          design,
          layout: { memeType: analysis.legacyMemeType, arrangement, grid, headerHeightRatio, reactionHeightRatio, gapSize: 0 }
        },
        { pipeline: 'viral_adaptation_v2', referenceImage, generationReport: report }
      );
      timings.renderMs = Date.now() - t;

      if (meme.content.punchline !== input.punchline) {
        throw new InternalServerErrorException('Punchline integrity check failed: the stored text differs from your input.');
      }

      // success: the staged choices and the analysis draft are used up (the reference file now belongs to the meme)
      for (const st of overrideBySlot.values()) this.selection.discard(st.token);
      if (draft) this.dropDraft(draft, false);

      const finishedAt = new Date();
      meme.generationReport = {
        ...(meme.generationReport as any),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        stageTimings: timings
      } as any;
      meme.markModified('generationReport');
      await meme.save();

      const plainMeme = typeof (meme as any).toObject === 'function' ? (meme as any).toObject() : meme;
      return {
        meme: plainMeme,
        adaptationMetadata: {
          pipelineVersion: 2,
          referenceImageFilename: reference.filename,
          detectedMemeType: analysis.legacyMemeType,
          detectedFormat: analysis.memeFormat,
          detectedArrangement: arrangement,
          identifiedSubjects: identities.map(i => i.decision.searchName),
          identityMethods: identities.map(i => i.decision.method),
          discoverySource: 'internet_only',
          rightsPolicy: cfg.discovery.rightsPolicy,
          matchedSubjectAssets: disc.assets.map(s => ({
            originalName: s.originalName,
            label: s.label,
            sourceUrl: s.sourceUrl,
            sourcePage: s.sourcePage,
            license: s.license,
            attribution: s.attribution,
            provider: s.provider,
            rights: s.rights ? { classification: s.rights.classification, label: s.rights.label, attributionRequired: s.rights.attributionRequired, shareAlike: s.rights.shareAlike, sourceStored: s.rights.sourceStored } : undefined,
            referenceMatch: s.referenceMatch
          })),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          warnings
        }
      };
    } catch (err: any) {
      for (const a of discovered) safeDeleteFile(a.path, UPLOADS_ROOT);
      if (err instanceof SlotDiscoveryError) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          message: err.message,
          details: {
            stage: 'discovery',
            failedSlot: err.failedSlotId,
            slots: err.reports.map(r => ({
              slotId: r.slotId,
              subject: r.subject,
              selected: r.selected ? { title: r.selected.title, provider: r.selected.provider, sourceUrl: r.selected.sourceUrl } : null,
              queries: r.queries.map(q => q.query),
              providers: r.providersUsed,
              closestRejected: r.rejected.slice(0, 5),
              warnings: r.warnings
            }))
          }
        });
      }
      throw err;
    } finally {
      this.active--;
    }
  }
}
