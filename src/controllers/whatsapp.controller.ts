import { Controller, Get, Post, Query, Body, Res, Req, Headers, HttpCode, Logger, RawBodyRequest } from '@nestjs/common';
import { Request, Response } from 'express';
import { verifyMetaSignature } from '../security/http-guards';
import { WhatsAppService } from '../services/whatsapp.service';
import { getConfig } from '../config/app-config';
import { Public } from '../auth/public.decorator';

@Controller('api/whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(private readonly whatsappService: WhatsAppService) {}

  /**
   * Meta Webhook verification endpoint (called by Meta during "Verify and save").
   * Public: Meta cannot sign in. It is protected by the verify token.
   */
  @Public()
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response
  ) {
    const verifiedChallenge = this.whatsappService.verifyWebhook(mode, verifyToken, challenge);
    if (verifiedChallenge) {
      return res.status(200).send(verifiedChallenge);
    }
    return res.status(403).send('Forbidden');
  }

  /**
   * Meta Webhook incoming events endpoint (called whenever user sends a message).
   * Public: Meta cannot sign in. It is protected by the X-Hub-Signature-256 check below.
   */
  @Public()
  @Post('webhook')
  async handleWebhook(
    @Body() body: any,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Res() res: Response
  ) {
    // Only Meta can produce a valid HMAC of the raw body with the app secret. Fail closed.
    if (!verifyMetaSignature(req.rawBody, signature, getConfig().whatsapp.appSecret)) {
      this.logger.warn('Rejected WhatsApp webhook POST with missing/invalid X-Hub-Signature-256');
      return res.status(403).send('Forbidden');
    }

    // Acknowledge Meta immediately with 200 OK
    res.status(200).send('EVENT_RECEIVED');

    // Process messages asynchronously in the background
    this.whatsappService.processIncomingWebhook(body).catch(err => {
      // Logged inside service
    });
  }

  /**
   * Status endpoint for checking WhatsApp configuration
   */
  @Get('status')
  @HttpCode(200)
  getStatus() {
    const cfg = getConfig().whatsapp;
    return {
      configured: Boolean(cfg.phoneNumberId && cfg.accessToken),
      phoneNumberId: cfg.phoneNumberId,
      allowedPhone: cfg.allowedPhone,
      verifyTokenConfigured: Boolean(cfg.verifyToken),
      apiVersion: cfg.apiVersion
    };
  }
}

