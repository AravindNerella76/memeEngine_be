const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

// Register all fonts
const fontsDir = path.join(__dirname, 'fonts');
console.log('Registering fonts from:', fontsDir);

GlobalFonts.registerFromPath(path.join(fontsDir, 'Ramabhadra-Regular.ttf'), 'Ramabhadra');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Mandali-Regular.ttf'), 'Mandali');
GlobalFonts.registerFromPath(path.join(fontsDir, 'NotoSansTelugu-Bold.ttf'), 'Noto Sans Telugu');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Anton-Regular.ttf'), 'Anton');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Arial-Black.ttf'), 'Arial Black');
GlobalFonts.registerFromPath(path.join(fontsDir, 'Impact.ttf'), 'Impact');

console.log('Available font families:', GlobalFonts.families.map(f => f.family));

async function runTest() {
  const width = 1080;
  const height = 1350;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, width, height);

  // Header Banner
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, 120);

  // Header text (English bold)
  ctx.font = 'bold 52px "Arial Black", "Anton", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFE500'; // Yellow
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 6;
  ctx.strokeText('OG CENSOR REPORT', width / 2, 60);
  ctx.fillText('OG CENSOR REPORT', width / 2, 60);

  // Telugu Text rendering test with Ramabhadra
  ctx.font = 'bold 50px "Ramabhadra", "Noto Sans Telugu", sans-serif';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 8;
  ctx.fillStyle = '#FFE500';
  ctx.strokeText('ఎక్కేసారు అయ్యా ఒక మెట్టు ఎక్కేసారు', width / 2, 300);
  ctx.fillText('ఎక్కేసారు అయ్యా ఒక మెట్టు ఎక్కేసారు', width / 2, 300);

  // Telugu Text rendering test with Mandali
  ctx.font = '48px "Mandali", sans-serif';
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeText('నంబర్ 7 తో ఇంకో స్పెషల్ ఉంది అది ఏంటో చెప్పండి', width / 2, 450);
  ctx.fillText('నంబర్ 7 తో ఇంకో స్పెషల్ ఉంది అది ఏంటో చెప్పండి', width / 2, 450);

  // Mixed Transliteration + Telugu with Noto Sans Telugu
  ctx.font = 'bold 44px "Noto Sans Telugu", "Arial Black", sans-serif';
  ctx.fillStyle = '#FFE500';
  ctx.strokeText('CHINNA POSITIVE TALK VACHINA', width / 2, 600);
  ctx.fillText('CHINNA POSITIVE TALK VACHINA', width / 2, 600);

  ctx.fillStyle = '#FFFFFF';
  ctx.strokeText('500 CR కొట్టే దాకా ఆగదు', width / 2, 680);
  ctx.fillText('500 CR కొట్టే దాకా ఆగదు', width / 2, 680);

  // Load one sample image to test image compositing
  const sampleImagePath = 'D:/memes/portfolio/samples/WhatsApp Image 2026-11-12 at 9.23.53 PM.jpeg';
  if (fs.existsSync(sampleImagePath)) {
    const img = await loadImage(sampleImagePath);
    // Draw in a preview box
    const boxX = 140;
    const boxY = 780;
    const boxW = 800;
    const boxH = 450;

    ctx.drawImage(img, boxX, boxY, boxW, boxH);
    ctx.strokeStyle = '#FFE500';
    ctx.lineWidth = 4;
    ctx.strokeRect(boxX, boxY, boxW, boxH);
  }

  const outDir = path.join(__dirname, 'test-output');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outputPath = path.join(outDir, 'phase1-telugu-test.png');
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  console.log('Successfully generated test image at:', outputPath);
}

runTest().catch(console.error);

