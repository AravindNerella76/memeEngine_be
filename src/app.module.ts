import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { MemeController } from './controllers/meme.controller';
import { LayoutEngineService } from './services/layout-engine.service';
import { CanvasRendererService } from './services/canvas-renderer.service';
import { MemeEngineService } from './services/meme-engine.service';
import { RegenerationService } from './services/regeneration.service';
import { ViralMemeAnalyzerService } from './services/viral-meme-analyzer.service';
import { SubjectDiscoveryService } from './services/subject-discovery.service';
import { InternetSubjectDiscoveryService } from './services/internet-subject-discovery.service';
import { Meme, MemeSchema } from './schemas/meme.schema';

@Module({
  imports: [
    MongooseModule.forRoot('mongodb://127.0.0.1:27017/kanyaraasi_memes', {
      serverSelectionTimeoutMS: 5000,
    }),
    MongooseModule.forFeature([
      { name: Meme.name, schema: MemeSchema }
    ])
  ],
  controllers: [AppController, MemeController],
  providers: [
    LayoutEngineService,
    CanvasRendererService,
    MemeEngineService,
    RegenerationService,
    ViralMemeAnalyzerService,
    SubjectDiscoveryService,
    InternetSubjectDiscoveryService
  ],
})
export class AppModule {}
