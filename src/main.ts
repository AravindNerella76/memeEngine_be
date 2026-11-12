import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalFonts } from '@napi-rs/canvas';
import * as express from 'express';
import * as path from 'path';

async function bootstrap() {
  // Register fonts once at startup
  const fontsDir = path.join(__dirname, '..', 'fonts');
  try {
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Ramabhadra-Regular.ttf'), 'Ramabhadra');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Mandali-Regular.ttf'), 'Mandali');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'NotoSansTelugu-Bold.ttf'), 'Noto Sans Telugu');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Anton-Regular.ttf'), 'Anton');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Arial-Black.ttf'), 'Arial Black');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Impact.ttf'), 'Impact');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Intrepid-ExtraBold.ttf'), 'Intrepid ExtraBold');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'Intrepid-ExtraBold.ttf'), 'Intrepid');
    console.log('Fonts registered successfully into Skia engine.');
  } catch (err: any) {
    console.warn('Font registration notice:', err?.message || err);
  }

  const app = await NestFactory.create(AppModule);

  app.enableCors();

  // Static directories for generated memes and uploaded assets
  const outputDir = path.join(__dirname, '..', 'output');
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  app.use('/output', express.static(outputDir));
  app.use('/uploads', express.static(uploadsDir));

  const PORT = process.env.PORT || 3000;
  await app.listen(PORT);
  console.log(`Telugu Meme Engine Server running on http://localhost:${PORT}`);
}

bootstrap();
