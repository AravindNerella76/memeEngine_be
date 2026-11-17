import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator';

@Controller('api')
export class AppController {
  /** Public so the sign-in page can tell "server down" from "not signed in". Reveals nothing private. */
  @Public()
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      engine: 'Telugu Meme Generator Engine',
      channel: '@kanyaraasi_memes',
      phase: 1,
      teluguFontsLoaded: ['Ramabhadra', 'Mandali', 'Noto Sans Telugu', 'Anek Telugu'],
      englishFontsLoaded: ['Anton', 'Arial Black', 'Impact', 'Intrepid ExtraBold'],
      timestamp: new Date().toISOString()
    };
  }
}

