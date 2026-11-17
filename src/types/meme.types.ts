import type { StyleSnapshot } from '../design/render-style';
/**
 * Meme Domain Models - Strict Separation of Concerns
 * 1. Content: What the meme says (Telugu / English text, headlines, punchlines)
 * 2. Assets: Raw images and their explicit assignments to sections
 * 3. Design: Styling, typography, colors, strokes, alignment, and aspect ratio
 * 4. Layout: Structural type, dynamic section splits, and image arrangement mode
 */

export type MemeType =
  | 'facts_collage'
  | 'comparison'
  | 'trending_news'
  | 'movie_update'
  | 'custom';

export type CanvasDimensionPreset = 'portrait_4_5' | 'square_1_1' | 'story_9_16'; // 1080x1350, 1080x1080 or 1080x1920

export type TextAlignment = 'center' | 'left' | 'right';

export type ImageArrangementMode =
  | 'auto'          // Engine automatically chooses based on meme type and asset count
  | 'side_by_side'  // 2 vertical columns
  | 'columns_3'     // 3 vertical columns
  | 'columns_4'     // 4 vertical columns
  | 'grid_2x2'      // 2x2 grid
  | 'stacked_rows'  // Horizontal rows stacked
  | 'single_hero'   // Full width single subject
  | 'custom_grid';  // Rows with their own slot counts and relative sizes (derived from the reference)

/** Relative row heights and slot widths for 'custom_grid' (and for unequal standard layouts). */
export interface GridSpec {
  rows: { heightWeight: number; slots: { widthWeight: number }[] }[];
}

/** Per-element text size multipliers (applied on top of fontSizeScale). */
export interface TextScales {
  headline?: number;
  statement?: number;
  bullets?: number;
  labels?: number;
  reactionContext?: number;
  punchline?: number;
}

export type SectionRole =
  | 'header'
  | 'subject_primary'
  | 'subject_secondary'
  | 'subject_item'
  | 'reaction_punchline'
  | 'reference';          // private copy of the viral reference screenshot (never rendered)

/**
 * 1. Meme Content - Pure textual information
 */
export interface MemeContent {
  topic: string;                  // Subject or news description
  headline?: string;               // Optional top banner headline (e.g. "OG CENSOR REPORT")
  subHeadline?: string;            // Secondary topic line
  statement?: string;              // Main statement / quote / news body
  supportingText?: string;         // Additional bullet points or notes
  bulletPoints?: string[];         // Multiple update points (e.g. 1st half, interval, etc.)
  reactionContext?: string;        // E.g. "* BOSS AND AKHIL"
  punchline: string;               // Telugu punchline (e.g. "EKKESARU AYYA OKA METTU EKKESAV")
  itemLabels?: string[];           // Per-image subcaptions (e.g. "7 GATES OF VAIKUNTAM", "931 CRORES")
}

/**
 * 2. Uploaded Assets - Explicit mapping of images to their section/role
 */
export interface UploadedAsset {
  id: string;                      // Unique asset identifier
  originalName: string;
  filename: string;
  path: string;                    // Disk storage path
  mimeType: string;
  width?: number;
  height?: number;
  aspectRatio?: number;            // width / height
  orientation?: 'portrait' | 'landscape' | 'square';
  role: SectionRole;               // Explicit section mapping ('subject_primary', 'reaction_punchline', etc.)
  orderIndex: number;              // Position in sequence (0, 1, 2, ...)
  label?: string;                  // Content label bound directly to this asset
  sourceUrl?: string;              // Internet source URL (the image file)
  sourcePage?: string;             // Human-readable page the image came from
  sha256?: string;                 // Content hash (re-verifies alternates and detects duplicates)
  focalX?: number;                 // Subject focus (0-1) used to centre the crop
  focalY?: number;
  attribution?: string;            // Photographer / Creator attribution
  license?: string;                // Licence as given by the source (or "Unknown ...")
  provider?: string;               // Search provider that found the image (internet discovery)
  /**
   * Rights record of an internet-discovered image: "open_license", "open_license_restricted" or
   * "copyrighted_unconfirmed" (reuse permission not confirmed), with label, basis and whether the
   * source link could be stored under the provider's terms.
   */
  rights?: AssetRights;
  /** How the image relates to the reference picture: same_picture | same_scene | different | unknown. */
  referenceMatch?: string;
  /** Where the picture came from: AI discovery, an online search the user ran, or the user's own upload. */
  sourceType?: ImageSourceType;
  /** Who chose it. A user choice is never replaced silently by the AI. */
  selectedBy?: 'ai' | 'user';
  /** True only when the AI visually verified this picture (never for a user's own choice). */
  aiVerified?: boolean;
}

export type ImageSourceType = 'ai_discovery' | 'online_search' | 'user_upload';

/** One replaced image, stored in the new version (history keeps every earlier version untouched). */
export interface ImageChangeRecord {
  slot: number;
  at: string;
  sourceType: ImageSourceType;
  sourceUrl?: string;
  previous: { assetId?: string; filename?: string; sha256?: string; sourceType?: ImageSourceType; sourceUrl?: string; provider?: string };
  replacement: { assetId: string; filename: string; originalName: string; sha256?: string; provider?: string; sourcePage?: string; license?: string; rights?: AssetRights; width?: number; height?: number };
}

export interface AssetRights {
  classification: 'open_license' | 'open_license_restricted' | 'copyrighted_unconfirmed';
  label: string;
  license?: string;
  licenseUrl?: string;
  attributionRequired: boolean;
  shareAlike: boolean;
  restriction?: string;
  attribution?: string;
  provider: string;
  basis: string;
  sourceStored: boolean;
  storageNote?: string;
}

export interface MemeAssets {
  subjectImages: UploadedAsset[];  // Ordered subject images with explicit roles & labels
  reactionImage?: UploadedAsset;   // Dedicated reaction / punchline scene image
}

/**
 * 3. Design Specifications - Full visual and typography styling
 */
import type { ReactionFraming } from '../services/reaction-framing';

export interface DesignSpecifications {
  fontFamily: 'Montserrat' | 'Anton' | 'Arial Black' | 'Impact' | 'Intrepid ExtraBold' | 'Intrepid' | 'Ramabhadra' | 'Mandali' | 'Noto Sans Telugu' | string;
  teluguFontFamily: 'Ramabhadra' | 'Mandali' | 'Noto Sans Telugu' | 'Anek Telugu' | 'AnekTelugu' | string;
  
  // Dimensions
  canvasPreset: CanvasDimensionPreset;
  width: number;                   // Usually 1080
  height: number;                  // 1350 for portrait, 1080 for square

  // Colors
  primaryTextColor: string;        // Default '#FFE500' (Vibrant Yellow)
  secondaryTextColor: string;      // Default '#FFFFFF' (Pure White)
  headerBgColor: string;           // Default '#000000'
  headerTextColor: string;         // Default '#FFE500' or '#FFFFFF'

  // Outlines & Shadows
  outlineColor: string;            // Default '#000000'
  outlineThickness: number;        // Default 6 - 8px
  shadowColor: string;             // Default 'rgba(0,0,0,0.85)'
  shadowBlur: number;              // Default 6 - 10px
  shadowOffsetX: number;           // Default 2 - 4px
  shadowOffsetY: number;           // Default 2 - 4px

  // Typography scaling
  fontSizeScale: number;           // 1.0 default (0.7 to 1.5 for regeneration tuning)
  textScales?: TextScales;         // Per-element multipliers (headline, punchline, ...)
  textAlignment: TextAlignment;

  // Custom free-form design instructions for regeneration
  customInstructions?: string;

  /**
   * Snapshot of the Settings (typography, effects, canvas, image processing) taken when the meme was
   * generated. Absent on memes created before Settings existed (they keep the original style).
   */
  style?: StyleSnapshot;

  /**
   * How subject images fit their slots: 'cover' (fills slot, crops excess edges) or 'contain' (fits whole picture without cropping).
   */
  subjectFit?: 'cover' | 'contain';

  /**
   * How the reaction image sits in its panel, when the owner chose (or turned off) the automatic framing of stacked
   * pictures. Absent: decided from the picture itself on every render.
   */
  reactionFraming?: ReactionFraming;
}

/**
 * 4. Layout Configurations - Dynamic spatial composition
 */
export interface LayoutConfiguration {
  memeType: MemeType;
  arrangement: ImageArrangementMode;
  
  hasHeaderBanner: boolean;
  headerHeightRatio: number;       // Typically 0.08 to 0.12 of total height
  
  reactionHeightRatio: number;     // Dynamic: typically 0.35 to 0.45 of total height
  reactionPosition: 'bottom' | 'top' | 'none'; // Standard is 'bottom'
  
  subjectSectionRatio: number;     // Computed dynamically: 1 - header - reaction
  
  gridColumns?: number;            // For collage or comparison (e.g. 2, 3, 4)
  gridRows?: number;
  grid?: GridSpec;                 // Relative row/slot sizes ('custom_grid' or unequal layouts)
  gapSize: number;                 // Border spacing between cells (0 or 2-4px)
}

/**
 * Calculated Bounding Box for any section or overlay
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Complete Meme Generation Job / Saved Record
 */
export interface MemeRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  
  content: MemeContent;
  assets: MemeAssets;
  design: DesignSpecifications;
  layout: LayoutConfiguration;
  
  outputPaths: {
    png: string;
    jpeg: string;
  };
  outputUrls: {
    png: string;
    jpeg: string;
  };
  
  generationCount: number;
  revisionHistory?: Array<{
    timestamp: Date;
    instruction: string;
    designSnapshot: Partial<DesignSpecifications>;
    layoutSnapshot: Partial<LayoutConfiguration>;
  }>;
}

