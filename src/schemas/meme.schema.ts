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
  attribution?: string;

  @Prop()
  license?: string;
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

  @Prop({ default: 'center' })
  textAlignment: TextAlignment;

  @Prop()
  customInstructions?: string;
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
}

export const MemeSchema = SchemaFactory.createForClass(Meme);

// Text indexes for fast search
MemeSchema.index({ 'content.topic': 'text', 'content.headline': 'text', 'content.statement': 'text', 'content.punchline': 'text' });

