const fs = require('fs');
const path = require('path');

async function testInternetViralWorkflow() {
  console.log('========================================================================');
  console.log('TESTING INTERNET-ONLY SUBJECT DISCOVERY VIRAL MEME ADAPTATION');
  console.log('========================================================================\n');

  // Test 1: Thalapathy Vijay & Jr NTR Reference
  const refPath1 = 'D:/memes/portfolio/samples/WhatsApp Image 2026-11-12 at 9.23.52 PM (3).jpeg';
  const rxPath = path.join(__dirname, 'test-assets', 'stacked_reaction.jpg');

  console.log('--- Test Case 1: Stacked Comparison (Internet Image Discovery) ---');
  console.log('  1. Reference Screenshot:', refPath1);
  console.log('  2. User Reaction Image:', rxPath);
  console.log('  3. User Punchline: "ఇది వేరే లెవెల్ క్రౌడ్ బ్రదర్! ఎవరూ మ్యాచ్ చేయలేరు!"');

  const formData1 = new FormData();
  formData1.append('referenceImage', new Blob([fs.readFileSync(refPath1)], { type: 'image/jpeg' }), 'viral_comparison_ref.jpeg');
  formData1.append('reactionImage', new Blob([fs.readFileSync(rxPath)], { type: 'image/jpeg' }), 'my_reaction_scene.jpg');
  formData1.append('punchline', 'ఇది వేరే లెవెల్ క్రౌడ్ బ్రదర్! ఎవరూ మ్యాచ్ చేయలేరు!');
  formData1.append('reactionContext', '* ఫ్యాన్స్ రెస్పాన్స్');

  const start1 = Date.now();
  const res1 = await fetch('http://localhost:3000/api/memes/adapt-viral', {
    method: 'POST',
    body: formData1
  });
  const duration1 = ((Date.now() - start1) / 1000).toFixed(2);

  if (!res1.ok) {
    const errText = await res1.text();
    throw new Error(`Test 1 Failed (${res1.status}): ${errText}`);
  }

  const result1 = await res1.json();
  console.log(`\n✓ Test 1 SUCCESS in ${duration1}s!`);
  console.log('  Meme ID:', result1.memeId);
  console.log('  Detected Type:', result1.layout?.memeType, `(${result1.layout?.arrangement})`);
  console.log('  Identified Subjects:', result1.adaptationMetadata?.identifiedSubjects);
  console.log('  Discovery Source:', result1.adaptationMetadata?.discoverySource);
  console.log('  Internet Discovered Subject Assets:');
  result1.assets?.subjectImages?.forEach((s, i) => {
    console.log(`    [Slot ${i + 1}] ${s.originalName}`);
    console.log(`        Local Path: ${s.path}`);
    console.log(`        Dimensions: ${s.width}x${s.height} (AR: ${s.aspectRatio})`);
    console.log(`        Internet Source URL: ${s.sourceUrl}`);
    console.log(`        License: ${s.license}`);
    console.log(`        Attribution: ${s.attribution}`);
    // Verify file is saved in internet-discovered folder
    if (!s.path.includes('internet-discovered')) {
      throw new Error(`VIOLATION: Asset ${s.path} was not stored in isolated internet-discovered directory!`);
    }
    if (!fs.existsSync(s.path)) {
      throw new Error(`Downloaded asset file missing at ${s.path}`);
    }
  });

  console.log('  User Reaction Image Preserved:', result1.assets?.reactionImage?.originalName);
  console.log('  User Punchline Preserved (Verbatim):', result1.content?.punchline);
  console.log('  Final Meme PNG:', result1.outputPaths?.png);

  // Copy to named inspection file
  const out1 = path.join(__dirname, 'output', 'viral-internet-discovered-test1.png');
  fs.copyFileSync(result1.outputPaths.png, out1);
  console.log('  Visual output saved to:', out1);

  // Copy to client public
  const clientOut1 = path.join(__dirname, '..', 'client', 'public', 'output', 'viral-internet-discovered-test1.png');
  fs.copyFileSync(result1.outputPaths.png, clientOut1);
  console.log('  Copied to client public at:', clientOut1);

  console.log('\n========================================================================');
  console.log('ALL TESTS COMPLETED SUCCESSFULLY!');
  console.log('========================================================================');
}

testInternetViralWorkflow().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message);
  process.exit(1);
});

