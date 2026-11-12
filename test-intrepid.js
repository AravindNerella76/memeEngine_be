const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const fontPath = path.join(__dirname, 'fonts', 'Intrepid-ExtraBold.ttf');
console.log('Registering font from:', fontPath);

const reg1 = GlobalFonts.registerFromPath(fontPath, 'Intrepid ExtraBold');
const reg2 = GlobalFonts.registerFromPath(fontPath, 'Intrepid');
console.log('Registered under Intrepid ExtraBold:', reg1);
console.log('Registered under Intrepid:', reg2);

// Test rendering
const c = createCanvas(1080, 500);
const ctx = c.getContext('2d');

ctx.fillStyle = '#111827';
ctx.fillRect(0, 0, 1080, 500);

// Use existing preferred meme text styling
ctx.font = 'bold 54px "Intrepid ExtraBold", sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.lineJoin = 'round';
ctx.miterLimit = 2;

// Shadow
ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
ctx.shadowBlur = 8;
ctx.shadowOffsetX = 3;
ctx.shadowOffsetY = 3;

// Black Outline
ctx.strokeStyle = '#000000';
ctx.lineWidth = 8;
ctx.strokeText('OG CENSOR REPORT - INTREPID EXTRABOLD', 540, 120);

// Yellow Fill
ctx.shadowColor = 'transparent';
ctx.fillStyle = '#FFE500';
ctx.fillText('OG CENSOR REPORT - INTREPID EXTRABOLD', 540, 120);

// Line 2 - White fill
ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
ctx.shadowBlur = 8;
ctx.shadowOffsetX = 3;
ctx.shadowOffsetY = 3;
ctx.strokeStyle = '#000000';
ctx.lineWidth = 8;
ctx.strokeText('DECENT 1ST HALF & MASSIVE INTERVAL', 540, 240);

ctx.shadowColor = 'transparent';
ctx.fillStyle = '#FFFFFF';
ctx.fillText('DECENT 1ST HALF & MASSIVE INTERVAL', 540, 240);

// Telugu combination with existing Telugu font
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'Ramabhadra-Regular.ttf'), 'Ramabhadra');
ctx.font = 'bold 46px "Ramabhadra", sans-serif';
ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
ctx.shadowBlur = 8;
ctx.shadowOffsetX = 3;
ctx.shadowOffsetY = 3;
ctx.strokeStyle = '#000000';
ctx.lineWidth = 8;
ctx.strokeText('చిన్న పాజిటివ్ టాక్ వచ్చినా 500 CR కొట్టే దాకా ఆగదు!', 540, 360);

ctx.shadowColor = 'transparent';
ctx.fillStyle = '#FFE500';
ctx.fillText('చిన్న పాజిటివ్ టాక్ వచ్చినా 500 CR కొట్టే దాకా ఆగదు!', 540, 360);

const outTest = path.join(__dirname, 'output', 'intrepid-font-test.png');
fs.writeFileSync(outTest, c.toBuffer('image/png'));
console.log('✓ Successfully rendered Intrepid font test to:', outTest);

