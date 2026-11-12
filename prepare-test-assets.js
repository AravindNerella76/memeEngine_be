const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

async function extractAssets() {
  const assetsDir = path.join(__dirname, 'test-assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  const samplesDir = 'D:/memes/portfolio/samples';

  // 1. Facts Collage (WhatsApp Image 2026-11-12 at 9.23.52 PM (1).jpeg, 652x816)
  const factsImg = await loadImage(path.join(samplesDir, 'WhatsApp Image 2026-11-12 at 9.23.52 PM (1).jpeg'));
  // Top banner is ~60px
  // Grid is 652 x 450, 4 cells:
  // cell 1: 0, 70, 326, 225
  // cell 2: 326, 70, 326, 225
  // cell 3: 0, 295, 326, 225
  // cell 4: 326, 295, 326, 225
  // reaction: 0, 520, 652, 296
  function cropSave(img, x, y, w, h, destName) {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    fs.writeFileSync(path.join(assetsDir, destName), c.toBuffer('image/jpeg'));
  }

  cropSave(factsImg, 0, 70, 326, 225, 'facts_item1.jpg');
  cropSave(factsImg, 326, 70, 326, 225, 'facts_item2.jpg');
  cropSave(factsImg, 0, 295, 326, 225, 'facts_item3.jpg');
  cropSave(factsImg, 326, 295, 326, 225, 'facts_item4.jpg');
  cropSave(factsImg, 0, 520, 652, 296, 'facts_reaction.jpg');

  // 2. Comparison Columns (WhatsApp Image 2026-11-12 at 9.23.52 PM (2).jpeg, 653x816)
  const compareImg = await loadImage(path.join(samplesDir, 'WhatsApp Image 2026-11-12 at 9.23.52 PM (2).jpeg'));
  // 3 cols: x: 0, 218, 436. y: 95, h: 400
  cropSave(compareImg, 0, 95, 218, 400, 'compare_col1.jpg');
  cropSave(compareImg, 218, 95, 218, 400, 'compare_col2.jpg');
  cropSave(compareImg, 436, 95, 217, 400, 'compare_col3.jpg');
  cropSave(compareImg, 0, 495, 653, 321, 'compare_reaction.jpg');

  // 3. Stacked Rows (WhatsApp Image 2026-11-12 at 9.23.52 PM (3).jpeg, 652x816)
  const stackedImg = await loadImage(path.join(samplesDir, 'WhatsApp Image 2026-11-12 at 9.23.52 PM (3).jpeg'));
  // row 1: 0, 0, 652, 270
  // row 2: 0, 275, 652, 265
  // reaction: 0, 545, 652, 271
  cropSave(stackedImg, 0, 0, 652, 270, 'stacked_row1.jpg');
  cropSave(stackedImg, 0, 275, 652, 265, 'stacked_row2.jpg');
  cropSave(stackedImg, 0, 545, 652, 271, 'stacked_reaction.jpg');

  // 4. Trending News (WhatsApp Image 2026-11-12 at 9.23.52 PM.jpeg, 720x900)
  const newsImg = await loadImage(path.join(samplesDir, 'WhatsApp Image 2026-11-12 at 9.23.52 PM.jpeg'));
  // side-by-side subjects: 0, 0, 360, 530 and 360, 0, 360, 530
  // reaction: 0, 530, 720, 370
  cropSave(newsImg, 0, 0, 360, 530, 'news_subject1.jpg');
  cropSave(newsImg, 360, 0, 360, 530, 'news_subject2.jpg');
  cropSave(newsImg, 0, 530, 720, 370, 'news_reaction.jpg');

  // 5. Movie Update (WhatsApp Image 2026-11-12 at 9.23.53 PM.jpeg, 652x816)
  const movieImg = await loadImage(path.join(samplesDir, 'WhatsApp Image 2026-11-12 at 9.23.53 PM.jpeg'));
  cropSave(movieImg, 0, 45, 326, 470, 'movie_subject1.jpg');
  cropSave(movieImg, 326, 45, 326, 470, 'movie_subject2.jpg');
  cropSave(movieImg, 0, 515, 652, 301, 'movie_reaction.jpg');

  console.log('Successfully extracted pure individual image assets to:', assetsDir);
}

extractAssets().catch(console.error);

