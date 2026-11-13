const fs = require('fs');
const path = require('path');

async function testAdaptViralEndpoint() {
  const referencePath = 'D:/memes/portfolio/samples/WhatsApp Image 2026-11-12 at 9.23.53 PM.jpeg';
  const reactionPath = path.join(__dirname, 'test-assets', 'stacked_reaction.jpg');

  console.log('Testing POST /api/memes/adapt-viral:');
  console.log('  1. Reference Screenshot:', referencePath);
  console.log('  2. Reaction Image:', reactionPath);
  console.log('  3. User Punchline: "ఇది నా సొంత పంచ్‌లైన్! ఏ మార్పు లేకుండా రావాలి!"');

  const formData = new FormData();
  
  const refBlob = new Blob([fs.readFileSync(referencePath)], { type: 'image/jpeg' });
  formData.append('referenceImage', refBlob, 'viral_reference.jpeg');

  const rxBlob = new Blob([fs.readFileSync(reactionPath)], { type: 'image/jpeg' });
  formData.append('reactionImage', rxBlob, 'my_reaction_scene.jpg');

  formData.append('punchline', 'ఇది నా సొంత పంచ్‌లైన్! ఏ మార్పు లేకుండా రావాలి!');
  formData.append('reactionContext', '* థియేటర్ ఆడియన్స్ రెస్పాన్స్');

  const res = await fetch('http://localhost:3000/api/memes/adapt-viral', {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Adaptation API failed (${res.status}): ${errText}`);
  }

  const result = await res.json();
  console.log('\n✓ Viral Meme Adaptation SUCCESSFUL!');
  console.log('  Meme ID:', result.memeId);
  console.log('  Meme Type:', result.layout?.memeType);
  console.log('  Arrangement:', result.layout?.arrangement);
  console.log('  Headline:', result.content?.headline);
  console.log('  Bullet Points:', result.content?.bulletPoints);
  console.log('  Punchline:', result.content?.punchline);
  console.log('  Subject Assets used:');
  result.assets?.subjectImages?.forEach((s, idx) => {
    console.log(`    [${idx}] ${s.originalName} (${s.path})`);
  });
  console.log('  Reaction Asset used:', result.assets?.reactionImage?.originalName);
  console.log('  PNG Output URL:', result.outputUrls?.png);

  // Copy to named file for inspection
  const outPath = path.join(__dirname, 'output', 'viral-adapted-test-result.png');
  fs.copyFileSync(result.outputPaths.png, outPath);
  console.log('  Saved visual output to:', outPath);

  // Also copy to client public
  const clientOutPath = path.join(__dirname, '..', 'client', 'public', 'output', 'viral-adapted-test-result.png');
  fs.copyFileSync(result.outputPaths.png, clientOutPath);
  console.log('  Copied to client public at:', clientOutPath);
}

testAdaptViralEndpoint().catch(console.error);

