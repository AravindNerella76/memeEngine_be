import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { getConfig } from '../config/app-config';
import { AuthContext, AuthService } from './auth.service';
import { IS_PUBLIC } from './public.decorator';

export type AuthedRequest = Request & { auth?: AuthContext };

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: every route needs a valid session unless it is marked @Public().
 * Defence in depth for the cookie: on top of SameSite=Lax and the Origin allow-list, a state-changing
 * request that the browser itself labels cross-site (Sec-Fetch-Site) is refused.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!getConfig().auth.enabled) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const session = await this.auth.sessionFromRequest(req);
    if (!session) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'auth_required',
        message: 'Please sign in.',
        setupRequired: !(await this.auth.ownerExists())
      });
    }

    const site = req.headers['sec-fetch-site'];
    if (!SAFE.has(req.method) && typeof site === 'string' && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
      throw new ForbiddenException({ statusCode: 403, code: 'cross_site', message: 'Cross-site request refused.' });
    }

    req.auth = session;
    return true;
  }
}
