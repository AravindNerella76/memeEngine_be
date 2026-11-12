import { Injectable, OnModuleInit, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { loadImage } from '@napi-rs/canvas';
import * as path from 'path';
import * as fs from 'fs';
import { LayoutEngineService } from './layout-engine.service';
import { CanvasRendererService, RenderResult } from './canvas-renderer.service';
import { RegenerationService } from './regeneration.service';
import { Meme, MemeDocument } from '../schemas/meme.schema';
import {
  MemeContent,
  MemeAssets,
  DesignSpecifications,
  LayoutConfiguration,
  MemeRecord
} from '../types/meme.types';

export interface GenerateMemeInput {
  content: MemeContent;
  assets: MemeAssets;
  design?: Partial<DesignSpecifications>;
  layout?: Partial<LayoutConfiguration>;
}

export interface MemeFilterQuery {
  search?: string;
  type?: string;
  sort?: 'newest' | 'oldest';
}

@Injectable()
export class MemeEngineService implements OnModuleInit {
  private readonly outputDir = path.join(__dirname, '..', '..', 'output');

  constructor(
    @InjectModel(Meme.name) private readonly memeModel: Model<MemeDocument>,
    private readonly layoutEngine: LayoutEngineService,
    private readonly canvasRenderer: CanvasRendererService,
    private readonly regenerationService: RegenerationService
  ) {}

  onModuleInit() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Retrieves all memes from MongoDB with optional search, filter and sort
   */
  async getAllMemes(query?: MemeFilterQuery): Promise<Meme[]> {
    const filter: any = {};

    if (query?.type && query.type !== 'all') {
      filter['layout.memeType'] = query.type;
    }

    if (query?.search && query.search.trim()) {
      const s = query.search.trim();
      filter.$or = [
        { 'content.topic': { $regex: s, $options: 'i' } },
        { 'content.headline': { $regex: s, $options: 'i' } },
        { 'content.statement': { $regex: s, $options: 'i' } },
        { 'content.punchline': { $regex: s, $options: 'i' } }
      ];
    }

    const sortOrder = query?.sort === 'oldest' ? 1 : -1;
    return this.memeModel.find(filter).sort({ createdAt: sortOrder }).exec();
  }

  /**
   * Retrieves a single meme by memeId
   */
  async getMemeById(memeId: string): Promise<MemeDocument> {
    const meme = await this.memeModel.findOne({ memeId }).exec();
    if (!meme) {
      throw new NotFoundException(`Meme with ID ${memeId} not found in database`);
    }
    return meme;
  }

  /**
   * Generates a new meme (Version 1) and persists document to MongoDB
   */
  async generateMeme(input: GenerateMemeInput): Promise<MemeDocument> {
    const memeId = randomUUID();

    // 1. Resolve Design Specifications
    const preset = input.design?.canvasPreset || 'portrait_4_5';
    const width = 1080;
    const height = preset === 'square_1_1' ? 1080 : 1350;

    const fullDesign: DesignSpecifications = {
      fontFamily: input.design?.fontFamily || 'Arial Black',
      teluguFontFamily: input.design?.teluguFontFamily || 'Ramabhadra',
      canvasPreset: preset,
      width,
      height,
      primaryTextColor: input.design?.primaryTextColor || '#FFE500',
      secondaryTextColor: input.design?.secondaryTextColor || '#FFFFFF',
      headerBgColor: input.design?.headerBgColor || '#000000',
      headerTextColor: input.design?.headerTextColor || '#FFE500',
      outlineColor: input.design?.outlineColor || '#000000',
      outlineThickness: input.design?.outlineThickness !== undefined ? Number(input.design.outlineThickness) : 7,
      shadowColor: input.design?.shadowColor || 'rgba(0,0,0,0.92)',
      shadowBlur: input.design?.shadowBlur !== undefined ? Number(input.design.shadowBlur) : 8,
      shadowOffsetX: 3,
      shadowOffsetY: 3,
      fontSizeScale: input.design?.fontSizeScale !== undefined ? Number(input.design.fontSizeScale) : 1.0,
      textAlignment: input.design?.textAlignment || 'center',
      customInstructions: input.design?.customInstructions
    };

    // 2. Detect dimensions and true aspect ratios of uploaded assets
    const subjectAspectRatios: number[] = [];
    if (input.assets.subjectImages && input.assets.subjectImages.length > 0) {
      for (const asset of input.assets.subjectImages) {
        if (asset.path && fs.existsSync(asset.path)) {
          try {
            const img = await loadImage(asset.path);
            asset.width = img.width;
            asset.height = img.height;
            asset.aspectRatio = Math.round((img.width / img.height) * 1000) / 1000;
            asset.orientation = asset.aspectRatio < 0.95 ? 'portrait' : (asset.aspectRatio > 1.15 ? 'landscape' : 'square');
            subjectAspectRatios.push(asset.aspectRatio);
          } catch (e: any) {
            subjectAspectRatios.push(0.75);
          }
        }
      }
    }

    // Detect reaction image aspect ratio (defaults to 16:9 ~ 1.78)
    let reactionAspectRatio = 16 / 9;
    if (input.assets.reactionImage && input.assets.reactionImage.path && fs.existsSync(input.assets.reactionImage.path)) {
      try {
        const rxImg = await loadImage(input.assets.reactionImage.path);
        input.assets.reactionImage.width = rxImg.width;
        input.assets.reactionImage.height = rxImg.height;
        input.assets.reactionImage.aspectRatio = Math.round((rxImg.width / rxImg.height) * 1000) / 1000;
        input.assets.reactionImage.orientation = 'landscape';
        reactionAspectRatio = input.assets.reactionImage.aspectRatio;
      } catch (e: any) {}
    }

    // 3. Resolve Layout Configuration adapting to source aspect ratios
    const memeType = input.layout?.memeType || 'trending_news';
    const subjectCount = (input.assets.subjectImages || []).length;

    const computedLayout = this.layoutEngine.calculateLayout({
      memeType,
      canvasPreset: preset,
      width,
      height,
      subjectCount,
      hasHeader: Boolean(input.content.headline),
      hasStatement: Boolean(input.content.statement),
      hasBulletPoints: Boolean(input.content.bulletPoints && input.content.bulletPoints.length > 0),
      hasReactionContext: Boolean(input.content.reactionContext),
      hasPunchline: Boolean(input.content.punchline),
      arrangementPreference: input.layout?.arrangement,
      reactionHeightRatio: input.layout?.reactionHeightRatio,
      headerHeightRatio: input.layout?.headerHeightRatio,
      reactionAspectRatio,
      subjectAspectRatios
    });

    // 3. Render Canvas
    const renderResult: RenderResult = await this.canvasRenderer.renderMeme(
      computedLayout,
      input.content,
      input.assets,
      fullDesign
    );

    // 4. Save Version 1 Outputs
    const pngFilename = `meme_${memeId}_v1.png`;
    const jpegFilename = `meme_${memeId}_v1.jpeg`;
    const pngPath = path.join(this.outputDir, pngFilename);
    const jpegPath = path.join(this.outputDir, jpegFilename);

    fs.writeFileSync(pngPath, renderResult.pngBuffer);
    fs.writeFileSync(jpegPath, renderResult.jpegBuffer);

    const fullLayout: LayoutConfiguration = {
      memeType,
      arrangement: computedLayout.arrangement,
      hasHeaderBanner: Boolean(input.content.headline),
      headerHeightRatio: computedLayout.headerBox ? computedLayout.headerBox.height / height : 0,
      reactionHeightRatio: computedLayout.reactionBox ? computedLayout.reactionBox.height / height : 0,
      reactionPosition: 'bottom',
      subjectSectionRatio: computedLayout.subjectSectionBox.height / height,
      gapSize: input.layout?.gapSize || 3
    };

    const initialVersion = {
      versionNumber: 1,
      instruction: 'Initial Generation',
      createdAt: new Date(),
      design: fullDesign,
      layout: fullLayout,
      content: input.content,
      outputPaths: { png: pngPath, jpeg: jpegPath },
      outputUrls: { png: `/output/${pngFilename}`, jpeg: `/output/${jpegFilename}` }
    };

    // 5. Persist to MongoDB
    const createdMeme = new this.memeModel({
      memeId,
      currentVersion: 1,
      content: input.content,
      assets: input.assets,
      design: fullDesign,
      layout: fullLayout,
      outputPaths: { png: pngPath, jpeg: jpegPath },
      outputUrls: { png: `/output/${pngFilename}`, jpeg: `/output/${jpegFilename}` },
      versions: [initialVersion]
    });

    return createdMeme.save();
  }

  /**
   * Natural Language Regeneration
   * Safely updates targeted parameters, re-renders with original assets, and creates Version N+1
   */
  async regenerateWithInstruction(memeId: string, instruction: string): Promise<MemeDocument> {
    const meme = await this.getMemeById(memeId);

    // Convert Mongoose document subdocuments to plain objects
    const currentDesign = (meme.design as any).toObject ? (meme.design as any).toObject() : meme.design;
    const currentLayout = (meme.layout as any).toObject ? (meme.layout as any).toObject() : meme.layout;
    const currentContent = (meme.content as any).toObject ? (meme.content as any).toObject() : meme.content;
    const currentAssets = (meme.assets as any).toObject ? (meme.assets as any).toObject() : meme.assets;

    // Parse instruction into structured parameter mutation
    const parseResult = this.regenerationService.parseInstruction(
      instruction,
      currentDesign,
      currentLayout,
      currentContent
    );

    if (!parseResult.success) {
      throw new BadRequestException(parseResult.message);
    }

    const nextVersion = (meme.currentVersion || 1) + 1;
    const { updatedDesign, updatedLayout, updatedContent } = parseResult;

    // Recalculate layout with aspect ratios preserved
    const computedLayout = this.layoutEngine.calculateLayout({
      memeType: updatedLayout.memeType,
      canvasPreset: updatedDesign.canvasPreset,
      width: updatedDesign.width,
      height: updatedDesign.height,
      subjectCount: (currentAssets.subjectImages || []).length,
      hasHeader: Boolean(updatedContent.headline),
      hasStatement: Boolean(updatedContent.statement),
      hasBulletPoints: Boolean(updatedContent.bulletPoints && updatedContent.bulletPoints.length > 0),
      hasReactionContext: Boolean(updatedContent.reactionContext),
      hasPunchline: Boolean(updatedContent.punchline),
      arrangementPreference: updatedLayout.arrangement,
      reactionHeightRatio: updatedLayout.reactionHeightRatio,
      headerHeightRatio: updatedLayout.headerHeightRatio,
      reactionAspectRatio: currentAssets.reactionImage?.aspectRatio || (16 / 9)
    });

    // Re-render canvas using the original uploaded assets from disk
    const renderResult = await this.canvasRenderer.renderMeme(
      computedLayout,
      updatedContent,
      currentAssets,
      updatedDesign
    );

    // Save Version N+1 files
    const pngFilename = `meme_${memeId}_v${nextVersion}.png`;
    const jpegFilename = `meme_${memeId}_v${nextVersion}.jpeg`;
    const pngPath = path.join(this.outputDir, pngFilename);
    const jpegPath = path.join(this.outputDir, jpegFilename);

    fs.writeFileSync(pngPath, renderResult.pngBuffer);
    fs.writeFileSync(jpegPath, renderResult.jpegBuffer);

    const versionRecord = {
      versionNumber: nextVersion,
      instruction: instruction.trim(),
      createdAt: new Date(),
      design: updatedDesign,
      layout: updatedLayout,
      content: updatedContent,
      outputPaths: { png: pngPath, jpeg: jpegPath },
      outputUrls: { png: `/output/${pngFilename}`, jpeg: `/output/${jpegFilename}` }
    };

    // Update document in MongoDB
    meme.currentVersion = nextVersion;
    meme.design = updatedDesign as any;
    meme.layout = updatedLayout as any;
    meme.content = updatedContent as any;
    meme.outputPaths = { png: pngPath, jpeg: jpegPath };
    meme.outputUrls = { png: `/output/${pngFilename}`, jpeg: `/output/${jpegFilename}` };
    meme.versions.push(versionRecord as any);

    return meme.save();
  }

  /**
   * Restores an earlier version of the meme
   */
  async restoreVersion(memeId: string, targetVersion: number): Promise<MemeDocument> {
    const meme = await this.getMemeById(memeId);
    const versionSnapshot = meme.versions.find(v => v.versionNumber === Number(targetVersion));

    if (!versionSnapshot) {
      throw new NotFoundException(`Version ${targetVersion} does not exist for meme ${memeId}`);
    }

    meme.currentVersion = versionSnapshot.versionNumber;
    meme.design = versionSnapshot.design;
    meme.layout = versionSnapshot.layout;
    meme.content = versionSnapshot.content;
    meme.outputPaths = versionSnapshot.outputPaths;
    meme.outputUrls = versionSnapshot.outputUrls;

    return meme.save();
  }

  /**
   * Deletes a meme document and cleans up associated output files safely
   */
  async deleteMeme(memeId: string): Promise<{ success: boolean; message: string }> {
    const meme = await this.getMemeById(memeId);

    // Delete generated outputs across all versions
    for (const v of meme.versions) {
      if (v.outputPaths) {
        if (v.outputPaths.png && fs.existsSync(v.outputPaths.png)) {
          try { fs.unlinkSync(v.outputPaths.png); } catch (e) {}
        }
        if (v.outputPaths.jpeg && fs.existsSync(v.outputPaths.jpeg)) {
          try { fs.unlinkSync(v.outputPaths.jpeg); } catch (e) {}
        }
      }
    }

    // Also check root outputPaths
    if (meme.outputPaths?.png && fs.existsSync(meme.outputPaths.png)) {
      try { fs.unlinkSync(meme.outputPaths.png); } catch (e) {}
    }
    if (meme.outputPaths?.jpeg && fs.existsSync(meme.outputPaths.jpeg)) {
      try { fs.unlinkSync(meme.outputPaths.jpeg); } catch (e) {}
    }

    // Safely clean unique uploads (skip files in test-assets)
    const allImages = [...(meme.assets.subjectImages || [])];
    if (meme.assets.reactionImage) allImages.push(meme.assets.reactionImage);

    for (const img of allImages) {
      if (img.path && img.path.includes('uploads') && fs.existsSync(img.path)) {
        try { fs.unlinkSync(img.path); } catch (e) {}
      }
    }

    await this.memeModel.deleteOne({ memeId }).exec();
    return { success: true, message: `Meme ${memeId} and its associated version assets deleted safely.` };
  }
}
