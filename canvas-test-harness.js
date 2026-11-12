const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

// Register all fonts
const fontsDir = path.join(__dirname, 'fonts');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Ramabhadra-Regular.ttf'), 'Ramabhadra');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Mandali-Regular.ttf'), 'Mandali');
GlobalFonts.registerFromPath(path.join(fontsDir, 'NotoSansTelugu-Bold.ttf'), 'Noto Sans Telugu');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Anton-Regular.ttf'), 'Anton');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Arial-Black.ttf'), 'Arial Black');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Impact.ttf'), 'Impact');

/**
 * Smart Center Crop: Draws source image into destination rect preserving aspect ratio
 */
function drawCoverImage(ctx, img, destX, destY, destW, destH) {
  const imgW = img.width;
  const imgH = img.height;
  const imgAspect = imgW / imgH;
  const destAspect = destW / destH;

  let sx, sy, sWidth, sHeight;

  if (imgAspect > destAspect) {
    // Source is wider than dest: crop left and right
    sHeight = imgH;
    sWidth = imgH * destAspect;
    sx = (imgW - sWidth) / 2;
    sy = 0;
  } else {
    // Source is taller than dest: crop top and bottom
    sWidth = imgW;
    sHeight = imgW / destAspect;
    sx = 0;
    sy = (imgH - sHeight) / 2;
  }

  ctx.drawImage(img, sx, sy, sWidth, sHeight, destX, destY, destW, destH);
}

/**
 * Automatic Word Wrap with multi-pass measurement
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine ? currentLine + ' ' + word : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * Draw meme text with heavy black stroke and shadow
 */
function drawMemeText(ctx, text, x, y, options = {}) {
  const {
    fillColor = '#FFE500',
    strokeColor = '#000000',
    strokeWidth = 8,
    shadowColor = 'rgba(0,0,0,0.9)',
    shadowBlur = 8,
    align = 'center',
    baseline = 'middle'
  } = options;

  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Shadow for stroke
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = shadowBlur;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 3;

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.strokeText(text, x, y);

  // Reset shadow for crisp inner fill
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);

  ctx.restore();
}

/**
 * Test generating a complete automated meme reference standard:
 * 1. Top Headline Banner
 * 2. 2 Side-by-Side Subject Images (OG Movie scenes)
 * 3. Overlaid Review Points (Yellow & White)
 * 4. Bottom Telugu Movie Reaction Image
 * 5. Overlaid Telugu Punchline ("ఎక్కేసారు అయ్యా ఒక మెట్టు ఎక్కేసారు")
 */
async function runVisualReferenceTest() {
  const width = 1080;
  const height = 1350; // 4:5 Instagram Portrait
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  // 1. Header Banner (8% height: 110px)
  const headerHeight = 110;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, headerHeight);

  ctx.font = 'bold 54px "Arial Black", "Anton", sans-serif';
  drawMemeText(ctx, 'OG CENSOR REPORT', width / 2, headerHeight / 2, {
    fillColor: '#FFE500',
    strokeWidth: 6,
    align: 'center'
  });

  // Load sample image
  const samplePath = 'D:/memes/portfolio/samples/WhatsApp Image 2026-11-12 at 9.23.53 PM.jpeg';
  if (!fs.existsSync(samplePath)) {
    console.error('Sample image not found:', samplePath);
    return;
  }
  const sampleImg = await loadImage(samplePath);

  // 2. Subject Section: From y = 110 to y = 820 (height = 710px)
  // Let's composite the top half of the sample image into the subject section
  const subjectY = headerHeight;
  const subjectH = 710;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, subjectY, width, subjectH);
  ctx.clip();
  drawCoverImage(ctx, sampleImg, 0, subjectY, width, subjectH);
  ctx.restore();

  // Overlaid Review Highlights across the subject section
  const highlights = [
    { text: 'DECENT 1ST HALF', color: '#FFE500' },
    { text: 'MASSIVE INTERVAL SEQUENCE', color: '#FFFFFF' },
    { text: 'TERRIFIC 2ND HALF', color: '#FFE500' },
    { text: '3 MAJOR SEQUENCES', color: '#FFFFFF' }
  ];

  ctx.font = 'bold 44px "Arial Black", "Anton", sans-serif';
  const startHighlightY = subjectY + subjectH - 220;
  highlights.forEach((item, idx) => {
    drawMemeText(ctx, item.text, width / 2, startHighlightY + (idx * 52), {
      fillColor: item.color,
      strokeWidth: 7,
      align: 'center'
    });
  });

  // Dividing border
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, subjectY + subjectH);
  ctx.lineTo(width, subjectY + subjectH);
  ctx.stroke();

  // 3. Reaction Section: From y = 820 to y = 1350 (height = 530px)
  const reactionY = subjectY + subjectH;
  const reactionH = height - reactionY;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, reactionY, width, reactionH);
  ctx.clip();
  // Draw reaction portion
  drawCoverImage(ctx, sampleImg, 0, reactionY - 200, width, reactionH + 200);
  ctx.restore();

  // Context Tag
  ctx.font = 'bold 36px "Arial Black", "Anton", sans-serif';
  drawMemeText(ctx, '* THEATRE LO AUDIENCE RESPONSE', width / 2, reactionY + 45, {
    fillColor: '#FFE500',
    strokeWidth: 6,
    align: 'center'
  });

  // Telugu Punchline at the bottom of reaction panel (both in Telugu script and transliterated)
  ctx.font = 'bold 46px "Ramabhadra", "Noto Sans Telugu", sans-serif';
  drawMemeText(ctx, 'చిన్న పాజిటివ్ టాక్ వచ్చినా', width / 2, reactionY + reactionH - 110, {
    fillColor: '#FFE500',
    strokeWidth: 8,
    align: 'center'
  });

  drawMemeText(ctx, '500 CR కొట్టే దాకా ఆగదు!', width / 2, reactionY + reactionH - 45, {
    fillColor: '#FFFFFF',
    strokeWidth: 8,
    align: 'center'
  });

  const outDir = path.join(__dirname, 'test-output');
  const outputPath = path.join(outDir, 'phase1-reference-standard.png');
  fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
  console.log('Generated reference standard meme at:', outputPath);
}

runVisualReferenceTest().catch(console.error);

