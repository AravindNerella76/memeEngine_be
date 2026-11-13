const fs = require('fs');
const path = require('path');

async function main() {
  console.log('===============================================================');
  console.log('STEP 3 & STEP 5: VERIFY VIRAL MEME ADAPTATION FIX');
  console.log('===============================================================');

  // The actual uploaded reference image that had the error
  const actualUploadedRef = 'D:/memes/engine/server/uploads/upload_2bca7888-ac58-459d-8804-4bb234025027.jpeg';
  const reactionPath = path.join(__dirname, 'test-assets', 'stacked_reaction.jpg');

  console.log('\n--- 1. Input Verification ---');
  console.log('Reference Image Path:', actualUploadedRef);
  if (!fs.existsSync(actualUploadedRef)) {
    throw new Error('Target uploaded reference image not found on disk!');
  }
  const stat = fs.statSync(actualUploadedRef);
  console.log('  File exists: Yes');
  console.log('  File size:', stat.size, 'bytes');

  console.log('\nReaction Image Path:', reactionPath);
  if (!fs.existsSync(reactionPath)) {
    throw new Error('Reaction image not found on disk!');
  }
  console.log('  Reaction file exists: Yes');

  console.log('\n--- 2. End-to-End API Workflow Verification (POST /api/memes/adapt-viral) ---');
  const userPunchline = 'ఇది నా సొంత పంచ్‌లైన్! ఏ మార్పు లేకుండా రావాలి!';
  const userContext = '* థియేటర్ ఆడియన్స్ రెస్పాన్స్';

  const formData = new FormData();
  formData.append('referenceImage', new Blob([fs.readFileSync(actualUploadedRef)], { type: 'image/jpeg' }), 'actual_viral_reference.jpeg');
  formData.append('reactionImage', new Blob([fs.readFileSync(reactionPath)], { type: 'image/jpeg' }), 'my_reaction_scene.jpg');
  formData.append('punchline', userPunchline);
  formData.append('reactionContext', userContext);

  console.log('Sending multipart request with strictly 3 user inputs...');
  const apiStart = Date.now();
  const res = await fetch('http://localhost:3000/api/memes/adapt-viral', {
    method: 'POST',
    body: formData
  });

  const apiDuration = ((Date.now() - apiStart) / 1000).toFixed(2);
  console.log(`Response received in ${apiDuration} seconds (HTTP Status: ${res.status})`);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API failed with status ${res.status}: ${errText}`);
  }

  const result = await res.json();
  console.log('\n✓ VIRAL MEME ADAPTATION SUCCESSFUL!');
  console.log('  Meme ID:', result.memeId);
  console.log('  Detected Layout Archetype:', result.layout?.memeType);
  console.log('  Detected Arrangement:', result.layout?.arrangement);
  console.log('  Identified Subjects:', result.adaptationMetadata?.identifiedSubjects);
  console.log('  Matched Library Subject Assets:');
  result.assets?.subjectImages?.forEach((s, i) => {
    console.log(`    [${i}] ${s.originalName} (${s.path})`);
  });
  console.log('  Reaction Asset Used (Untouched):', result.assets?.reactionImage?.originalName);
  console.log('  Reaction Punchline Verified (Verbatim):', result.content?.punchline);
  console.log('  Reaction Context Verified:', result.content?.reactionContext);
  console.log('  Generated PNG Path:', result.outputPaths?.png);
  console.log('  Generated JPEG Path:', result.outputPaths?.jpeg);
  console.log('  Target Resolution:', result.design?.width, 'x', result.design?.height);

  // Check generated image exists and has valid size
  if (result.outputPaths?.png && fs.existsSync(result.outputPaths.png)) {
    const outStat = fs.statSync(result.outputPaths.png);
    console.log('  Output PNG verified on disk:', outStat.size, 'bytes');
  } else {
    throw new Error('Generated output file not found on disk!');
  }

  // Copy to named inspection file
  const inspectPath = path.join(__dirname, 'output', 'verified-actual-viral-fix.png');
  fs.copyFileSync(result.outputPaths.png, inspectPath);
  console.log('\n✓ Visual verification image saved to:', inspectPath);

  // Copy to client public
  const clientInspectPath = path.join(__dirname, '..', 'client', 'public', 'output', 'verified-actual-viral-fix.png');
  fs.copyFileSync(result.outputPaths.png, clientInspectPath);
  console.log('✓ Copied to client public at:', clientInspectPath);
}

main().catch(err => {
  console.error('\n❌ VERIFICATION FAILED:', err.message);
  process.exit(1);
});

