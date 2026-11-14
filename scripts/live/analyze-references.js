/**
 * LIVE check (uses the real vision CLI and your Antigravity quota): analyses reference screenshots
 * with the production analyzer and prints the normalised per-slot analysis.
 *
 *   npm run build
 *   node scripts/live/analyze-references.js <image> [<image> ...]
 *   VISION_MODEL=gemini-3.8-flash-low node scripts/live/analyze-references.js <image>
 */
require('reflect-metadata');
require('../../dist/config/load-env');
const path = require('path');
const { Logger } = require('@nestjs/common');
const { VisionCliRunner } = require('../../dist/vision/vision-cli.runner');
const { ViralMemeAnalyzerService } = require('../../dist/services/viral-meme-analyzer.service');
const { getConfig } = require('../../dist/config/app-config');

Logger.overrideLogger(['error', 'warn', 'log']);

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/live/analyze-references.js <image> [...]');
    process.exit(2);
  }
  const cfg = getConfig();
  console.log(`vision CLI: ${cfg.vision.cliPath} | model: ${cfg.vision.analysisModel}`);
  const analyzer = new ViralMemeAnalyzerService(new VisionCliRunner());
  for (const f of files) {
    const started = Date.now();
    try {
      const run = await analyzer.analyzeReference(path.resolve(f));
      const a = run.analysis;
      console.log(`\n=== ${path.basename(f)} (${((Date.now() - started) / 1000).toFixed(1)}s, attempts=${run.calls.length}) ===`);
      console.log(`format=${a.memeFormat} legacy=${a.legacyMemeType} rows=${JSON.stringify(a.grid.columnsPerRow)} header=${JSON.stringify(a.header.text)} reaction=${a.reactionPanel.present}:${a.reactionPanel.heightFraction}`);
      if (a.overlayText.statement) console.log(`statement=${JSON.stringify(a.overlayText.statement)}`);
      if (a.overlayText.bulletPoints.length) console.log(`bullets=${JSON.stringify(a.overlayText.bulletPoints)}`);
      for (const s of a.slots) {
        console.log(`  [${s.slotId} r${s.row}c${s.column}] ${s.subjectKind} written=${JSON.stringify(s.nameAsWritten)} identified=${JSON.stringify(s.identifiedName)} (${s.identificationEvidence}, ${s.identityConfidence}) char=${JSON.stringify(s.characterName)}`);
        console.log(`       type=${s.imageType} orient=${s.orientation} movie=${JSON.stringify(s.context.movieTitle)} event=${JSON.stringify(s.context.eventName)} label=${JSON.stringify(s.label)} bbox=${JSON.stringify(s.bbox)}`);
        console.log(`       purpose=${JSON.stringify(s.visualPurpose)} visual=${JSON.stringify(s.visualCharacteristics)} search=${JSON.stringify(s.searchTerms)}`);
      }
      if (a.watermarks.length) console.log(`watermarks=${JSON.stringify(a.watermarks)}`);
      if (a.warnings.length) console.log(`warnings=${JSON.stringify(a.warnings)} injection=${a.suspectedPromptInjection}`);
      console.log(`legacy=${JSON.stringify(run.legacy)}`);
      console.log(`calls=${JSON.stringify(run.calls.map(c => ({ ok: c.ok, s: Math.round(c.durationMs / 1000), in: c.inputTokens, out: c.outputTokens, think: c.thinkingTokens, denied: c.deniedActions, err: c.error })))}`);
    } catch (e) {
      console.log(`\n=== ${path.basename(f)} FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${e.message}`);
      if (e.calls) console.log(JSON.stringify(e.calls));
    }
  }
})();
