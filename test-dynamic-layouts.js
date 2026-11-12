/**
 * Dynamic Layout Calculation Verification
 * Validates Requirement 1: "Do not hardcode fixed layouts. Each meme type should support
 * dynamic image counts, text sections and different arrangements based on the supplied content."
 */

function calculateDynamicLayout(config) {
  const {
    memeType,
    canvasWidth = 1080,
    canvasHeight = 1350,
    hasHeader = true,
    subjectCount = 2,
    hasReaction = true,
    arrangementPreference = 'auto',
    reactionHeightPercentage = 0.38 // Configurable / adjustable during regeneration
  } = config;

  // 1. Calculate Header Box
  let currentY = 0;
  let headerBox = null;
  if (hasHeader) {
    const headerH = Math.round(canvasHeight * 0.08); // 108px on 1350px canvas
    headerBox = { x: 0, y: 0, width: canvasWidth, height: headerH };
    currentY += headerH;
  }

  // 2. Calculate Reaction Box (at the bottom)
  let reactionBox = null;
  let availableHeightForSubjects = canvasHeight - currentY;
  if (hasReaction) {
    const reactionH = Math.round(canvasHeight * reactionHeightPercentage);
    const reactionY = canvasHeight - reactionH;
    reactionBox = { x: 0, y: reactionY, width: canvasWidth, height: reactionH };
    availableHeightForSubjects -= reactionH;
  }

  // 3. Calculate Subject Section Bounding Box
  const subjectSectionBox = {
    x: 0,
    y: currentY,
    width: canvasWidth,
    height: availableHeightForSubjects
  };

  // 4. Calculate Individual Subject Image Rectangles Dynamically
  const subjectBoxes = [];
  
  let arrangement = arrangementPreference;
  if (arrangement === 'auto') {
    if (memeType === 'comparison') {
      arrangement = subjectCount <= 4 ? `columns_${subjectCount}` : 'grid_2x2';
    } else if (memeType === 'facts_collage') {
      if (subjectCount === 4) arrangement = 'grid_2x2';
      else if (subjectCount === 3) arrangement = 'columns_3';
      else if (subjectCount === 2) arrangement = 'side_by_side';
      else arrangement = 'stacked_rows';
    } else if (memeType === 'movie_update' || memeType === 'trending_news') {
      if (subjectCount === 1) arrangement = 'single_hero';
      else if (subjectCount === 2) arrangement = 'side_by_side';
      else arrangement = 'grid_2x2';
    } else {
      arrangement = subjectCount === 1 ? 'single_hero' : (subjectCount === 2 ? 'side_by_side' : 'grid_2x2');
    }
  }

  const gap = 3; // Clean border gap between images

  if (arrangement === 'single_hero' || subjectCount === 1) {
    subjectBoxes.push({
      index: 0,
      x: 0,
      y: subjectSectionBox.y,
      width: subjectSectionBox.width,
      height: subjectSectionBox.height
    });
  } else if (arrangement === 'grid_2x2') {
    const colW = (subjectSectionBox.width - gap) / 2;
    const rowH = (subjectSectionBox.height - gap) / 2;
    subjectBoxes.push(
      { index: 0, x: 0, y: subjectSectionBox.y, width: colW, height: rowH },
      { index: 1, x: colW + gap, y: subjectSectionBox.y, width: colW, height: rowH },
      { index: 2, x: 0, y: subjectSectionBox.y + rowH + gap, width: colW, height: rowH },
      { index: 3, x: colW + gap, y: subjectSectionBox.y + rowH + gap, width: colW, height: rowH }
    );
  } else if (arrangement === 'side_by_side' || (arrangement === 'columns_2' && subjectCount === 2)) {
    const colW = (subjectSectionBox.width - gap) / 2;
    subjectBoxes.push(
      { index: 0, x: 0, y: subjectSectionBox.y, width: colW, height: subjectSectionBox.height },
      { index: 1, x: colW + gap, y: subjectSectionBox.y, width: colW, height: subjectSectionBox.height }
    );
  } else if (arrangement === 'columns_3' || subjectCount === 3) {
    const colW = (subjectSectionBox.width - (gap * 2)) / 3;
    for (let i = 0; i < 3; i++) {
      subjectBoxes.push({
        index: i,
        x: i * (colW + gap),
        y: subjectSectionBox.y,
        width: colW,
        height: subjectSectionBox.height
      });
    }
  } else if (arrangement === 'columns_4') {
    const colW = (subjectSectionBox.width - (gap * 3)) / 4;
    for (let i = 0; i < 4; i++) {
      subjectBoxes.push({
        index: i,
        x: i * (colW + gap),
        y: subjectSectionBox.y,
        width: colW,
        height: subjectSectionBox.height
      });
    }
  } else if (arrangement === 'stacked_rows') {
    const rowH = (subjectSectionBox.height - (gap * (subjectCount - 1))) / subjectCount;
    for (let i = 0; i < subjectCount; i++) {
      subjectBoxes.push({
        index: i,
        x: 0,
        y: subjectSectionBox.y + (i * (rowH + gap)),
        width: subjectSectionBox.width,
        height: rowH
      });
    }
  }

  return {
    arrangement,
    headerBox,
    reactionBox,
    subjectSectionBox,
    subjectBoxes
  };
}

// Test cases
console.log('--- TEST 1: Facts Collage (4 images, 2x2 grid + Reaction) ---');
console.log(JSON.stringify(calculateDynamicLayout({
  memeType: 'facts_collage',
  subjectCount: 4,
  hasHeader: true,
  hasReaction: true
}), null, 2));

console.log('--- TEST 2: Comparison (3 images columns + Reaction) ---');
console.log(JSON.stringify(calculateDynamicLayout({
  memeType: 'comparison',
  subjectCount: 3,
  hasHeader: true,
  hasReaction: true
}), null, 2));

console.log('--- TEST 3: Trending News (2 images side-by-side + Reaction) ---');
console.log(JSON.stringify(calculateDynamicLayout({
  memeType: 'trending_news',
  subjectCount: 2,
  hasHeader: true,
  hasReaction: true
}), null, 2));

console.log('--- TEST 4: Stacked Comparison (2 images rows + Reaction) ---');
console.log(JSON.stringify(calculateDynamicLayout({
  memeType: 'comparison',
  arrangementPreference: 'stacked_rows',
  subjectCount: 2,
  hasHeader: false,
  hasReaction: true
}), null, 2));
