/**
 * Fonts the renderer can draw. Each family is registered from memeEngine_be/fonts at startup
 * (CanvasRendererService.registerFonts). Settings may only reference these families.
 */
export const FONT_FILES: { file: string; family: string; script: 'english' | 'telugu' | 'emoji' }[] = [
  // Emoji in meme text: bundled so they look the same on every machine (see fonts/NotoColorEmoji.NOTICE.txt). Not a
  // font anyone chooses: it is only used for characters the meme fonts do not have.
  { file: 'NotoColorEmoji.ttf', family: 'Noto Color Emoji', script: 'emoji' },
  { file: 'Ramabhadra-Regular.ttf', family: 'Ramabhadra', script: 'telugu' },
  { file: 'Mandali-Regular.ttf', family: 'Mandali', script: 'telugu' },
  { file: 'NotoSansTelugu-Bold.ttf', family: 'Noto Sans Telugu', script: 'telugu' },
  { file: 'AnekTelugu-VariableFont_wdth,wght.ttf', family: 'Anek Telugu', script: 'telugu' },
  { file: 'AnekTelugu-VariableFont_wdth,wght.ttf', family: 'AnekTelugu', script: 'telugu' },
  { file: 'Poppins-Black.ttf', family: 'Poppins Black', script: 'english' },
  { file: 'Anton-Regular.ttf', family: 'Anton', script: 'english' },
  { file: 'Arial-Black.ttf', family: 'Arial Black', script: 'english' },
  { file: 'Impact.ttf', family: 'Impact', script: 'english' },
  { file: 'Intrepid-ExtraBold.ttf', family: 'Intrepid ExtraBold', script: 'english' },
  { file: 'Intrepid-ExtraBold.ttf', family: 'Intrepid', script: 'english' }
];

/** The family emoji are drawn with (last in every meme font stack, before the generic fallback). */
export const EMOJI_FONT = 'Noto Color Emoji';

export const ENGLISH_FONTS = ['Poppins Black', 'Arial Black', 'Anton', 'Impact', 'Intrepid ExtraBold', 'Intrepid'];
export const TELUGU_FONTS = ['Ramabhadra', 'Mandali', 'Noto Sans Telugu', 'Anek Telugu'];
