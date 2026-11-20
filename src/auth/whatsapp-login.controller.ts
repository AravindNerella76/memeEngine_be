import { BadRequestException, Body, ConflictException, Controller, HttpCode, HttpException, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { getConfig } from '../config/app-config';
import { AuthedRequest } from './auth.guard';
import { AuthService, ClientInfo } from './auth.service';
import { sessionCookie } from './cookies';
import { Public } from './public.decorator';
import { formatCode, TooManyChallengesError } from './whatsapp-challenges';
import { WhatsAppLoginService } from './whatsapp-login.service';

const clientOf = (req: AuthedRequest): ClientInfo => ({ ip: req.ip || req.socket?.remoteAddress || 'unknown', userAgent: String(req.headers['user-agent'] || '') });

/** Only a plain string token is accepted, never an object that could reach a lookup. */
function tokenOf(body: unknown, key: string, required: boolean): string | undefined {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (v === undefined || v === null || v === '') {
    if (required) throw new BadRequestException({ statusCode: 400, code: 'invalid_body', message: `"${key}" is missing.` });
    return undefined;
  }
  if (typeof v !== 'string' || v.length > 100) throw new BadRequestException({ statusCode: 400, code: 'invalid_body', message: `"${key}" must be text.` });
  return v;
}

/**
 * Sign in by sending a code from WhatsApp. All three routes are public (you are not signed in yet) and protect
 * themselves: a code is approved only by a message from an allowed number, and the page waits with a secret token.
 *
 *   POST /api/auth/whatsapp/start   a new code + the bot's number (and the previous code of this page, if any, ends)
 *   POST /api/auth/whatsapp/poll    waits up to 25 s; on approval sets the session cookie, like a password sign-in
 *   POST /api/auth/whatsapp/cancel  the page moved on: its code stops working
 */
@Controller('api/auth/whatsapp')
export class WhatsAppLoginController {
  constructor(private readonly login: WhatsAppLoginService, private readonly auth: AuthService) {}

  @Public()
  @Post('start')
  @HttpCode(200)
  async start(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const replaces = tokenOf(body, 'replaces', false);
    if (!getConfig().auth.enabled) throw new ConflictException({ statusCode: 409, code: 'auth_disabled', message: 'Login is switched off on this server.' });
    if (!(await this.auth.ownerExists())) throw new ConflictException({ statusCode: 409, code: 'setup_required', message: 'Create the owner account first.' });
    const a = await this.login.availability();
    if (!a.available || !a.bot) throw new ServiceUnavailableException({ statusCode: 503, code: 'whatsapp_unavailable', message: a.reason || 'WhatsApp sign-in is not available right now.' });

    try {
      const { challenge, token } = this.login.start(clientOf(req), replaces);
      const message = `Login ${challenge.code}`;
      return {
        code: challenge.code,
        codeDisplay: formatCode(challenge.code),
        token,
        expiresAt: new Date(challenge.expiresAt).toISOString(),
        ttlSeconds: Math.round((challenge.expiresAt - challenge.createdAt) / 1000),
        serverNow: new Date().toISOString(),
        bot: a.bot,
        message,
        link: `https://wa.me/${a.bot.digits}?text=${encodeURIComponent(message)}`
      };
    } catch (e) {
      if (e instanceof TooManyChallengesError) {
        res.setHeader('Retry-After', String(e.retryAfterSec));
        throw new HttpException(
          {
            statusCode: 429,
            code: 'too_many_codes',
            message: e.scope === 'ip' ? 'Too many new codes from this device. Wait a few minutes, or sign in with your password.' : 'The server is busy with sign-in codes right now. Try again in a minute.',
            retryAfterSeconds: e.retryAfterSec
          },
          429
        );
      }
      throw e;
    }
  }

  @Public()
  @Post('poll')
  @HttpCode(200)
  async poll(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const token = tokenOf(body, 'token', true);
    // the page closed or gave up: stop holding the request (res 'close', not req: req closes once the body is read)
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const out = await this.login.poll(token, clientOf(req), ac.signal);
    if (out.status === 'approved') {
      res.setHeader('Set-Cookie', sessionCookie(out.token, { secure: getConfig().auth.cookieSecure, maxAgeSeconds: out.maxAgeSeconds }));
      return { status: 'approved', authenticated: true, username: out.username, phoneTail: out.phoneTail, ...this.auth.staticFlags(out.username) };
    }
    if (out.status === 'pending') {
      return { status: 'pending', expiresAt: new Date(out.expiresAt).toISOString(), serverNow: new Date().toISOString(), ...(out.rejectedFrom ? { rejectedFrom: out.rejectedFrom } : {}) };
    }
    return out;
  }

  @Public()
  @Post('cancel')
  @HttpCode(200)
  cancel(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { cancelled: this.login.cancelFromBrowser(tokenOf(body, 'token', true)) };
  }
}
