import { UnprocessableEntityException } from '@nestjs/common';
import { DesignSpecifications, LayoutConfiguration, MemeAssets, MemeContent } from '../types/meme.types';
import { layoutStyleFromDesign, resolveRenderStyle } from '../design/render-style';
import { ComputedMemeLayout, LayoutEngineService } from './layout-engine.service';
import { CanvasRendererService, RenderOptions, RenderResult, RenderValidationError, TextFitError } from './canvas-renderer.service';

export interface LayoutRenderResult {
  computed: ComputedMemeLayout;
  render: RenderResult;
  headerHeightRatio?: number;
  attempts: number;
}

/**
 * Lays out and renders one meme. If the headline needs more room the header grows (up to the
 * style's maximum header share); any other text that cannot fit, or a structurally invalid render,
 * becomes a clear 422 error. Used by generation, regeneration and the settings preview alike.
 */
export async function layoutAndRender(
  layoutEngine: LayoutEngineService,
  renderer: CanvasRendererService,
  design: DesignSpecifications,
  layoutCfg: Partial<LayoutConfiguration>,
  content: MemeContent,
  assets: MemeAssets,
  ratios: { subjectAspectRatios: number[]; reactionAspectRatio: number },
  options: RenderOptions = {}
): Promise<LayoutRenderResult> {
  const style = resolveRenderStyle(design);
  const layoutStyle = layoutStyleFromDesign(design);
  const maxHeader = style.canvas.maxHeaderRatio;
  // memes without a settings snapshot keep the original five attempts (0.2 maximum header)
  const maxAttempts = style.legacy ? 5 : 3 + Math.ceil(maxHeader / 0.03);
  let headerHeightRatio = layoutCfg.headerHeightRatio;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const computed = layoutEngine.calculateLayout({
      memeType: layoutCfg.memeType || 'trending_news',
      canvasPreset: design.canvasPreset,
      width: design.width,
      height: design.height,
      subjectCount: (assets.subjectImages || []).length,
      hasHeader: Boolean(content.headline),
      hasStatement: Boolean(content.statement),
      hasBulletPoints: Boolean(content.bulletPoints && content.bulletPoints.length > 0),
      hasReactionContext: Boolean(content.reactionContext),
      hasPunchline: Boolean(content.punchline),
      arrangementPreference: layoutCfg.arrangement,
      reactionHeightRatio: layoutCfg.reactionHeightRatio,
      headerHeightRatio,
      reactionAspectRatio: ratios.reactionAspectRatio,
      subjectAspectRatios: ratios.subjectAspectRatios,
      grid: layoutCfg.grid,
      style: layoutStyle
    });
    try {
      const render = await renderer.renderMeme(computed, content, assets, design, options);
      return { computed, render, headerHeightRatio, attempts: attempt };
    } catch (err: any) {
      if (err instanceof TextFitError && err.element === 'headline') {
        const current = computed.headerBox ? computed.headerBox.height / computed.canvasHeight : 0.082;
        if (current >= maxHeader) throw new UnprocessableEntityException('The headline is too long to fit even in an enlarged header.');
        headerHeightRatio = Math.min(maxHeader, Math.round((current + 0.03) * 1000) / 1000);
        continue;
      }
      if (err instanceof TextFitError || err instanceof RenderValidationError) {
        throw new UnprocessableEntityException(err.message);
      }
      throw err;
    }
  }
  throw new UnprocessableEntityException('The text could not be fitted into the layout.');
}
