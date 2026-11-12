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

export type CanvasDimensionPreset = 'portrait_4_5' | 'square_1_1'; // 1080x1350 or 1080x1080

export type TextAlignment = 'center' | 'left' | 'right';

export type ImageArrangementMode =
  | 'auto'          // Engine automatically chooses based on meme type and asset count
  | 'side_by_side'  // 2 vertical columns
  | 'columns_3'     // 3 vertical columns
  | 'columns_4'     // 4 vertical columns
  | 'grid_2x2'      // 2x2 grid
  | 'stacked_rows'  // Horizontal rows stacked
  | 'single_hero';  // Full width single subject

export type SectionRole =
  | 'header'
  | 'subject_primary'
  | 'subject_secondary'
  | 'subject_item'
  | 'reaction_punchline';

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
}

export interface MemeAssets {
  subjectImages: UploadedAsset[];  // Ordered subject images with explicit roles & labels
  reactionImage?: UploadedAsset;   // Dedicated reaction / punchline scene image
}

/**
 * 3. Design Specifications - Full visual and typography styling
 */
export interface DesignSpecifications {
  fontFamily: 'Montserrat' | 'Anton' | 'Arial Black' | 'Impact' | 'Intrepid ExtraBold' | 'Intrepid' | 'Ramabhadra' | 'Mandali' | 'Noto Sans Telugu' | string;
  teluguFontFamily: 'Ramabhadra' | 'Mandali' | 'Noto Sans Telugu' | string;
  
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
  textAlignment: TextAlignment;

  // Custom free-form design instructions for regeneration
  customInstructions?: string;
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

