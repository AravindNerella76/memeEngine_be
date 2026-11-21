import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Req, ServiceUnavailableException } from '@nestjs/common';
import { AuthedRequest } from '../auth/auth.guard';
import { PUSH_KINDS } from '../schemas/push.schemas';
import { PushService } from '../services/push.service';

/**
 * Notifications on this device, even with the studio closed.
 *   GET    /api/push/key                the server's public key (the browser subscribes with it)
 *   POST   /api/push/subscribe          { subscription, kinds? } -> { id, kinds }
 *   GET    /api/push/devices            every device that gets notifications
 *   PUT    /api/push/devices/:id        { kinds } what this device is told about
 *   DELETE /api/push/devices/:id        stop notifications on that device
 *   POST   /api/push/devices/:id/test   send a test notification there
 */
@Controller('api/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('key')
  async key() {
    const publicKey = await this.push.publicKey();
    if (!publicKey) throw new ServiceUnavailableException({ statusCode: 503, code: 'push_unavailable', message: 'Notifications are not available on this server right now.' });
    return { publicKey, kinds: PUSH_KINDS };
  }

  @Post('subscribe')
  @HttpCode(200)
  subscribe(@Body() body: any, @Req() req: AuthedRequest) {
    // with login switched off there is no session: the device is tied to a fixed marker and always counts as signed in
    const sessionHash = req.auth?.tokenHash || 'auth-disabled';
    return this.push.subscribe(body?.subscription, sessionHash, String(req.headers['user-agent'] || ''), body?.kinds);
  }

  @Get('devices')
  async devices() {
    return { devices: await this.push.list() };
  }

  @Put('devices/:id')
  async setKinds(@Param('id') id: string, @Body() body: any) {
    const kinds = await this.push.setKinds(id, body?.kinds);
    if (!kinds) throw new NotFoundException({ statusCode: 404, code: 'unknown_device', message: 'That device no longer gets notifications.' });
    return { id, kinds };
  }

  @Delete('devices/:id')
  async remove(@Param('id') id: string) {
    return { removed: await this.push.unsubscribe(id) };
  }

  @Post('devices/:id/test')
  @HttpCode(200)
  async test(@Param('id') id: string) {
    const r = await this.push.send(
      'meme',
      { title: 'Notifications are on', body: 'This is how the studio will tell you when a meme is ready, even with the tab closed.', url: '/settings?section=notifications', tag: 'test', force: true },
      id
    );
    if (!r.sent && r.removed) throw new NotFoundException({ statusCode: 404, code: 'unknown_device', message: 'This browser’s subscription has expired. Turn notifications off and on again.' });
    return r;
  }
}
