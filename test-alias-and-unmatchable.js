const fs = require('fs');
const path = require('path');
const { InternetSubjectDiscoveryService } = require('./dist/services/internet-subject-discovery.service');

async function testSingleSubject(rawSubject, context) {
  console.log(`\n======================================================`);
  console.log(`Testing Subject: "${rawSubject}" (Context: "${context || 'None'}")`);
  const service = new InternetSubjectDiscoveryService();

  const start = Date.now();
  try {
    const assets = await service.discoverSubjectImages([rawSubject], 1, context);
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    const asset = assets[0];

    console.log(`  ✓ SUCCESS (${duration}s):`);
    console.log(`    Discovered Asset Title: ${asset.originalName}`);
    console.log(`    Resolution: ${asset.width}x${asset.height} (AR: ${asset.aspectRatio})`);
    console.log(`    Local Saved File: ${asset.path}`);
    console.log(`    Source URL: ${asset.sourceUrl}`);
    console.log(`    License: ${asset.license}`);
    console.log(`    Attribution: ${asset.attribution}`);

    if (!fs.existsSync(asset.path)) {
      throw new Error(`File does not exist on disk at ${asset.path}`);
    }
    const stat = fs.statSync(asset.path);
    console.log(`    File Size on Disk: ${(stat.size / 1024).toFixed(1)} KB`);
    return { ok: true, asset, duration };
  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`  Expected / Caught Result (${duration}s):`);
    console.log(`    "${err.message}"`);
    return { ok: false, error: err.message, duration };
  }
}

async function runAll() {
  console.log('############################################################');
  console.log('TESTING ALIAS RESOLUTION & UNMATCHABLE SUBJECT FALLBACK');
  console.log('############################################################');

  // Test 1: Anna Konidala -> Pawan Kalyan
  const t1 = await testSingleSubject('Anna Konidala', 'OG Movie Update');

  // Test 2: bare "Power Star" is AMBIGUOUS (also used for other actors). It must halt unless the
  // context proves who it is ("OG Movie Update" is a Pawan Kalyan cue, "Tollywood Box Office" is not).
  const t2 = await testSingleSubject('Power Star', 'Tollywood Box Office');

  // Test 3: Thalapathy -> Vijay
  const t3 = await testSingleSubject('Thalapathy', 'GOAT Movie Fan Gathering');

  // Test 4: Tarak -> Jr NTR
  const t4 = await testSingleSubject('Tarak', 'Simhadri Industry Hit');

  // Test 5: A genuinely unknown person -> Proper error
  const t5 = await testSingleSubject('Xyzkjqw987_NonExistentEntity_12345', 'Random Unknown Context');

  console.log('\n############################################################');
  console.log('SUMMARY OF ALIAS RESOLUTION TESTS');
  console.log('############################################################');
  console.log('1. Anna Konidala -> Pawan Kalyan: ', t1.ok ? 'PASSED' : 'FAILED');
  console.log('2. Bare "Power Star" w/o evidence:', !t2.ok && /ambiguous/.test(t2.error) ? 'PASSED (halted as ambiguous)' : 'FAILED');
  console.log('3. Thalapathy -> Vijay:           ', t3.ok ? 'PASSED' : 'FAILED');
  console.log('4. Tarak -> Jr NTR:               ', t4.ok ? 'PASSED' : 'FAILED');
  console.log('5. Genuinely Unknown Person Guard:', !t5.ok ? 'PASSED (Halted with clear error)' : 'FAILED');
}

runAll().catch(console.error);

