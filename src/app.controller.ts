import { Controller, Get } from '@nestjs/common';

@Controller('api')
export class AppController {
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      engine: 'Telugu Meme Generator Engine',
      channel: '@kanyaraasi_memes',
      phase: 1,
      teluguFontsLoaded: ['Ramabhadra', 'Mandali', 'Noto Sans Telugu'],
      englishFontsLoaded: ['Anton', 'Arial Black', 'Impact', 'Intrepid ExtraBold'],
      timestamp: new Date().toISOString()
    };
  }
}

