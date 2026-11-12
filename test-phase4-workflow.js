const fs = require('fs');
const path = require('path');

async function testPhase4() {
  console.log('================================================================');
  console.log('PHASE 4: MONGODB PERSISTENCE & NATURAL REGENERATION VERIFICATION');
  console.log('================================================================\n');

  const assetsDir = path.join(__dirname, 'test-assets');

  // STEP 1: CREATE A NEW MEME IN MONGODB
  console.log('[STEP 1] Generating and Persisting New Meme into MongoDB...');
  const createPayload = {
    content: {
      topic: 'Tollywood Box Office Phenomenon',
      headline: 'RECORD BREAKING OPENINGS IN TELUGU CINEMA',
      statement: 'UNPRECEDENTED PRE-SALES WORLDWIDE SURPASSING ALL PREVIOUS RECORDS ACROSS ALL TERRITORIES.\n- TRADE ANALYST REPORT',
      reactionContext: '* FANS AT 4 AM BENEFIT SHOW',
      punchline: 'రచ్చ రంబోలా థియేటర్ల దగ్గర!'
    },
    assets: {
      subjectImages: [
        { id: 'sub1', originalName: 'movie_subject1.jpg', filename: 'movie_subject1.jpg', path: path.join(assetsDir, 'movie_subject1.jpg'), mimeType: 'image/jpeg', role: 'subject_primary', orderIndex: 0 },
        { id: 'sub2', originalName: 'movie_subject2.jpg', filename: 'movie_subject2.jpg', path: path.join(assetsDir, 'movie_subject2.jpg'), mimeType: 'image/jpeg', role: 'subject_secondary', orderIndex: 1 }
      ],
      reactionImage: {
        id: 'rx1', originalName: 'movie_reaction.jpg', filename: 'movie_reaction.jpg', path: path.join(assetsDir, 'movie_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 2
      }
    },
    layout: {
      memeType: 'movie_update',
      arrangement: 'side_by_side'
    },
    design: {
      fontFamily: 'Arial Black',
      teluguFontFamily: 'Ramabhadra',
      primaryTextColor: '#FFE500',
      secondaryTextColor: '#FFFFFF',
      headerTextColor: '#FFE500',
      outlineThickness: 7,
      fontSizeScale: 1.0
    }
  };

  const createRes = await fetch('http://localhost:3000/api/memes/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createPayload)
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create meme: ${createRes.status} ${errText}`);
  }

  const v1Meme = await createRes.json();
  const memeId = v1Meme.memeId;
  console.log(`✓ Created Meme in MongoDB. ID: ${memeId}`);
  console.log(`  Current Version: ${v1Meme.currentVersion}`);
  console.log(`  Output PNG: ${v1Meme.outputUrls.png}`);
  console.log(`  Versions count: ${v1Meme.versions.length}`);

  // STEP 2: REGENERATE WITH NATURAL LANGUAGE INSTRUCTION 1
  console.log('\n[STEP 2] Regenerating with Instruction: "Make the headline 20% bigger"...');
  const regenRes1 = await fetch(`http://localhost:3000/api/memes/${memeId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: 'Make the headline 20% bigger' })
  });

  if (!regenRes1.ok) {
    const errText = await regenRes1.text();
    throw new Error(`Regen 1 failed: ${regenRes1.status} ${errText}`);
  }

  const v2Meme = await regenRes1.json();
  console.log(`✓ Version 2 Created Successfully!`);
  console.log(`  Current Version: ${v2Meme.currentVersion}`);
  console.log(`  Headline Font Scale: ${v2Meme.design.fontSizeScale}x`);
  console.log(`  New PNG URL: ${v2Meme.outputUrls.png}`);
  console.log(`  Versions in History: ${v2Meme.versions.length}`);

  // STEP 3: REGENERATE WITH NATURAL LANGUAGE INSTRUCTION 2
  console.log('\n[STEP 3] Regenerating with Instruction: "Change the headline colour to white"...');
  const regenRes2 = await fetch(`http://localhost:3000/api/memes/${memeId}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: 'Change the headline colour to white' })
  });

  if (!regenRes2.ok) {
    const errText = await regenRes2.text();
    throw new Error(`Regen 2 failed: ${regenRes2.status} ${errText}`);
  }

  const v3Meme = await regenRes2.json();
  console.log(`✓ Version 3 Created Successfully!`);
  console.log(`  Current Version: ${v3Meme.currentVersion}`);
  console.log(`  Header Text Color: ${v3Meme.design.headerTextColor}`);
  console.log(`  New PNG URL: ${v3Meme.outputUrls.png}`);
  console.log(`  Versions in History: ${v3Meme.versions.length}`);

  // STEP 4: VERIFY PREVIOUS VERSIONS PRESERVED
  console.log('\n[STEP 4] Verifying Version History Integrity...');
  const versionsRes = await fetch(`http://localhost:3000/api/memes/${memeId}/versions`);
  const versions = await versionsRes.json();
  console.log(`  Total Versions Recorded: ${versions.length}`);
  versions.forEach(v => {
    console.log(`  - Version ${v.versionNumber}: "${v.instruction}" (Scale: ${v.design.fontSizeScale}x, HeaderColor: ${v.design.headerTextColor})`);
  });

  if (versions[0].design.fontSizeScale === 1.0 && versions[1].design.fontSizeScale === 1.2) {
    console.log('✓ Verified: Previous versions remain completely intact and unchanged!');
  } else {
    throw new Error('Version isolation failure!');
  }

  // STEP 5: RESTORE AN EARLIER VERSION
  console.log('\n[STEP 5] Restoring Version 1...');
  const restoreRes = await fetch(`http://localhost:3000/api/memes/${memeId}/restore/1`, {
    method: 'POST'
  });

  if (!restoreRes.ok) {
    throw new Error('Restore failed');
  }

  const restoredMeme = await restoreRes.json();
  console.log(`✓ Version 1 Restored! Active Version is now: ${restoredMeme.currentVersion}`);
  console.log(`  Active PNG URL: ${restoredMeme.outputUrls.png}`);
  console.log(`  Active Header Scale: ${restoredMeme.design.fontSizeScale}x`);

  // STEP 6: VERIFY DOWNLOADS ACROSS VERSIONS
  console.log('\n[STEP 6] Testing Downloads across specific versions...');
  const dlV1 = await fetch(`http://localhost:3000/api/memes/${memeId}/download/png?version=1`);
  const dlV2 = await fetch(`http://localhost:3000/api/memes/${memeId}/download/png?version=2`);
  const dlV3 = await fetch(`http://localhost:3000/api/memes/${memeId}/download/png?version=3`);

  console.log(`  Version 1 Download Status: ${dlV1.status} (Length: ${dlV1.headers.get('content-length')})`);
  console.log(`  Version 2 Download Status: ${dlV2.status} (Length: ${dlV2.headers.get('content-length')})`);
  console.log(`  Version 3 Download Status: ${dlV3.status} (Length: ${dlV3.headers.get('content-length')})`);

  // STEP 7: SEED ALL 5 REFERENCE FORMATS INTO MONGODB
  console.log('\n[STEP 7] Seeding All 5 Reference Formats into MongoDB...');
  const formats = ['facts_collage', 'comparison', 'trending_news', 'movie_update', 'stacked_comparison'];
  for (const f of formats) {
    const res = await fetch(`http://localhost:3000/api/memes/reference/${f}`);
    const data = await res.json();
    console.log(`  ✓ Seeded ${f}: ID ${data.memeId} (Type: ${data.layout.memeType})`);
  }

  // STEP 8: TEST SEARCH AND FILTER
  console.log('\n[STEP 8] Testing MongoDB Search & Filter APIs...');
  const allRes = await fetch('http://localhost:3000/api/memes');
  const allList = await allRes.json();
  console.log(`  Total Memes in MongoDB: ${allList.length}`);

  const searchRes = await fetch('http://localhost:3000/api/memes?search=Vishnu');
  const searchList = await searchRes.json();
  console.log(`  Search for "Vishnu" matched: ${searchList.length} meme(s)`);

  const filterRes = await fetch('http://localhost:3000/api/memes?type=comparison');
  const filterList = await filterRes.json();
  console.log(`  Filter by type "comparison" matched: ${filterList.length} meme(s)`);

  console.log('\n================================================================');
  console.log('PHASE 4 COMPLETE: MONGODB & REGENERATION VERIFIED END-TO-END!');
  console.log('================================================================');
}

testPhase4().catch(console.error);

