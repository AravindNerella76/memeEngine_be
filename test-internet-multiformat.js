const fs = require('fs');
const path = require('path');

async function testFormat(name, refFileName, reactionFileName, punchline, reactionContext) {
  console.log(`\n======================================================`);
  console.log(`Testing Internet-Only Discovery: ${name}`);
  const refPath = path.join('D:/memes/portfolio/samples', refFileName);
  const rxPath = path.join(__dirname, 'test-assets', reactionFileName);

  const formData = new FormData();
  formData.append('referenceImage', new Blob([fs.readFileSync(refPath)], { type: 'image/jpeg' }), refFileName);
  formData.append('reactionImage', new Blob([fs.readFileSync(rxPath)], { type: 'image/jpeg' }), reactionFileName);
  formData.append('punchline', punchline);
  if (reactionContext) formData.append('reactionContext', reactionContext);

  const start = Date.now();
  const res = await fetch('http://localhost:3000/api/memes/adapt-viral', {
    method: 'POST',
    body: formData
  });
  const duration = ((Date.now() - start) / 1000).toFixed(2);

  if (!res.ok) {
    const errText = await res.text();
    console.error(`  ❌ FAILED (${res.status}): ${errText}`);
    return { ok: false, error: errText };
  }

  const result = await res.json();
  console.log(`  ✓ SUCCESS: ${result.memeId} (${duration}s)`);
  console.log(`    Detected Type: ${result.layout?.memeType} (${result.layout?.arrangement})`);
  console.log(`    Identified Subjects:`, result.adaptationMetadata?.identifiedSubjects);
  console.log(`    Discovery Source:`, result.adaptationMetadata?.discoverySource);
  console.log(`    Discovered Assets:`);
  result.assets?.subjectImages?.forEach((s, idx) => {
    console.log(`      [${idx}] ${s.originalName}`);
    console.log(`          URL: ${s.sourceUrl}`);
    console.log(`          License: ${s.license}`);
    console.log(`          Attribution: ${s.attribution}`);
    console.log(`          Disk Path: ${s.path}`);
  });
  console.log(`    Reaction Asset (Untouched): ${result.assets?.reactionImage?.originalName}`);
  console.log(`    Punchline Verified: "${result.content?.punchline}"`);

  const outPath = path.join(__dirname, 'output', `viral-internet-${name}.png`);
  fs.copyFileSync(result.outputPaths.png, outPath);
  console.log(`    Saved output: ${outPath}`);

  // Copy to client public
  const clientOut = path.join(__dirname, '..', 'client', 'public', 'output', `viral-internet-${name}.png`);
  fs.copyFileSync(result.outputPaths.png, clientOut);
  console.log(`    Copied to client public: ${clientOut}`);

  return { ok: true, result };
}

async function testUnmatchableSubjectFailure() {
  console.log(`\n======================================================`);
  console.log(`Testing Failure Handling: Unmatchable / Non-existent Subject`);
  
  // Directly test InternetSubjectDiscoveryService with an impossible subject
  // We can test this by calling the service in a quick check
  const { InternetSubjectDiscoveryService } = require('./dist/services/internet-subject-discovery.service');
  const service = new InternetSubjectDiscoveryService();

  try {
    await service.discoverSubjectImages(['Xyzkjqw987_NonExistentEntity_12345'], 1);
    console.error('  ❌ FAILED: Service did not throw an error for unmatchable subject!');
  } catch (err) {
    console.log('  ✓ SUCCESS: Service threw expected error for unmatchable subject:');
    console.log(`    "${err.message}"`);
  }
}

async function runAll() {
  // 1. Movie update (Pawan Kalyan OG)
  await testFormat(
    'movie-update',
    'WhatsApp Image 2026-11-12 at 9.23.53 PM.jpeg',
    'movie_reaction.jpg',
    'చిన్న పాజిటివ్ టాక్ వచ్చినా 500 CR కొట్టే దాకా ఆగదు!',
    '* థియేటర్ ఆడియన్స్ రెస్పాన్స్'
  );

  // 2. Unmatchable entity check
  await testUnmatchableSubjectFailure();
}

runAll().catch(console.error);

