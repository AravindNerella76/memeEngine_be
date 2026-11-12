const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

async function generateBeforeAfter() {
  const assetsDir = path.join(__dirname, 'test-assets');
  const outputDir = path.join(__dirname, 'output');

  // Load the 3 strict assets
  const img34 = await loadImage(path.join(assetsDir, 'strict_3_4_portrait.jpg'));
  const img23 = await loadImage(path.join(assetsDir, 'strict_2_3_portrait.jpg'));
  const img169 = await loadImage(path.join(assetsDir, 'strict_16_9_reaction.jpg'));

  // Load the final rendered meme
  const finalMeme = await loadImage(path.join(outputDir, 'aspect-ratio-verification.png'));

  // Create a 2160 x 1350 comparison canvas (Left: Raw Source Assets, Right: Final Composed Meme)
  const compW = 2160;
  const compH = 1350;
  const canvas = createCanvas(compW, compH);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, compW, compH);

  // Divider line
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(1080, 0);
  ctx.lineTo(1080, compH);
  ctx.stroke();

  // LEFT SIDE: RAW SOURCE ASSETS (BEFORE)
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1080, 80);
  ctx.fillStyle = '#f59e0b';
  ctx.font = 'bold 38px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('BEFORE: RAW SOURCE ASSETS (ORIGINAL PROPORTIONS)', 540, 50);

  // Draw 3:4 asset (scaled down to fit half left)
  const p1W = 460;
  const p1H = Math.round(p1W / 0.75); // 613px
  ctx.drawImage(img34, 50, 110, p1W, p1H);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 3;
  ctx.strokeRect(50, 110, p1W, p1H);

  // Draw 2:3 asset
  const p2W = 460;
  const p2H = Math.round(p2W / 0.667); // 690px
  ctx.drawImage(img23, 560, 110, p2W, p2H);
  ctx.strokeStyle = '#34d399';
  ctx.lineWidth = 3;
  ctx.strokeRect(560, 110, p2W, p2H);

  // Draw 16:9 reaction asset below them
  const rxW = 970;
  const rxH = Math.round(rxW / (16 / 9)); // 545px
  const rxY = 1350 - rxH - 20;
  ctx.drawImage(img169, 55, rxY, rxW, rxH);
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 3;
  ctx.strokeRect(55, rxY, rxW, rxH);

  // Labels on left
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('Raw 3:4 Portrait (900x1200)', 280, 100);
  ctx.fillText('Raw 2:3 Portrait (800x1200)', 790, 100);
  ctx.fillText('Raw 16:9 Landscape Reaction (1920x1080)', 540, rxY - 10);

  // RIGHT SIDE: FINAL COMPOSED MEME (AFTER)
  ctx.drawImage(finalMeme, 1080, 0, 1080, 1350);

  // Save comparison image
  const outPath = path.join(outputDir, 'aspect-crop-comparison.png');
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log('✓ Created Before/After Cropping Comparison at:', outPath);
}

generateBeforeAfter().catch(console.error);

