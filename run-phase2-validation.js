const { LayoutEngineService } = require('./dist/services/layout-engine.service');
const { CanvasRendererService } = require('./dist/services/canvas-renderer.service');
const { MemeEngineService } = require('./dist/services/meme-engine.service');
const path = require('path');
const fs = require('fs');

async function run() {
  const layoutEngine = new LayoutEngineService();
  const canvasRenderer = new CanvasRendererService();
  canvasRenderer.onModuleInit();
  const memeEngine = new MemeEngineService(layoutEngine, canvasRenderer);

  const assetsDir = path.join(__dirname, 'test-assets');
  const outputDir = path.join(__dirname, 'output');

  console.log('====================================================');
  console.log('RUNNING PHASE 2 END-TO-END VALIDATION ACROSS 5 TYPES');
  console.log('====================================================\n');

  // FORMAT 1: FACTS / INFORMATION COLLAGE
  console.log('[1/5] Generating Format 1: Facts / Information Collage...');
  const factsMeme = await memeEngine.generateMeme({
    content: {
      topic: 'Lord Vishnu Special Number 7 Facts',
      headline: '7 ALWAYS BEEN A SPECIAL NUMBER FOR LORD VISHNU',
      punchline: 'నంబర్ 7 తో ఇంకో స్పెషల్ ఉంది అది ఏంటో కామెంట్ చేయండి!',
      itemLabels: [
        '7 GATES OF VAIKUNTAM',
        '7TH AVATAR OF LORD VISHNU',
        '7 DAYS LIFTING GOVARDAN',
        '7 HILLS OF VENKATESWARA SWAMY'
      ]
    },
    assets: {
      subjectImages: [
        { id: '1', originalName: 'facts_item1.jpg', filename: 'facts_item1.jpg', path: path.join(assetsDir, 'facts_item1.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 0, label: '7 GATES OF VAIKUNTAM' },
        { id: '2', originalName: 'facts_item2.jpg', filename: 'facts_item2.jpg', path: path.join(assetsDir, 'facts_item2.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 1, label: '7TH AVATAR OF LORD VISHNU' },
        { id: '3', originalName: 'facts_item3.jpg', filename: 'facts_item3.jpg', path: path.join(assetsDir, 'facts_item3.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 2, label: '7 DAYS LIFTING GOVARDAN' },
        { id: '4', originalName: 'facts_item4.jpg', filename: 'facts_item4.jpg', path: path.join(assetsDir, 'facts_item4.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 3, label: '7 HILLS OF VENKATESWARA SWAMY' },
      ],
      reactionImage: {
        id: 'rx', originalName: 'facts_reaction.jpg', filename: 'facts_reaction.jpg', path: path.join(assetsDir, 'facts_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 4
      }
    },
    layout: {
      memeType: 'facts_collage',
      arrangement: 'grid_2x2'
    },
    design: {
      fontFamily: 'Arial Black',
      teluguFontFamily: 'Ramabhadra',
      primaryTextColor: '#FFE500',
      secondaryTextColor: '#FFFFFF',
      outlineThickness: 7
    }
  });

  // Copy to named file for easy inspection
  fs.copyFileSync(factsMeme.outputPaths.png, path.join(outputDir, 'phase2-facts-collage.png'));
  console.log('✓ Format 1 completed:', path.join(outputDir, 'phase2-facts-collage.png'));

  // FORMAT 2: COMPARISON (COLUMNS)
  console.log('\n[2/5] Generating Format 2: Comparison (3 Columns)...');
  const compareMeme = await memeEngine.generateMeme({
    content: {
      topic: 'Net Worth of Chief Ministers of India',
      headline: 'NET WORTH OF CHIEF MINISTERS OF INDIA',
      punchline: 'మీ అంత పూరెస్ట్ చీఫ్ మినిస్టర్ ని చూడలేదు మేడం!',
      itemLabels: [
        '931 CRORES\n1ST PLACE',
        '30 CRORES\n7TH PLACE',
        '15 LAKHS\nLAST PLACE'
      ]
    },
    assets: {
      subjectImages: [
        { id: 'c1', originalName: 'compare_col1.jpg', filename: 'compare_col1.jpg', path: path.join(assetsDir, 'compare_col1.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 0, label: '931 CRORES\n1ST PLACE' },
        { id: 'c2', originalName: 'compare_col2.jpg', filename: 'compare_col2.jpg', path: path.join(assetsDir, 'compare_col2.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 1, label: '30 CRORES\n7TH PLACE' },
        { id: 'c3', originalName: 'compare_col3.jpg', filename: 'compare_col3.jpg', path: path.join(assetsDir, 'compare_col3.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 2, label: '15 LAKHS\nLAST PLACE' }
      ],
      reactionImage: {
        id: 'crx', originalName: 'compare_reaction.jpg', filename: 'compare_reaction.jpg', path: path.join(assetsDir, 'compare_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 3
      }
    },
    layout: {
      memeType: 'comparison',
      arrangement: 'columns_3'
    },
    design: {
      fontFamily: 'Arial Black',
      teluguFontFamily: 'Ramabhadra',
      primaryTextColor: '#FFE500',
      secondaryTextColor: '#FFFFFF',
      outlineThickness: 7
    }
  });
  fs.copyFileSync(compareMeme.outputPaths.png, path.join(outputDir, 'phase2-comparison-columns.png'));
  console.log('✓ Format 2 completed:', path.join(outputDir, 'phase2-comparison-columns.png'));

  // FORMAT 3: TRENDING NEWS MEME
  console.log('\n[3/5] Generating Format 3: Trending News Meme...');
  const newsMeme = await memeEngine.generateMeme({
    content: {
      topic: 'Producer Anil Sunkara Statement',
      statement: 'CHIRANJEEVI GAVE UP REMUNERATION FOR BHOLA SHANKAR AND AKHIL FOR AGENT, BOTH HELPED ME DURING HEAVY LOSSES AND SUPPORTED EVEN AFTER THE RELEASE.\n- PRODUCER ANIL SUNKARA',
      reactionContext: '* BOSS AND AKHIL',
      punchline: 'ఎక్కేసారు అయ్యా ఒక మెట్టు ఎక్కేసారు'
    },
    assets: {
      subjectImages: [
        { id: 'n1', originalName: 'news_subject1.jpg', filename: 'news_subject1.jpg', path: path.join(assetsDir, 'news_subject1.jpg'), mimeType: 'image/jpeg', role: 'subject_primary', orderIndex: 0 },
        { id: 'n2', originalName: 'news_subject2.jpg', filename: 'news_subject2.jpg', path: path.join(assetsDir, 'news_subject2.jpg'), mimeType: 'image/jpeg', role: 'subject_secondary', orderIndex: 1 }
      ],
      reactionImage: {
        id: 'nrx', originalName: 'news_reaction.jpg', filename: 'news_reaction.jpg', path: path.join(assetsDir, 'news_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 2
      }
    },
    layout: {
      memeType: 'trending_news',
      arrangement: 'side_by_side'
    },
    design: {
      fontFamily: 'Arial Black',
      teluguFontFamily: 'Ramabhadra',
      primaryTextColor: '#FFE500',
      secondaryTextColor: '#FFFFFF',
      outlineThickness: 8
    }
  });
  fs.copyFileSync(newsMeme.outputPaths.png, path.join(outputDir, 'phase2-trending-news.png'));
  console.log('✓ Format 3 completed:', path.join(outputDir, 'phase2-trending-news.png'));

  // FORMAT 4: MOVIE / CELEBRITY UPDATE
  console.log('\n[4/5] Generating Format 4: Movie / Celebrity Update...');
  const movieMeme = await memeEngine.generateMeme({
    content: {
      topic: 'OG Censor Report',
      headline: 'OG CENSOR REPORT',
      bulletPoints: [
        'DECENT 1ST HALF',
        'MASSIVE INTERVAL SEQUENCE',
        'TERRIFIC 2ND HALF',
        '3 MAJOR SEQUENCES'
      ],
      reactionContext: '* THEATRE LO AUDIENCE RESPONSE',
      punchline: 'చిన్న పాజిటివ్ టాక్ వచ్చినా 500 CR కొట్టే దాకా ఆగదు!'
    },
    assets: {
      subjectImages: [
        { id: 'm1', originalName: 'movie_subject1.jpg', filename: 'movie_subject1.jpg', path: path.join(assetsDir, 'movie_subject1.jpg'), mimeType: 'image/jpeg', role: 'subject_primary', orderIndex: 0 },
        { id: 'm2', originalName: 'movie_subject2.jpg', filename: 'movie_subject2.jpg', path: path.join(assetsDir, 'movie_subject2.jpg'), mimeType: 'image/jpeg', role: 'subject_secondary', orderIndex: 1 }
      ],
      reactionImage: {
        id: 'mrx', originalName: 'movie_reaction.jpg', filename: 'movie_reaction.jpg', path: path.join(assetsDir, 'movie_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 2
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
      outlineThickness: 7
    }
  });
  fs.copyFileSync(movieMeme.outputPaths.png, path.join(outputDir, 'phase2-movie-update.png'));
  console.log('✓ Format 4 completed:', path.join(outputDir, 'phase2-movie-update.png'));

  // FORMAT 5: STACKED COMPARISON / CUSTOM MEME
  console.log('\n[5/5] Generating Format 5: Stacked Rows Comparison / Custom Meme...');
  const stackedMeme = await memeEngine.generateMeme({
    content: {
      topic: 'Thalapathy vs NTR Crowd Comparison',
      punchline: 'మీరు ఒప్పుకున్నా ఒప్పుకోకపోయినా 19 ఇయర్స్ కే ఈ రేంజ్ ఫ్యాన్స్ ఇండియా లో ఏ హీరో కి లేరు',
      itemLabels: [
        'THALAPATHY AT THE AGE 50\n(7 LAKH PEOPLE)',
        'NTR AT AGE OF 19\n(10 LAKH PEOPLE)'
      ]
    },
    assets: {
      subjectImages: [
        { id: 's1', originalName: 'stacked_row1.jpg', filename: 'stacked_row1.jpg', path: path.join(assetsDir, 'stacked_row1.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 0, label: 'THALAPATHY AT THE AGE 50\n(7 LAKH PEOPLE)' },
        { id: 's2', originalName: 'stacked_row2.jpg', filename: 'stacked_row2.jpg', path: path.join(assetsDir, 'stacked_row2.jpg'), mimeType: 'image/jpeg', role: 'subject_item', orderIndex: 1, label: 'NTR AT AGE OF 19\n(10 LAKH PEOPLE)' }
      ],
      reactionImage: {
        id: 'srx', originalName: 'stacked_reaction.jpg', filename: 'stacked_reaction.jpg', path: path.join(assetsDir, 'stacked_reaction.jpg'), mimeType: 'image/jpeg', role: 'reaction_punchline', orderIndex: 2
      }
    },
    layout: {
      memeType: 'comparison',
      arrangement: 'stacked_rows'
    },
    design: {
      fontFamily: 'Arial Black',
      teluguFontFamily: 'Ramabhadra',
      primaryTextColor: '#FFE500',
      secondaryTextColor: '#FFFFFF',
      outlineThickness: 7
    }
  });
  fs.copyFileSync(stackedMeme.outputPaths.png, path.join(outputDir, 'phase2-stacked-comparison.png'));
  console.log('✓ Format 5 completed:', path.join(outputDir, 'phase2-stacked-comparison.png'));

  console.log('\n====================================================');
  console.log('ALL 5 FORMATS GENERATED SUCCESSFULLY!');
  console.log('====================================================');
}

run().catch(console.error);

