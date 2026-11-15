import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  MemeType,
  ImageArrangementMode,
  CanvasDimensionPreset,
  TextAlignment
} from '../types/meme.types';

export type MemeDocument = Meme & Document;

@Schema({ _id: false })
export class MemeContentSchema {
  @Prop({ required: true })
  topic: string;

  @Prop()
  headline?: string;

  @Prop()
  subHeadline?: string;

  @Prop()
  statement?: string;

  @Prop()
  supportingText?: string;

  @Prop([String])
  bulletPoints?: string[];

  @Prop()
  reactionContext?: string;

  @Prop({ required: true })
  punchline: string;

  @Prop([String])
  itemLabels?: string[];
}

@Schema({ _id: false })
export class UploadedAssetSchema {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  originalName: string;

  @Prop({ required: true })
  filename: string;

  @Prop({ required: true })
  path: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop()
  width?: number;

  @Prop()
  height?: number;

  @Prop()
  aspectRatio?: number;

  @Prop()
  orientation?: string;

  @Prop({ required: true })
  role: string;

  @Prop({ required: true })
  orderIndex: number;

  @Prop()
  label?: string;

  @Prop()
  sourceUrl?: string;

  @Prop()
  sourcePage?: string;

  @Prop()
  sha256?: string;

  @Prop()
  focalX?: number;

  @Prop()
  focalY?: number;

  @Prop()
  attribution?: string;

  @Prop()
  license?: string;

  /** Search provider that found an internet-discovered image. */
  @Prop()
  provider?: string;

  /** Rights record (classification, label, basis, whether the source link could be stored). */
  @Prop({ type: Object })
  rights?: Record<string, unknown>;

  /** same_picture | same_scene | different | unknown (relation to the reference picture). */
  @Prop()
  referenceMatch?: string;

  /** ai_discovery | online_search | user_upload */
  @Prop()
  sourceType?: string;

  /** ai | user */
  @Prop()
  selectedBy?: string;

  /** True only when the AI visually verified the picture. */
  @Prop()
  aiVerified?: boolean;
}

@Schema({ _id: false })
export class MemeAssetsSchema {
  @Prop({ type: [UploadedAssetSchema], default: [] })
  subjectImages: UploadedAssetSchema[];

  @Prop({ type: UploadedAssetSchema })
  reactionImage?: UploadedAssetSchema;
}

@Schema({ _id: false })
export class DesignSpecificationsSchema {
  @Prop({ default: 'Arial Black' })
  fontFamily: string;

  @Prop({ default: 'Ramabhadra' })
  teluguFontFamily: string;

  @Prop({ default: 'portrait_4_5' })
  canvasPreset: CanvasDimensionPreset;

  @Prop({ default: 1080 })
  width: number;

  @Prop({ default: 1350 })
  height: number;

  @Prop({ default: '#FFE500' })
  primaryTextColor: string;

  @Prop({ default: '#FFFFFF' })
  secondaryTextColor: string;

  @Prop({ default: '#000000' })
  headerBgColor: string;

  @Prop({ default: '#FFE500' })
  headerTextColor: string;

  @Prop({ default: '#000000' })
  outlineColor: string;

  @Prop({ default: 7 })
  outlineThickness: number;

  @Prop({ default: 'rgba(0,0,0,0.92)' })
  shadowColor: string;

  @Prop({ default: 8 })
  shadowBlur: number;

  @Prop({ default: 3 })
  shadowOffsetX: number;

  @Prop({ default: 3 })
  shadowOffsetY: number;

  @Prop({ default: 1.0 })
  fontSizeScale: number;

  /** Per-element text multipliers: { headline, statement, bullets, labels, reactionContext, punchline } */
  @Prop({ type: Object })
  textScales?: Record<string, number>;

  @Prop({ default: 'center' })
  textAlignment: TextAlignment;

  @Prop()
  customInstructions?: string;

  /** Settings snapshot taken at generation (absent on older memes). */
  @Prop({ type: Object })
  style?: Record<string, unknown>;

  /** The owner's choice for how the reaction image is framed ({ split?, focus? }); absent = automatic. */
  @Prop({ type: Object })
  reactionFraming?: Record<string, unknown>;
}

@Schema({ _id: false })
export class LayoutConfigurationSchema {
  @Prop({ required: true })
  memeType: MemeType;

  @Prop({ default: 'auto' })
  arrangement: ImageArrangementMode;

  @Prop({ default: true })
  hasHeaderBanner: boolean;

  @Prop({ default: 0.085 })
  headerHeightRatio: number;

  @Prop({ default: 0.38 })
  reactionHeightRatio: number;

  @Prop({ default: 'bottom' })
  reactionPosition: string;

  @Prop({ default: 0.535 })
  subjectSectionRatio: number;

  @Prop({ default: 3 })
  gapSize: number;

  /** Relative row heights / slot widths for custom_grid and unequal layouts */
  @Prop({ type: Object })
  grid?: { rows: { heightWeight: number; slots: { widthWeight: number }[] }[] };
}

@Schema({ _id: false })
export class MemeVersionRecordSchema {
  @Prop({ required: true })
  versionNumber: number;

  @Prop({ default: 'Initial Generation' })
  instruction: string;

  @Prop({ default: Date.now })
  createdAt: Date;

  @Prop({ type: DesignSpecificationsSchema, required: true })
  design: DesignSpecificationsSchema;

  @Prop({ type: LayoutConfigurationSchema, required: true })
  layout: LayoutConfigurationSchema;

  @Prop({ type: MemeContentSchema, required: true })
  content: MemeContentSchema;

  @Prop({ type: Object, required: true })
  outputPaths: { png: string; jpeg: string };

  @Prop({ type: Object, required: true })
  outputUrls: { png: string; jpeg: string };

  /** Structured changes applied by this version's instruction */
  @Prop({ type: [String], default: [] })
  appliedChanges?: string[];

  /** 'ai' | 'keyword' | 'initial' */
  @Prop()
  interpreter?: string;

  /** Snapshot of the images used by this version (so restoring brings back replaced images) */
  @Prop({ type: Object })
  assets?: Record<string, unknown>;

  /** Images replaced by this version (previous and replacement, source, rights, slot, time) */
  @Prop({ type: [Object], default: [] })
  imageChanges?: Record<string, unknown>[];

  /** Direct Instagram publishing record for this specific version */
  @Prop({ type: Object })
  instagramPublish?: Record<string, unknown>;
}

@Schema({ timestamps: true })
export class Meme {
  @Prop({ required: true, unique: true, index: true })
  memeId: string;

  @Prop({ default: 1 })
  currentVersion: number;

  @Prop({ type: MemeContentSchema, required: true })
  content: MemeContentSchema;

  @Prop({ type: MemeAssetsSchema, required: true })
  assets: MemeAssetsSchema;

  @Prop({ type: DesignSpecificationsSchema, required: true })
  design: DesignSpecificationsSchema;

  @Prop({ type: LayoutConfigurationSchema, required: true })
  layout: LayoutConfigurationSchema;

  @Prop({ type: Object, required: true })
  outputPaths: { png: string; jpeg: string };

  @Prop({ type: Object, required: true })
  outputUrls: { png: string; jpeg: string };

  @Prop({ type: [MemeVersionRecordSchema], default: [] })
  versions: MemeVersionRecordSchema[];

  /** 'manual' | 'viral_adaptation_v2' | 'reference_sample' */
  @Prop()
  pipeline?: string;

  /** Private copy of the viral reference screenshot (never served publicly) */
  @Prop({ type: UploadedAssetSchema })
  referenceImage?: UploadedAssetSchema;

  /** Explainability record of the viral pipeline: analysis, identities, queries, candidates, decisions */
  @Prop({ type: Object })
  generationReport?: Record<string, any>;

  /** Direct Instagram publishing record */
  @Prop({ type: Object })
  instagramPublish?: Record<string, any>;
}

export const MemeSchema = SchemaFactory.createForClass(Meme);

// Text indexes for fast search
MemeSchema.index({ 'content.topic': 'text', 'content.headline': 'text', 'content.statement': 'text', 'content.punchline': 'text' });

