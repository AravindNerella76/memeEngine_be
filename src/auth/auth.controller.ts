import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { getConfig } from '../config/app-config';
import { AuthedRequest } from './auth.guard';
import { AuthService, ClientInfo, TooManyAttemptsException } from './auth.service';
import { clearedSessionCookie, readCookie, sessionCookie, sessionCookieName } from './cookies';
import { Public } from './public.decorator';

const clientOf = (req: AuthedRequest): ClientInfo => ({ ip: req.ip || req.socket?.remoteAddress || 'unknown', userAgent: String(req.headers['user-agent'] || '') });

/** Only plain strings are accepted: an object such as {"$ne": ""} must never reach a database query. */
function strings(body: unknown, ...keys: string[]): string[] {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return keys.map(k => {
    const v = b[k];
    if (v !== undefined && typeof v !== 'string') throw new BadRequestException({ statusCode: 400, code: 'invalid_body', message: `"${k}" must be text.` });
    return (v as string) ?? '';
  });
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Who am I? Never an error: the app calls this first to decide between the sign-in page and the studio. */
  @Public()
  @Get('me')
  async me(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    if (!getConfig().auth.enabled) return { authEnabled: false, authenticated: true, username: null };
    const session = await this.auth.sessionFromRequest(req);
    if (session) return { authEnabled: true, authenticated: true, username: session.username };
    return { authEnabled: true, authenticated: false, setupRequired: !(await this.auth.ownerExists()) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const [username, password] = strings(body, 'username', 'password');
    try {
      const s = await this.auth.login(username, password, clientOf(req));
      res.setHeader('Set-Cookie', sessionCookie(s.token, { secure: getConfig().auth.cookieSecure, maxAgeSeconds: s.maxAgeSeconds }));
      return { authenticated: true, username: s.username };
    } catch (e) {
      if (e instanceof TooManyAttemptsException) res.setHeader('Retry-After', String(e.retryAfterSec));
      throw e;
    }
  }

  /** Public and forgiving: signing out twice, or with an expired session, is not an error. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const secure = getConfig().auth.cookieSecure;
    res.setHeader('Cache-Control', 'no-store');
    await this.auth.logout(readCookie(req.headers.cookie, sessionCookieName(secure)));
    res.setHeader('Set-Cookie', clearedSessionCookie(secure));
    return { authenticated: false };
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const [current, next] = strings(body, 'currentPassword', 'newPassword');
    try {
      return await this.auth.changePassword(req.auth!, current, next, clientOf(req));
    } catch (e) {
      if (e instanceof TooManyAttemptsException) res.setHeader('Retry-After', String(e.retryAfterSec));
      throw e;
    }
  }

  /** Ends every other sign-in (a lost phone, a shared computer). The current one stays. */
  @Post('logout-others')
  @HttpCode(200)
  async logoutOthers(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { ended: await this.auth.logoutOthers(req.auth!.userId, req.auth!.tokenHash) };
  }

  @Get('sessions')
  async sessions(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { sessions: await this.auth.listSessions(req.auth!.userId, req.auth!.tokenHash) };
  }
}
