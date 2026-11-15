import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { AuthSession, AuthSessionSchema, AuthUser, AuthUserSchema } from './auth/auth.schemas';
import { AppController } from './app.controller';
import { MemeController } from './controllers/meme.controller';
import { DesignProfileController, SystemController } from './controllers/system.controller';
import { SettingsController } from './controllers/settings.controller';
import { ImageSelectionController } from './controllers/image-selection.controller';
import { ImageSelectionService } from './services/image-selection.service';
import { SettingsPreviewService } from './services/settings-preview.service';
import { LayoutEngineService } from './services/layout-engine.service';
import { CanvasRendererService } from './services/canvas-renderer.service';
import { MemeEngineService } from './services/meme-engine.service';
import { RegenerationService } from './services/regeneration.service';
import { ViralMemeAnalyzerService } from './services/viral-meme-analyzer.service';
import { InternetSubjectDiscoveryService } from './services/internet-subject-discovery.service';
import { ViralAdaptationService } from './services/viral-adaptation.service';
import { DesignProfileRecord, DesignProfileSchema, DesignProfileService } from './design/design-profile.service';
import { Meme, MemeSchema } from './schemas/meme.schema';
import { InstagramAccount, InstagramAccountSchema } from './schemas/instagram-account.schema';
import { WhatsAppSession, WhatsAppSessionSchema } from './schemas/whatsapp-session.schema';
import { InstagramController } from './controllers/instagram.controller';
import { WhatsAppController } from './controllers/whatsapp.controller';
import { InstagramOAuthService } from './services/instagram-oauth.service';
import { InstagramTokenService } from './services/instagram-token.service';
import { InstagramPublisherService } from './services/instagram-publisher.service';
import { WhatsAppService } from './services/whatsapp.service';
import { MemeFormat, MemeFormatSchema } from './schemas/meme-format.schema';
import { FormatLibraryService } from './services/format-library.service';
import { WhatsAppCredentials, WhatsAppCredentialsSchema } from './schemas/whatsapp-credentials.schema';
import { WhatsAppCredentialsService } from './services/whatsapp-credentials.service';
import { FormatController } from './controllers/format.controller';
import { VisionCliRunner } from './vision/vision-cli.runner';
import { ProviderUsageRecord, ProviderUsageSchema, ProviderUsageService } from './discovery/provider-usage';
import { getConfig } from './config/app-config';

@Module({
  imports: [
    MongooseModule.forRoot(getConfig().mongoUri, {
      serverSelectionTimeoutMS: 5000,
    }),
    MongooseModule.forFeature([
      { name: Meme.name, schema: MemeSchema },
      { name: DesignProfileRecord.name, schema: DesignProfileSchema },
      { name: ProviderUsageRecord.name, schema: ProviderUsageSchema },
      { name: InstagramAccount.name, schema: InstagramAccountSchema },
      { name: WhatsAppSession.name, schema: WhatsAppSessionSchema },
      { name: MemeFormat.name, schema: MemeFormatSchema },
      { name: WhatsAppCredentials.name, schema: WhatsAppCredentialsSchema },
      { name: AuthUser.name, schema: AuthUserSchema },
      { name: AuthSession.name, schema: AuthSessionSchema }
    ])
  ],
  controllers: [
    AppController,
    AuthController,
    MemeController,
    DesignProfileController,
    SettingsController,
    ImageSelectionController,
    SystemController,
    InstagramController,
    WhatsAppController,
    FormatController
  ],
  providers: [
    AuthService,
    // Every route needs a signed-in session unless it is marked @Public()
    { provide: APP_GUARD, useClass: AuthGuard },
    VisionCliRunner,
    LayoutEngineService,
    CanvasRendererService,
    MemeEngineService,
    RegenerationService,
    ViralMemeAnalyzerService,
    InternetSubjectDiscoveryService,
    ViralAdaptationService,
    DesignProfileService,
    SettingsPreviewService,
    ImageSelectionService,
    ProviderUsageService,
    InstagramTokenService,
    InstagramOAuthService,
    InstagramPublisherService,
    WhatsAppService,
    FormatLibraryService,
    WhatsAppCredentialsService
  ],
})
export class AppModule {}
