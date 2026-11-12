import {
  MemeContent,
  MemeAssets,
  DesignSpecifications,
  LayoutConfiguration
} from '../types/meme.types';

export class GenerateMemeDto {
  content: MemeContent;
  assets: MemeAssets;
  design?: Partial<DesignSpecifications>;
  layout?: Partial<LayoutConfiguration>;
}

