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

function drawCoverImage(ctx, img, destX, destY, destW, destH) {
  const imgW = img.width;
  const imgH = img.height;
  const imgAspect = imgW / imgH;
  const destAspect = destW / destH;

  let sx, sy, sWidth, sHeight;
  if (imgAspect > destAspect) {
    sHeight = imgH;
    sWidth = imgH * destAspect;
    sx = (imgW - sWidth) / 2;
    sy = 0;
  } else {
    sWidth = imgW;
    sHeight = imgW / destAspect;
    sx = 0;
    sy = (imgH - sHeight) / 2;
  }
  ctx.drawImage(img, sx, sy, sWidth, sHeight, destX, destY, destW, destH);
}

function drawMemeText(ctx, text, x, y, options = {}) {
  const {
    fillColor = '#FFE500',
    strokeColor = '#000000',
    strokeWidth = 7,
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

  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = shadowBlur;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 3;

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;
  ctx.strokeText(text, x, y);

  ctx.shadowColor = 'transparent';
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);

  ctx.restore();
}

async function renderFactsCollageTest() {
  const width = 1080;
  const height = 1350;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  // 1. Header Banner
  const headerH = 110;
  ctx.fillRect(0, 0, width, headerH);
  ctx.font = 'bold 46px "Arial Black", "Anton", sans-serif';
  drawMemeText(ctx, '7 ALWAYS BEEN A SPECIAL NUMBER', width / 2, 40, { fillColor: '#FFE500', strokeWidth: 6 });
  drawMemeText(ctx, 'FOR LORD VISHNU', width / 2, 85, { fillColor: '#FFFFFF', strokeWidth: 6 });

  // Load sample image
  const samplePath = 'D:/memes/portfolio/samples/WhatsApp Image 2026-11-12 at 9.23.52 PM (1).jpeg';
  const img = await loadImage(samplePath);

  // 2. 2x2 Grid of 4 items
  const gridY = headerH;
  const gridH = 720;
  const colW = (width - 4) / 2;
  const rowH = (gridH - 4) / 2;

  const cells = [
    { x: 0, y: gridY, w: colW, h: rowH, label: '7 GATES OF VAIKUNTAM' },
    { x: colW + 4, y: gridY, w: colW, h: rowH, label: '7TH AVATAR OF LORD VISHNU' },
    { x: 0, y: gridY + rowH + 4, w: colW, h: rowH, label: '7 DAYS LIFTING GOVARDAN' },
    { x: colW + 4, y: gridY + rowH + 4, w: colW, h: rowH, label: '7 HILLS OF VENKATESWARA' }
  ];

  ctx.font = 'bold 34px "Arial Black", "Anton", sans-serif';
  for (const c of cells) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.x, c.y, c.w, c.h);
    ctx.clip();
    drawCoverImage(ctx, img, c.x, c.y, c.w, c.h);
    ctx.restore();

    // Overlay cell label
    drawMemeText(ctx, c.label, c.x + (c.w / 2), c.y + c.h - 35, {
      fillColor: '#FFFFFF',
      strokeWidth: 6
    });
  }

  // 3. Bottom Reaction Panel
  const reactionY = gridY + gridH;
  const reactionH = height - reactionY;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, reactionY, width, reactionH);
  ctx.clip();
  drawCoverImage(ctx, img, 0, reactionY - 200, width, reactionH + 200);
  ctx.restore();

  // Telugu Punchline in reaction panel
  ctx.font = 'bold 44px "Ramabhadra", "Noto Sans Telugu", sans-serif';
  drawMemeText(ctx, 'నంబర్ 7 తో ఇంకో స్పెషల్ ఉంది', width / 2, reactionY + reactionH - 95, {
    fillColor: '#FFE500',
    strokeWidth: 8
  });
  drawMemeText(ctx, 'అది ఏంటో కామెంట్ చేయండి!', width / 2, reactionY + reactionH - 40, {
    fillColor: '#FFFFFF',
    strokeWidth: 8
  });

  const outDir = path.join(__dirname, 'test-output');
  const outPath = path.join(outDir, 'phase1-facts-collage-test.png');
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log('Generated facts collage test at:', outPath);
}

renderFactsCollageTest().catch(console.error);

