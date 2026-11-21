import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { getConfig } from '../config/app-config';
import { AuthService, LockoutEvent, SignInEvent } from '../auth/auth.service';
import { describeDevice } from '../auth/device';
import { END_SESSION_PREFIX } from '../auth/whatsapp-login.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppCredentialsService } from './whatsapp-credentials.service';
import { PushService } from './push.service';

export interface AlertRecord {
  at: Date;
  kind: 'signin' | 'lockout';
  /** WhatsApp numbers the alert was handed to (Meta accepted it). Delivery itself is reported later, as a status. */
  whatsappSent: number;
  whatsappFailed: number;
  pushSent: number;
  via: 'template' | 'message' | 'none';
}

/**
 * Tells the owner about every new sign-in, on WhatsApp (each allowed number) and as a push notification, with a
 * "That wasn't me" button that ends exactly that sign-in. Also says when sign-in was paused after wrong passwords.
 *
 * WhatsApp only delivers a free-form message within 24 hours of your last message to the bot. Outside that window
 * the alert is refused (the health page says so) unless an approved template is set: WHATSAPP_ALERT_TEMPLATE.
 */
@Injectable()
export class SignInAlertService implements OnModuleInit {
  private readonly logger = new Logger(SignInAlertService.name);
  last: AlertRecord | null = null;

  constructor(
    private readonly auth: AuthService,
    @Optional() private readonly whatsapp?: WhatsAppService,
    @Optional() private readonly credentials?: WhatsAppCredentialsService,
    @Optional() private readonly push?: PushService
  ) {}

  onModuleInit(): void {
    // never in the way of the sign-in itself: the alert goes out after the answer
    this.auth.events.on('signin', (e: SignInEvent) => void this.onSignIn(e).catch(err => this.logger.warn(`Sign-in alert failed: ${err?.message || err}`)));
    this.auth.events.on('lockout', (e: LockoutEvent) => void this.onLockout(e).catch(err => this.logger.warn(`Lockout alert failed: ${err?.message || err}`)));
  }

  private async recipients(except?: string): Promise<string[]> {
    let list = getConfig().whatsapp.allowedPhone;
    try {
      if (this.credentials) list = (await this.credentials.getEffective()).allowedPhone || '';
    } catch {
      /* the server setting then */
    }
    return String(list || '')
      .split(',')
      .map(s => s.trim())
      .filter(n => n && n !== except);
  }

  async onSignIn(e: SignInEvent): Promise<AlertRecord | null> {
    if (!getConfig().auth.signInAlerts) return null;
    const device = describeDevice(e.userAgent);
    const ip = e.ip || 'unknown address';
    const how = e.method === 'whatsapp' ? `a WhatsApp code from the number ending ${String(e.approvedBy || '').slice(-4)}` : 'the password';
    const record: AlertRecord = { at: new Date(), kind: 'signin', whatsappSent: 0, whatsappFailed: 0, pushSent: 0, via: 'none' };

    // the number that approved a WhatsApp sign-in already has its answer (with the same button): tell the others
    const to = await this.recipients(e.approvedBy);
    const button = { id: `${END_SESSION_PREFIX}${e.sessionId}`, title: "That wasn't me" };
    const head = `🔐 *New sign-in to the studio*\n\n💻 ${device}\n🌐 ${ip}\n🔑 With ${how}\n\n`;
    const template = getConfig().whatsapp.alertTemplate;
    if (this.whatsapp && to.length) {
      record.via = template ? 'template' : 'message';
      for (const n of to) {
        let ok: boolean;
        if (template) ok = await this.whatsapp.sendTemplateMessage(n, template, getConfig().whatsapp.alertTemplateLang, [device, ip, how], [button.id]);
        else {
          ok = await this.whatsapp.sendButtonsMessage(n, `${head}If this was you, there is nothing to do. Not you? Tap *That wasn't me* and that sign-in ends at once.`, [button]);
          if (!ok) ok = await this.whatsapp.sendTextMessage(n, `${head}If this was you, there is nothing to do. Not you? Send *Sign out everywhere* and every sign-in ends at once.`);
        }
        if (ok) record.whatsappSent++;
        else record.whatsappFailed++;
      }
    }
    if (this.push) {
      const r = await this.push.send('security', {
        title: 'New sign-in to the studio',
        body: `${device} · ${ip} · with ${how}. Not you? Open Account to end it.`,
        url: '/settings?section=account',
        tag: `signin-${e.sessionId}`,
        requireInteraction: true
      });
      record.pushSent = r.sent;
    }
    this.last = record;
    return record;
  }

  async onLockout(e: LockoutEvent): Promise<AlertRecord | null> {
    if (!getConfig().auth.signInAlerts) return null;
    const record: AlertRecord = { at: new Date(), kind: 'lockout', whatsappSent: 0, whatsappFailed: 0, pushSent: 0, via: 'none' };
    const text =
      `⚠️ *Sign-in paused*\n\n` +
      `Too many wrong passwords for "${e.username}" from ${e.ip}. Sign-in from there is paused for ${e.minutes} minute${e.minutes === 1 ? '' : 's'}.\n\n` +
      `Not you? Someone is guessing the password: make it longer (Settings › Account). You can still sign in with a WhatsApp code.`;
    if (this.whatsapp) {
      record.via = 'message';
      for (const n of await this.recipients()) {
        if (await this.whatsapp.sendTextMessage(n, text)) record.whatsappSent++;
        else record.whatsappFailed++;
      }
    }
    if (this.push) {
      const r = await this.push.send('security', {
        title: 'Sign-in paused after wrong passwords',
        body: `"${e.username}" from ${e.ip}: paused for ${e.minutes} min. Not you? Make the password longer.`,
        url: '/settings?section=account',
        tag: `lockout-${e.ip}`,
        requireInteraction: true
      });
      record.pushSent = r.sent;
    }
    this.last = record;
    return record;
  }
}
