import { BadRequestException, Controller, Delete, Get, Post, Put, Query, Body, Res, Req, Headers, HttpCode, Logger, Optional, RawBodyRequest } from '@nestjs/common';
import { Request, Response } from 'express';
import { verifyMetaSignature } from '../security/http-guards';
import { WhatsAppService } from '../services/whatsapp.service';
import { CREDENTIAL_FIELDS, CredentialField, WhatsAppCredentialsService, WhatsAppStatus } from '../services/whatsapp-credentials.service';
import { Public } from '../auth/public.decorator';
import { WhatsAppLoginService } from '../auth/whatsapp-login.service';

@Controller('api/whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly credentials: WhatsAppCredentialsService,
    // the sign-in page shows the bot's number: look it up again after the token or phone number ID changes
    @Optional() private readonly whatsappLogin?: WhatsAppLoginService
  ) {}

  /**
   * Meta Webhook verification endpoint (called by Meta during "Verify and save").
   * Public: Meta cannot sign in. It is protected by the verify token.
   */
  @Public()
  @Get('webhook')
  async verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response
  ) {
    const verifiedChallenge = await this.whatsappService.verifyWebhook(mode, verifyToken, challenge);
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
    const appSecret = (await this.credentials.getEffective()).appSecret;
    if (!verifyMetaSignature(req.rawBody, signature, appSecret)) {
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
   * WhatsApp configuration and token health. With ?check=1 Meta is asked whether the token works and when
   * it expires. The token itself is never returned, only the last 4 characters.
   */
  @Get('status')
  @HttpCode(200)
  async getStatus(@Query('check') check?: string): Promise<WhatsAppStatus> {
    return this.credentials.status(check === '1' || check === 'true');
  }

  /**
   * Saves a new access token and/or phone number ID (so an expired token can be replaced from the app).
   * Meta is asked first; a token Meta rejects is not saved.
   */
  @Put('credentials')
  async saveCredentials(@Body() body: Partial<Record<CredentialField, unknown>>): Promise<WhatsAppStatus> {
    const input: Partial<Record<CredentialField, unknown>> = {};
    for (const f of CREDENTIAL_FIELDS) if (body && f in body) input[f] = body[f];
    const out = await this.credentials.saveAndVerify(input);
    this.whatsappLogin?.forgetBotNumber();
    return out;
  }

  /**
   * Removes a value saved in the app (?field=accessToken|phoneNumberId|verifyToken|appSecret|allowedPhone), or all
   * of them without ?field. The server (.env) setting, if any, is used again.
   */
  @Delete('credentials')
  async clearCredentials(@Query('field') field?: string): Promise<WhatsAppStatus> {
    if (field !== undefined && field !== 'all' && !(CREDENTIAL_FIELDS as string[]).includes(field)) {
      throw new BadRequestException('Unknown field.');
    }
    const out = await this.credentials.clearSaved(field as CredentialField | 'all' | undefined);
    this.whatsappLogin?.forgetBotNumber();
    return out;
  }
}
