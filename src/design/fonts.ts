/**
 * Fonts the renderer can draw. Each family is registered from memeEngine_be/fonts at startup
 * (CanvasRendererService.registerFonts). Settings may only reference these families.
 */
export const FONT_FILES: { file: string; family: string; script: 'english' | 'telugu' }[] = [
  { file: 'Ramabhadra-Regular.ttf', family: 'Ramabhadra', script: 'telugu' },
  { file: 'Mandali-Regular.ttf', family: 'Mandali', script: 'telugu' },
  { file: 'NotoSansTelugu-Bold.ttf', family: 'Noto Sans Telugu', script: 'telugu' },
  { file: 'AnekTelugu-VariableFont_wdth,wght.ttf', family: 'Anek Telugu', script: 'telugu' },
  { file: 'AnekTelugu-VariableFont_wdth,wght.ttf', family: 'AnekTelugu', script: 'telugu' },
  { file: 'Anton-Regular.ttf', family: 'Anton', script: 'english' },
  { file: 'Arial-Black.ttf', family: 'Arial Black', script: 'english' },
  { file: 'Impact.ttf', family: 'Impact', script: 'english' },
  { file: 'Intrepid-ExtraBold.ttf', family: 'Intrepid ExtraBold', script: 'english' },
  { file: 'Intrepid-ExtraBold.ttf', family: 'Intrepid', script: 'english' }
];

export const ENGLISH_FONTS = ['Arial Black', 'Anton', 'Impact', 'Intrepid ExtraBold', 'Intrepid'];
export const TELUGU_FONTS = ['Ramabhadra', 'Mandali', 'Noto Sans Telugu', 'Anek Telugu'];
