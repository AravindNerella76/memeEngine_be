const { execFile } = require('child_process');
const path = require('path');

const agyPath = 'C:\\Users\\hp\\.gemini\\bin\\agy.exe';
const testImagePath = 'D:/memes/portfolio/samples/WhatsApp Image 2026-11-12 at 9.23.53 PM.jpeg';

const prompt = `Analyze this viral meme reference screenshot at: ${testImagePath}
Identify the visual layout and subjects for meme recreation.
Output strictly a JSON object with:
- memeType: string ("movie_update", "facts_collage", "comparison", "trending_news", or "custom")
- arrangement: string ("side_by_side", "columns_3", "grid_2x2", "stacked_rows", or "single_hero")
- subjectCount: number
- subjects: array of strings naming each subject/entity (e.g. ["Pawan Kalyan", "Pawan Kalyan"])
- headline: string or null (top banner headline)
- bulletPoints: array of strings (review or statement bullet points overlaid, if any)
- statement: string or null
- itemLabels: array of strings (per-item labels, if any)
- hasBottomReactionInReference: boolean

Respond ONLY with valid JSON. No markdown code blocks, no explanation.`;

console.log('Testing agy CLI image analysis via execFile...');
const startTime = Date.now();

execFile(agyPath, ['--dangerously-skip-permissions', '--print', prompt], { timeout: 60000 }, (error, stdout, stderr) => {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  if (error) {
    console.error(`Error after ${duration}s:`, error.message);
    if (stderr) console.error('stderr:', stderr);
    return;
  }

  console.log(`✓ Received output in ${duration}s:`);
  console.log('Raw output:', stdout);

  // Test JSON extraction
  try {
    let cleanJson = stdout.trim();
    if (cleanJson.startsWith('```json')) cleanJson = cleanJson.replace(/```json\s*/i, '');
    if (cleanJson.startsWith('```')) cleanJson = cleanJson.replace(/```\s*/i, '');
    if (cleanJson.endsWith('```')) cleanJson = cleanJson.replace(/```\s*$/i, '');
    cleanJson = cleanJson.trim();

    const parsed = JSON.parse(cleanJson);
    console.log('✓ Successfully parsed structured JSON:');
    console.log(JSON.stringify(parsed, null, 2));
  } catch (parseErr) {
    console.error('Failed to parse JSON:', parseErr.message);
  }
});

