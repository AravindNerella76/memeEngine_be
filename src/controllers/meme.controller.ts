import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  Delete,
  BadRequestException,
  NotFoundException,
  UseInterceptors,
  UploadedFiles,
  Res
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { MemeEngineService } from '../services/meme-engine.service';
import { GenerateMemeDto } from '../dto/generate-meme.dto';
import { UploadedAsset } from '../types/meme.types';

interface MulterUploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer?: Buffer;
}

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const multerStorage = diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = extname(file.originalname);
    cb(null, `upload_${randomUUID()}${ext}`);
  }
});

@Controller('api/memes')
export class MemeController {
  constructor(private readonly memeEngine: MemeEngineService) {}

  /**
   * List all memes with optional search, category filter and sorting
   */
  @Get()
  async getMemes(
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('sort') sort?: 'newest' | 'oldest'
  ) {
    return this.memeEngine.getAllMemes({ search, type, sort });
  }

  /**
   * Get single meme by ID
   */
  @Get(':id')
  async getMemeById(@Param('id') id: string) {
    return this.memeEngine.getMemeById(id);
  }

  /**
   * Get version history of a meme
   */
  @Get(':id/versions')
  async getMemeVersions(@Param('id') id: string) {
    const meme = await this.memeEngine.getMemeById(id);
    return meme.versions || [];
  }

  /**
   * Natural Language Instruction-Based Regeneration
   */
  @Post(':id/regenerate')
  async regenerateMeme(
    @Param('id') id: string,
    @Body('instruction') instruction: string
  ) {
    if (!instruction || !instruction.trim()) {
      throw new BadRequestException('Regeneration instruction text is required');
    }
    return this.memeEngine.regenerateWithInstruction(id, instruction.trim());
  }

  /**
   * Restore an earlier version
   */
  @Post(':id/restore/:version')
  async restoreVersion(
    @Param('id') id: string,
    @Param('version') version: string
  ) {
    const versionNum = parseInt(version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      throw new BadRequestException('Valid version number is required');
    }
    return this.memeEngine.restoreVersion(id, versionNum);
  }

  /**
   * Delete meme and clean up version outputs safely
   */
  @Delete(':id')
  async deleteMeme(@Param('id') id: string) {
    return this.memeEngine.deleteMeme(id);
  }

  /**
   * Download meme in PNG or JPEG (optionally specifying version)
   */
  @Get(':id/download/:format')
  async downloadMeme(
    @Param('id') id: string,
    @Param('format') format: string,
    @Query('version') version: string,
    @Res() res: Response
  ) {
    const meme = await this.memeEngine.getMemeById(id);

    let targetPaths = meme.outputPaths;
    let targetVersion = meme.currentVersion;

    if (version) {
      const vNum = parseInt(version, 10);
      const snapshot = meme.versions?.find(v => v.versionNumber === vNum);
      if (snapshot && snapshot.outputPaths) {
        targetPaths = snapshot.outputPaths;
        targetVersion = vNum;
      }
    }

    const filePath = format === 'jpeg' || format === 'jpg' ? targetPaths.jpeg : targetPaths.png;
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Image file for version ${targetVersion} not found on disk`);
    }

    const ext = format === 'jpeg' || format === 'jpg' ? 'jpeg' : 'png';
    const filename = `kanyaraasi_${meme.memeId.substring(0, 8)}_v${targetVersion}.${ext}`;
    res.download(filePath, filename);
  }

  /**
   * Direct JSON generation endpoint
   */
  @Post('generate')
  async generateMeme(@Body() dto: GenerateMemeDto) {
    if (!dto.content || !dto.assets) {
      throw new BadRequestException('Content and assets are required for meme generation');
    }
    return this.memeEngine.generateMeme(dto);
  }

  @Post('preview')
  async previewMeme(@Body() dto: GenerateMemeDto) {
    return this.memeEngine.generateMeme(dto);
  }

  /**
   * Multipart Form Upload & Generation Endpoint
   */
  @Post('upload-and-generate')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'subjectImages', maxCount: 10 },
        { name: 'reactionImage', maxCount: 1 }
      ],
      { storage: multerStorage }
    )
  )
  async uploadAndGenerate(
    @UploadedFiles()
    files: {
      subjectImages?: MulterUploadedFile[];
      reactionImage?: MulterUploadedFile[];
    },
    @Body('payload') rawPayload: string
  ) {
    if (!rawPayload) {
      throw new BadRequestException('JSON payload is required with form upload');
    }

    let parsedPayload: any;
    try {
      parsedPayload = JSON.parse(rawPayload);
    } catch (e: any) {
      throw new BadRequestException('Invalid JSON payload: ' + e.message);
    }

    const { content, design, layout, subjectLabels } = parsedPayload;

    if (!content || !content.punchline) {
      throw new BadRequestException('Meme punchline is required');
    }

    const subjectImages: UploadedAsset[] = [];
    if (files.subjectImages && files.subjectImages.length > 0) {
      files.subjectImages.forEach((f, idx) => {
        const customLabel = Array.isArray(subjectLabels) && subjectLabels[idx] ? subjectLabels[idx] : undefined;
        subjectImages.push({
          id: randomUUID(),
          originalName: f.originalname,
          filename: f.filename,
          path: f.path,
          mimeType: f.mimetype,
          role: idx === 0 ? 'subject_primary' : (idx === 1 ? 'subject_secondary' : 'subject_item'),
          orderIndex: idx,
          label: customLabel
        });
      });
    }

    let reactionImage: UploadedAsset | undefined;
    if (files.reactionImage && files.reactionImage.length > 0) {
      const rx = files.reactionImage[0];
      reactionImage = {
        id: randomUUID(),
        originalName: rx.originalname,
        filename: rx.filename,
        path: rx.path,
        mimeType: rx.mimetype,
        role: 'reaction_punchline',
        orderIndex: 99
      };
    }

    return this.memeEngine.generateMeme({
      content,
      assets: {
        subjectImages,
        reactionImage
      },
      design,
      layout
    });
  }

  /**
   * Generates reference standard meme for any of the 5 archetypes using extracted assets
   */
  @Get('reference/:format')
  async generateReferenceFormat(@Param('format') format: string) {
    const assetsDir = path.join(__dirname, '..', '..', 'test-assets');

    if (format === 'facts_collage') {
      return this.memeEngine.generateMeme({
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
    }

    if (format === 'comparison') {
      return this.memeEngine.generateMeme({
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
    }

    if (format === 'trending_news') {
      return this.memeEngine.generateMeme({
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
    }

    if (format === 'movie_update') {
      return this.memeEngine.generateMeme({
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
    }

    if (format === 'stacked_comparison' || format === 'custom') {
      return this.memeEngine.generateMeme({
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
    }

    throw new BadRequestException(`Unknown format: ${format}`);
  }
}
