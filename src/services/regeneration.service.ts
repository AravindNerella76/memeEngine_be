import { Injectable } from '@nestjs/common';
import {
  DesignSpecifications,
  LayoutConfiguration,
  MemeContent
} from '../types/meme.types';

export interface RegenerationParseResult {
  success: boolean;
  message: string;
  appliedChanges: string[];
  updatedDesign: DesignSpecifications;
  updatedLayout: LayoutConfiguration;
  updatedContent: MemeContent;
}

@Injectable()
export class RegenerationService {
  /**
   * Structured Natural Language Instruction Parser
   * Maps natural language adjustment commands to strict, safe parameter mutations.
   * Never evaluates arbitrary code. Preserves all other settings.
   */
  parseInstruction(
    instruction: string,
    currentDesign: DesignSpecifications,
    currentLayout: LayoutConfiguration,
    currentContent: MemeContent
  ): RegenerationParseResult {
    const text = instruction.toLowerCase().trim();
    const appliedChanges: string[] = [];

    // Clone objects so original state is strictly preserved
    const rawDesign = (currentDesign as any).toObject ? (currentDesign as any).toObject() : currentDesign;
    const rawLayout = (currentLayout as any).toObject ? (currentLayout as any).toObject() : currentLayout;
    const rawContent = (currentContent as any).toObject ? (currentContent as any).toObject() : currentContent;

    const updatedDesign: DesignSpecifications = {
      ...rawDesign,
      fontSizeScale: Number(rawDesign.fontSizeScale) || 1.0,
      outlineThickness: Number(rawDesign.outlineThickness) || 7,
      shadowBlur: Number(rawDesign.shadowBlur) || 8,
      width: Number(rawDesign.width) || 1080,
      height: Number(rawDesign.height) || 1350
    };
    const updatedLayout: LayoutConfiguration = {
      ...rawLayout,
      reactionHeightRatio: Number(rawLayout.reactionHeightRatio) || 0.38,
      gapSize: Number(rawLayout.gapSize) || 3
    };
    const updatedContent: MemeContent = {
      ...rawContent
    };

    let recognized = false;

    // 1. Font Size / Scaling
    if (text.includes('headline') && (text.includes('big') || text.includes('large') || text.includes('increase'))) {
      const matchPercent = text.match(/(\d+)\s*%/);
      const percent = matchPercent ? parseInt(matchPercent[1], 10) / 100 : 0.15;
      const cur = updatedDesign.fontSizeScale;
      updatedDesign.fontSizeScale = Math.min(1.4, Math.round((cur + percent) * 100) / 100);
      appliedChanges.push(`Increased font size scale to ${updatedDesign.fontSizeScale}x`);
      recognized = true;
    } else if (text.includes('headline') && (text.includes('small') || text.includes('reduce') || text.includes('decrease'))) {
      const matchPercent = text.match(/(\d+)\s*%/);
      const percent = matchPercent ? parseInt(matchPercent[1], 10) / 100 : 0.15;
      const cur = updatedDesign.fontSizeScale;
      updatedDesign.fontSizeScale = Math.max(0.7, Math.round((cur - percent) * 100) / 100);
      appliedChanges.push(`Reduced font size scale to ${updatedDesign.fontSizeScale}x`);
      recognized = true;
    } else if ((text.includes('punchline') || text.includes('telugu')) && (text.includes('big') || text.includes('large') || text.includes('increase'))) {
      const cur = updatedDesign.fontSizeScale;
      updatedDesign.fontSizeScale = Math.min(1.4, Math.round((cur + 0.15) * 100) / 100);
      appliedChanges.push(`Increased punchline / text scale to ${updatedDesign.fontSizeScale}x`);
      recognized = true;
    } else if (text.includes('text') && (text.includes('small') || text.includes('reduce'))) {
      const cur = updatedDesign.fontSizeScale;
      updatedDesign.fontSizeScale = Math.max(0.7, Math.round((cur - 0.15) * 100) / 100);
      appliedChanges.push(`Reduced text scale to ${updatedDesign.fontSizeScale}x`);
      recognized = true;
    } else if (text.includes('text') && (text.includes('big') || text.includes('large') || text.includes('increase'))) {
      const cur = updatedDesign.fontSizeScale;
      updatedDesign.fontSizeScale = Math.min(1.4, Math.round((cur + 0.15) * 100) / 100);
      appliedChanges.push(`Increased text scale to ${updatedDesign.fontSizeScale}x`);
      recognized = true;
    }

    // 2. Colors
    if (text.includes('headline') && text.includes('white')) {
      updatedDesign.headerTextColor = '#FFFFFF';
      appliedChanges.push('Changed headline text color to pure white (#FFFFFF)');
      recognized = true;
    } else if (text.includes('headline') && text.includes('yellow')) {
      updatedDesign.headerTextColor = '#FFE500';
      appliedChanges.push('Changed headline text color to vibrant yellow (#FFE500)');
      recognized = true;
    }

    if ((text.includes('text') || text.includes('colour') || text.includes('color')) && text.includes('yellow')) {
      updatedDesign.primaryTextColor = '#FFE500';
      appliedChanges.push('Changed primary text highlight color to yellow (#FFE500)');
      recognized = true;
    } else if ((text.includes('text') || text.includes('colour') || text.includes('color')) && text.includes('white')) {
      updatedDesign.secondaryTextColor = '#FFFFFF';
      appliedChanges.push('Changed secondary text color to pure white (#FFFFFF)');
      recognized = true;
    } else if ((text.includes('text') || text.includes('colour') || text.includes('color')) && text.includes('cyan')) {
      updatedDesign.primaryTextColor = '#00E5FF';
      appliedChanges.push('Changed primary text color to cyan (#00E5FF)');
      recognized = true;
    } else if ((text.includes('text') || text.includes('colour') || text.includes('color')) && text.includes('red')) {
      updatedDesign.primaryTextColor = '#EF4444';
      appliedChanges.push('Changed primary text color to red (#EF4444)');
      recognized = true;
    }

    // 3. Reaction Section Height & Positioning
    if (
      (text.includes('reaction') || text.includes('bottom image') || text.includes('punchline section')) &&
      (text.includes('increase') || text.includes('bigger') || text.includes('larger') || text.includes('upward') || text.includes('more space'))
    ) {
      const curRatio = updatedLayout.reactionHeightRatio || 0.38;
      updatedLayout.reactionHeightRatio = Math.min(0.48, Math.round((curRatio + 0.06) * 100) / 100);
      appliedChanges.push(`Increased reaction section height ratio to ${updatedLayout.reactionHeightRatio * 100}%`);
      recognized = true;
    } else if (
      (text.includes('reaction') || text.includes('bottom image') || text.includes('punchline section')) &&
      (text.includes('decrease') || text.includes('smaller') || text.includes('downward') || text.includes('less space'))
    ) {
      const curRatio = updatedLayout.reactionHeightRatio || 0.38;
      updatedLayout.reactionHeightRatio = Math.max(0.26, Math.round((curRatio - 0.06) * 100) / 100);
      appliedChanges.push(`Reduced reaction section height ratio to ${updatedLayout.reactionHeightRatio * 100}%`);
      recognized = true;
    }

    // 4. Outlines / Strokes
    if (text.includes('outline') || text.includes('stroke')) {
      if (text.includes('thick') || text.includes('increase') || text.includes('heavy') || text.includes('more')) {
        updatedDesign.outlineThickness = Math.min(14, updatedDesign.outlineThickness + 2);
        appliedChanges.push(`Increased black outline thickness to ${updatedDesign.outlineThickness}px`);
        recognized = true;
      } else if (text.includes('thin') || text.includes('reduce') || text.includes('decrease') || text.includes('less')) {
        updatedDesign.outlineThickness = Math.max(3, updatedDesign.outlineThickness - 2);
        appliedChanges.push(`Reduced black outline thickness to ${updatedDesign.outlineThickness}px`);
        recognized = true;
      }
    }

    // 5. English Font Switching
    if (text.includes('intrepid') || text.includes('intreb')) {
      updatedDesign.fontFamily = 'Intrepid ExtraBold';
      appliedChanges.push('Changed English font family to Intrepid ExtraBold');
      recognized = true;
    } else if (text.includes('anton')) {
      updatedDesign.fontFamily = 'Anton';
      appliedChanges.push('Changed English font family to Anton');
      recognized = true;
    } else if (text.includes('montserrat')) {
      updatedDesign.fontFamily = 'Montserrat';
      appliedChanges.push('Changed English font family to Montserrat');
      recognized = true;
    } else if (text.includes('arial black') || text.includes('arial')) {
      updatedDesign.fontFamily = 'Arial Black';
      appliedChanges.push('Changed English font family to Arial Black');
      recognized = true;
    } else if (text.includes('impact')) {
      updatedDesign.fontFamily = 'Impact';
      appliedChanges.push('Changed English font family to Impact');
      recognized = true;
    }

    // 6. Telugu Font Switching
    if (text.includes('ramabhadra')) {
      updatedDesign.teluguFontFamily = 'Ramabhadra';
      appliedChanges.push('Changed Telugu font family to Ramabhadra');
      recognized = true;
    } else if (text.includes('mandali')) {
      updatedDesign.teluguFontFamily = 'Mandali';
      appliedChanges.push('Changed Telugu font family to Mandali');
      recognized = true;
    } else if (text.includes('noto sans')) {
      updatedDesign.teluguFontFamily = 'Noto Sans Telugu';
      appliedChanges.push('Changed Telugu font family to Noto Sans Telugu');
      recognized = true;
    }

    // 7. Image Gaps
    if (text.includes('gap') || text.includes('spacing between images') || text.includes('border')) {
      if (text.includes('reduce') || text.includes('remove') || text.includes('no') || text.includes('less')) {
        updatedLayout.gapSize = 1;
        appliedChanges.push('Reduced image cell gap to 1px');
        recognized = true;
      } else if (text.includes('increase') || text.includes('more') || text.includes('bigger')) {
        updatedLayout.gapSize = 6;
        appliedChanges.push('Increased image cell gap to 6px');
        recognized = true;
      }
    }

    if (!recognized) {
      return {
        success: false,
        message: `Could not determine exact design adjustment from "${instruction}". Supported adjustments include: sizing ("make headline 20% bigger", "reduce text size"), colors ("change headline colour to white", "change text colour to yellow"), reaction positioning ("increase reaction height", "move bottom image upward"), outlines ("make outline thicker/thinner"), fonts ("use Anton font", "use Mandali for Telugu"), and gaps ("reduce image gaps").`,
        appliedChanges: [],
        updatedDesign: currentDesign,
        updatedLayout: currentLayout,
        updatedContent: currentContent
      };
    }

    return {
      success: true,
      message: appliedChanges.join(', '),
      appliedChanges,
      updatedDesign,
      updatedLayout,
      updatedContent
    };
  }
}
