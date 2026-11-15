import './config/load-env';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { GlobalFonts } from '@napi-rs/canvas';
import * as express from 'express';
import * as path from 'path';
import { OUTPUT_ROOT } from './security/path-guard';
import {
  corsOrigin,
  defaultGuardOptions,
  hostAndOriginGuard,
  tunnelPathGuard,
  securityHeaders
} from './security/http-guards';
import { UploadErrorFilter } from './security/upload-error.filter';
import { describeConfig, getConfig } from './config/app-config';
import { AuthService } from './auth/auth.service';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

async function bootstrap() {
  // Fail closed: never run without login on an address other people can reach.
  const cfg = getConfig();
  if (!cfg.auth.enabled && (!LOOPBACK.has(cfg.host) || cfg.auth.appHosts.length > 0)) {
    console.error(
      'Refusing to start: AUTH_ENABLED=false, but the server is reachable from outside ' +
        `(HOST=${cfg.host}${cfg.auth.appHosts.length ? `, APP_HOSTS=${cfg.auth.appHosts.join(',')}` : ''}). ` +
        'Turn login back on (remove AUTH_ENABLED=false) or bind to 127.0.0.1 and clear APP_HOSTS.'
    );
    process.exit(1);
  }

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

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // --- Security hardening -------------------------------------------------------------------
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.disable('x-powered-by');
  // Behind a reverse proxy (Caddy, nginx) the real client address and HTTPS come from its headers.
  // Needed for per-address sign-in limits; without it every visitor would look like 127.0.0.1.
  expressApp.set('trust proxy', cfg.auth.trustProxy > 0 ? cfg.auth.trustProxy : false);
  // Flat query parsing: "?type[$ne]=x" stays a plain string key instead of becoming a MongoDB operator object
  expressApp.set('query parser', 'simple');

  app.useGlobalFilters(new UploadErrorFilter(app.get(HttpAdapterHost).httpAdapter));

  const guard = defaultGuardOptions();
  app.use(securityHeaders({ hsts: cfg.auth.cookieSecure }));
  app.use(hostAndOriginGuard(guard));
  app.use(tunnelPathGuard(cfg.auth.appHosts));
  app.enableCors({
    origin: corsOrigin(guard),
    credentials: true, // the session cookie; still only for allow-listed origins
    // PUT: settings updates (PUT /api/settings, PUT /api/design-profile). Origins stay allow-listed.
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600
  });

  // Generated memes are public by design (gallery + downloads). Only image files are served, no
  // dotfiles, no directory listings. Uploaded/discovered source images are NOT served at all.
  app.use('/output', (req: express.Request, res: express.Response, next: express.NextFunction) =>
    /\.(png|jpe?g)$/i.test(req.path) ? next() : res.status(404).end()
  );
  app.use('/output', express.static(OUTPUT_ROOT, { dotfiles: 'deny', index: false, redirect: false }));

  // Always bind 0.0.0.0 on cloud hosts (Render, Railway, Docker) or when PORT is provided
  const bindHost = process.env.PORT || process.env.RENDER || cfg.host === '0.0.0.0' ? '0.0.0.0' : cfg.host;
  await app.listen(cfg.port, bindHost);
  console.log(`Telugu Meme Engine Server running on http://${bindHost}:${cfg.port}`);
  console.log('Configuration:', JSON.stringify(describeConfig(cfg)));

  // Sign-in status, with the mistakes that matter spelled out
  if (!cfg.auth.enabled) {
    console.warn('WARNING: login is OFF (AUTH_ENABLED=false). Only do this for local development.');
  } else {
    const hasOwner = await app.get(AuthService).ownerExists().catch(() => false);
    if (!hasOwner) console.warn('NOTICE: no owner account yet, so nobody can sign in. Run: npm run auth:create-owner');
    if (cfg.auth.appHosts.length) {
      if (cfg.auth.trustProxy === 0) console.warn('WARNING: APP_HOSTS is set but TRUST_PROXY=0. Behind a reverse proxy set TRUST_PROXY=1, otherwise every visitor shares one address in the sign-in limits.');
      if (!cfg.auth.cookieSecure) console.warn('WARNING: the session cookie is not marked Secure (AUTH_COOKIE_SECURE=false). Serve the app over HTTPS and set APP_PUBLIC_URL=https://...');
    }
  }
  if (!cfg.vision.cliPath) console.warn('WARNING: vision CLI (agy) not found. Viral adaptation will fail until VISION_CLI_PATH is set.');
}

bootstrap();
