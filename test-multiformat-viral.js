const fs = require('fs');
const path = require('path');

async function testFormat(name, refFileName, reactionFileName, punchline, reactionContext) {
  console.log(`\n======================================================`);
  console.log(`Testing Format: ${name}`);
  const refPath = path.join('D:/memes/portfolio/samples', refFileName);
  const rxPath = path.join(__dirname, 'test-assets', reactionFileName);

  console.log('  Ref Screenshot:', refPath);
  console.log('  Reaction Image:', rxPath);
  console.log('  Punchline:', punchline);

  const formData = new FormData();
  formData.append('referenceImage', new Blob([fs.readFileSync(refPath)], { type: 'image/jpeg' }), refFileName);
  formData.append('reactionImage', new Blob([fs.readFileSync(rxPath)], { type: 'image/jpeg' }), reactionFileName);
  formData.append('punchline', punchline);
  if (reactionContext) formData.append('reactionContext', reactionContext);

  const res = await fetch('http://localhost:3000/api/memes/adapt-viral', {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`  ❌ FAILED (${res.status}): ${errText}`);
    return { ok: false, error: errText };
  }

  const result = await res.json();
  console.log(`  ✓ SUCCESS: ${result.memeId}`);
  console.log(`    Detected Type: ${result.layout?.memeType} (${result.layout?.arrangement})`);
  console.log(`    Headline: ${result.content?.headline || result.content?.statement}`);
  console.log(`    Identified Subjects:`, result.adaptationMetadata?.identifiedSubjects);
  console.log(`    Matched Assets:`, result.adaptationMetadata?.matchedSubjectAssets?.map(a => a.originalName));
  console.log(`    Punchline Verified: "${result.content?.punchline}"`);

  const outPath = path.join(__dirname, 'output', `viral-${name}.png`);
  fs.copyFileSync(result.outputPaths.png, outPath);
  console.log(`    Saved output: ${outPath}`);
  return { ok: true, result };
}

async function testUnknownSubject() {
  console.log(`\n======================================================`);
  console.log(`Testing Unknown/Unmatchable Subject Graceful Fallback`);
  // Create a dummy image representing an unknown subject
  const dummyRefPath = path.join(__dirname, 'test-assets', 'unknown-ref.jpg');
  // Copy one image but pretend we're sending a random meme with an unmatchable prompt or unknown actor
  // Let's test with a subject that doesn't exist in DB
  const rxPath = path.join(__dirname, 'test-assets', 'stacked_reaction.jpg');

  // We can test subjectDiscovery directly or test endpoint
  const res = await fetch('http://localhost:3000/api/memes/adapt-viral', {
    method: 'POST',
    body: (() => {
      const fd = new FormData();
      // If we don't supply referenceImage
      fd.append('reactionImage', new Blob([fs.readFileSync(rxPath)]), 'rx.jpg');
      fd.append('punchline', 'test');
      return fd;
    })()
  });

  console.log(`  Missing Reference status: ${res.status} (Expected 400)`);
  const text = await res.text();
  console.log(`  Response message: ${text}`);
}

async function runAll() {
  // 1. Stacked comparison (Vijay vs NTR)
  await testFormat(
    'stacked-comparison',
    'WhatsApp Image 2026-11-12 at 9.23.52 PM (3).jpeg',
    'compare_reaction.jpg',
    'ఇది వేరే లెవెల్ క్రౌడ్ బ్రదర్!',
    '* ఫ్యాన్స్ రెస్పాన్స్'
  );

  // 2. Net worth comparison (Chief Ministers)
  await testFormat(
    'networth-comparison',
    'WhatsApp Image 2026-11-12 at 9.23.52 PM (2).jpeg',
    'movie_reaction.jpg',
    'లక్షల్లో ఉన్న వాళ్లే ఎక్కువ ఎంజాయ్ చేస్తారు బ్రదర్!',
    '* మిడిల్ క్లాస్ రియాక్షన్'
  );

  // 3. Unknown subject / Error handling check
  await testUnknownSubject();
}

runAll().catch(console.error);

