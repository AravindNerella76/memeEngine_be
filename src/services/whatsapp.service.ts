import { GoneException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getConfig } from '../config/app-config';
import { WhatsAppSession, WhatsAppSessionDocument } from '../schemas/whatsapp-session.schema';
import { ViralAdaptationService } from './viral-adaptation.service';
import { InstagramPublisherService } from './instagram-publisher.service';
import { MemeEngineService } from './meme-engine.service';
import { ImageSelectionService } from './image-selection.service';
import { validateUploadPayload } from '../security/request-validation';
import type { UploadedAsset } from '../types/meme.types';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly seenMessageIds = new Set<string>();
  private readonly mediaDir = path.join(__dirname, '..', '..', 'uploads', 'whatsapp');

  constructor(
    @InjectModel(WhatsAppSession.name)
    private readonly sessionModel: Model<WhatsAppSessionDocument>,
    private readonly viralAdaptation: ViralAdaptationService,
    private readonly instagramPublisher: InstagramPublisherService,
    private readonly memeEngine: MemeEngineService,
    private readonly selection: ImageSelectionService
  ) {
    if (!fs.existsSync(this.mediaDir)) {
      fs.mkdirSync(this.mediaDir, { recursive: true });
    }
  }

  /**
   * Meta Webhook verification handshake for GET /api/whatsapp/webhook
   */
  verifyWebhook(mode?: string, token?: string, challenge?: string): string | null {
    const expectedToken = getConfig().whatsapp.verifyToken;
    if (expectedToken && mode === 'subscribe' && token === expectedToken && challenge) {
      this.logger.log(`WhatsApp webhook verified successfully`);
      return challenge;
    }
    this.logger.warn('WhatsApp webhook verification failed (mode/token mismatch or WHATSAPP_VERIFY_TOKEN not set)');
    return null;
  }

  /**
   * Sends a plain text WhatsApp message via Meta Cloud API
   */
  async sendTextMessage(to: string, text: string): Promise<boolean> {
    const cfg = getConfig().whatsapp;
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      this.logger.error('WhatsApp credentials missing in configuration');
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: text }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        this.logger.error(`Failed to send WhatsApp message: ${JSON.stringify(errJson)}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error sending WhatsApp message: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * Sends an image message to WhatsApp via public HTTPS URL
   */
  async sendImageMessage(to: string, imageUrl: string, caption?: string): Promise<boolean> {
    const cfg = getConfig().whatsapp;
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      this.logger.error('WhatsApp credentials missing in configuration');
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
      const payload: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: { link: imageUrl }
      };
      if (caption) {
        payload.image.caption = caption;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        this.logger.error(`Failed to send WhatsApp image: ${JSON.stringify(errJson)}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.error(`Error sending WhatsApp image: ${err?.message || err}`);
      return false;
    }
  }

  /**
   * Downloads a media file (image) sent by the user in WhatsApp
   */
  async downloadMedia(mediaId: string): Promise<{ filePath: string; filename: string; mimeType: string }> {
    const cfg = getConfig().whatsapp;
    // The id is interpolated into a Graph API URL that carries our bearer token: digits only.
    if (!/^\d{1,40}$/.test(String(mediaId))) {
      throw new Error('Invalid WhatsApp media id');
    }
    // Step 1: Query media URL
    const metaRes = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` }
    });
    if (!metaRes.ok) {
      const err = await metaRes.text();
      throw new Error(`Failed to query WhatsApp media: ${err}`);
    }
    const metaJson = await metaRes.json();
    const mediaUrl = metaJson.url;
    const mimeType = metaJson.mime_type || 'image/jpeg';
    const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
    const filename = `wa_${randomUUID()}${ext}`;
    const filePath = path.join(this.mediaDir, filename);

    // Step 2: Download the binary file using access token
    const fileRes = await fetch(mediaUrl, {
      headers: {
        'Authorization': `Bearer ${cfg.accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    if (!fileRes.ok) {
      throw new Error(`Failed to download WhatsApp media bytes: HTTP ${fileRes.status}`);
    }
    const arrayBuf = await fileRes.arrayBuffer();
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuf));

    return { filePath, filename, mimeType };
  }

  /**
   * Process all incoming webhook events from Meta
   */
  async processIncomingWebhook(body: any): Promise<void> {
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body?.entry)) {
      return;
    }

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change?.field === 'messages') {
          const value = change.value;
          const messages = value?.messages || [];
          for (const msg of messages) {
            // Meta retries deliveries; process each message id once.
            if (msg?.id) {
              if (this.seenMessageIds.has(msg.id)) continue;
              this.seenMessageIds.add(msg.id);
              if (this.seenMessageIds.size > 1000) {
                this.seenMessageIds.delete(this.seenMessageIds.values().next().value as string);
              }
            }
            const from = msg.from;
            await this.handleUserMessage(from, msg);
          }
        }
      }
    }
  }

  /**
   * Conversational state machine for handling messages from a user
   */
  private async handleUserMessage(from: string, message: any): Promise<void> {
    const cfg = getConfig().whatsapp;
    // Security check: restrict to configured phone number if specified
    // Fail closed: with no WHATSAPP_ALLOWED_PHONE configured nobody is authorised.
    if (!cfg.allowedPhone || from !== cfg.allowedPhone) {
      this.logger.warn(`Rejected message from unauthorized phone: ${from}`);
      if (cfg.allowedPhone) {
        await this.sendTextMessage(from, '⛔ This Meme Engine WhatsApp bot is configured for authorized users only.');
      }
      return;
    }

    let session = await this.sessionModel.findOne({ phoneNumber: from });
    if (!session) {
      session = await this.sessionModel.create({
        phoneNumber: from,
        state: 'IDLE'
      });
    }

    const type = message.type;

    // Handle Text Commands
    if (type === 'text') {
      const text = (message.text?.body || '').trim();
      const lower = text.toLowerCase();

      // Command: HELP / MENU
      if (['hi', 'hello', 'help', 'menu', 'start'].includes(lower)) {
        await this.sendTextMessage(
          from,
          `🎭 *Meme Engine WhatsApp Bot*\n\n` +
          `To create and publish a meme:\n` +
          `1️⃣ Send the *Reference Meme* screenshot\n` +
          `2️⃣ Send the *Reaction Image*\n` +
          `3️⃣ Send the *Punchline Text*\n\n` +
          `Or send *Manual* to build a meme from your own images and text.\n\n` +
          `Commands:\n` +
          `• *Approve* — Publish pending meme to Instagram (@kanyaraasi_memes)\n` +
          `• *Reset* — Clear current draft and start fresh\n` +
          `• *Status* — Check current state`
        );
        return;
      }

      // Command: RESET / CANCEL
      if (['reset', 'cancel', 'clear', 'new'].includes(lower)) {
        await this.resetSession(session);
        await this.sendTextMessage(from, '🧹 Session cleared! Send a *reference meme screenshot* to start fresh.');
        return;
      }

      // Command: STATUS
      if (lower === 'status') {
        await this.sendTextMessage(
          from,
          `📊 Current Status: *${session.state}*\n` +
          `Reference Image: ${session.referenceImagePath ? '✅ Ready' : '❌ Not set'}\n` +
          `Reaction Image: ${session.reactionImagePath ? '✅ Ready' : '❌ Not set'}\n` +
          `Punchline: ${session.punchline ? `"${session.punchline}"` : '❌ Not set'}`
        );
        return;
      }

      // Command: APPROVE / PUBLISH
      if (!this.isManualState(session) && ['approve', 'approved', 'publish', 'yes', 'ok'].includes(lower)) {
        if (session.state === 'AWAITING_APPROVAL' && session.lastGeneratedMemeId) {
          await this.sendTextMessage(from, '🚀 *Publishing to Instagram (@kanyaraasi_memes)...* Please wait 10-20 seconds.');
          try {
            const pubResult = await this.instagramPublisher.publishMeme(
              session.lastGeneratedMemeId,
              undefined,
              session.lastGeneratedCaption || session.punchline || 'Meme by @kanyaraasi_memes'
            );

            await this.sendTextMessage(
              from,
              `🎉 *Successfully Published to Instagram!*\n\n` +
              `📱 Account: *@${pubResult.username || 'kanyaraasi_memes'}*\n` +
              `🔗 View Post: ${pubResult.permalink || 'https://www.instagram.com/kanyaraasi_memes'}\n\n` +
              `Send a new reference meme anytime to create your next post! 🚀`
            );

            await this.resetSession(session);
          } catch (err: any) {
            this.logger.error(`Instagram publish error via WhatsApp: ${err?.message || err}`);
            await this.sendTextMessage(
              from,
              `❌ *Publishing to Instagram Failed:*\n${err?.message || err}\n\n` +
              `Reply *Approve* to retry, or *Reset* to discard.`
            );
          }
        } else {
          await this.sendTextMessage(from, '⚠️ No meme is currently waiting for approval. Send a *reference meme screenshot* to create one!');
        }
        return;
      }

      if (session.state === 'AWAITING_SLOT_IMAGE') {
        await this.askForSlotImage(session, from, true);
        return;
      }

      // Manual (own edit) flow: start, then route every text message while it is in progress
      if (['manual', 'custom', 'own'].includes(lower)) {
        if (session.state === 'AWAITING_APPROVAL' || session.state === 'GENERATING') {
          await this.sendTextMessage(from, '\u26a0\ufe0f Finish or *Reset* the current meme first.');
          return;
        }
        await this.resetSession(session);
        session.mode = 'manual';
        session.state = 'MANUAL_TYPE';
        await session.save();
        await this.sendTextMessage(from, this.manualTypePrompt());
        return;
      }
      if (this.isManualState(session)) {
        await this.handleManualText(session, from, text);
        return;
      }

      // When waiting for punchline text
      if (session.state === 'AWAITING_PUNCHLINE') {
        session.punchline = text;
        session.state = 'GENERATING';
        await session.save();

        await this.sendTextMessage(from, '⏳ *Generating your meme...* Running AI vision analysis & discovering clean subject images. This takes ~30-60s.');
        await this.generateAndSendMeme(session, from);
        return;
      }

      // If text sent in IDLE or AWAITING_REACTION without an image
      if (session.state === 'IDLE') {
        await this.sendTextMessage(from, '📸 Please send a *reference meme screenshot* first to start generating!');
        return;
      }

      if (session.state === 'AWAITING_REACTION') {
        await this.sendTextMessage(from, '🎭 Please send the *reaction image* (e.g. Brahmanandam, Pawan Kalyan, etc.) to continue.');
        return;
      }
    }

    // Handle Image Messages
    if (type === 'image') {
      try {
        const mediaId = message.image.id;
        const caption = (message.image.caption || '').trim();
        const downloaded = await this.downloadMedia(mediaId);

        if (session.state === 'AWAITING_APPROVAL') {
          await this.sendTextMessage(
            from,
            '⚠️ You have a generated meme waiting for approval!\n' +
            '• Reply *Approve* to publish it to Instagram\n' +
            '• Reply *Reset* to discard it and use your new image'
          );
          return;
        }

        if (this.isManualState(session)) {
          await this.handleManualImage(session, from, downloaded, caption);
          return;
        }

        if (session.state === 'AWAITING_SLOT_IMAGE') {
          await this.handleSlotImage(session, from, downloaded);
          return;
        }

        if (session.state === 'IDLE') {
          session.viralDraftId = null;
          session.viralSlots = [];
          session.viralOverrides = [];
          session.viralMissing = [];
          session.referenceImagePath = downloaded.filePath;
          session.referenceMimeType = downloaded.mimeType;

          // If user also attached a punchline caption to the image
          if (caption) {
            session.punchline = caption;
            session.state = 'AWAITING_REACTION';
            await session.save();

            await this.sendTextMessage(
              from,
              `📸 *Reference meme received!* (Caption: "${caption}")\n\n` +
              `Now please send the *Reaction Image* (e.g. reacting actor/character photo).`
            );
          } else {
            session.state = 'AWAITING_REACTION';
            await session.save();

            await this.sendTextMessage(
              from,
              `📸 *Reference meme received!*\n\n` +
              `Now please send the *Reaction Image* (e.g. Brahmanandam, Pawan Kalyan photo).`
            );
          }
          return;
        }

        if (session.state === 'AWAITING_REACTION') {
          session.reactionImagePath = downloaded.filePath;
          session.reactionMimeType = downloaded.mimeType;

          // If punchline was attached to the reaction image or previously set
          if (caption) {
            session.punchline = caption;
          }

          if (session.punchline) {
            session.state = 'GENERATING';
            await session.save();

            await this.sendTextMessage(from, '⏳ *Generating your meme...* Running AI vision analysis & discovering clean subject images. This takes ~30-60s.');
            await this.generateAndSendMeme(session, from);
            return;
          }

          session.state = 'AWAITING_PUNCHLINE';
          await session.save();

          await this.sendTextMessage(
            from,
            `🎭 *Reaction image received!*\n\n` +
            `Now send the *Reacting Text / Punchline* (in Telugu or English) to place on the reaction image.`
          );
          return;
        }

        if (session.state === 'AWAITING_PUNCHLINE') {
          session.reactionImagePath = downloaded.filePath;
          session.reactionMimeType = downloaded.mimeType;

          if (caption) {
            session.punchline = caption;
            session.state = 'GENERATING';
            await session.save();

            await this.sendTextMessage(from, '⏳ *Generating your meme...* Running AI vision analysis & discovering clean subject images. This takes ~30-60s.');
            await this.generateAndSendMeme(session, from);
            return;
          }

          await session.save();
          await this.sendTextMessage(
            from,
            `🎭 *Reaction image updated!*\n\n` +
            `Now send the *Reacting Text / Punchline* to start generating.`
          );
          return;
        }
      } catch (err: any) {
        this.logger.error(`Failed to handle WhatsApp image: ${err?.message || err}`);
        await this.sendTextMessage(from, `❌ Failed to process uploaded image: ${err?.message || 'Download error'}. Please try sending again.`);
      }
    }
  }

  /**
   * Executes the Viral Adaptation pipeline and sends the rendered meme back to the user
   */
  /**
   * Viral flow. The reference is analysed once and the analysis is kept (draft); if internet discovery
   * cannot find a verified picture for a slot, the user is asked to send one and the run continues with
   * that picture instead of failing.
   */
  private async generateAndSendMeme(session: WhatsAppSessionDocument, to: string): Promise<void> {
    try {
      if (!session.referenceImagePath || !session.reactionImagePath || !session.punchline) {
        throw new Error('Missing reference image, reaction image, or punchline');
      }
      this.logger.log(`Starting viral adaptation for WhatsApp user ${to}...`);

      let meme: any;
      for (let attempt = 0; ; attempt++) {
        if (!session.viralDraftId) await this.analyzeReference(session);
        try {
          ({ meme } = await this.viralAdaptation.adapt({
            draftId: session.viralDraftId as string,
            overrides: await this.stageOverrides(session),
            reaction: this.uploadOf(session.reactionImagePath, session.reactionMimeType),
            punchline: session.punchline,
            reactionContext: session.reactionContext || undefined
          }));
          break;
        } catch (err: any) {
          // The saved analysis expires after 30 minutes: analyse again once and retry
          if (err instanceof GoneException && attempt === 0) {
            session.viralDraftId = null;
            continue;
          }
          throw err;
        }
      }

      session.viralDraftId = null;
      session.viralOverrides = [];
      session.viralMissing = [];
      await this.deliverMeme(session, to, meme, session.punchline);
    } catch (err: any) {
      const missing = this.missingSlotsFromError(err, new Set((session.viralOverrides || []).map(o => o.slot)), session);
      if (missing.length) {
        this.logger.warn(`Discovery needs a picture from the user for slot(s) ${missing.join(', ')}: ${err?.message || err}`);
        session.viralMissing = missing;
        session.state = 'AWAITING_SLOT_IMAGE';
        await session.save();
        await this.askForSlotImage(session, to);
        return;
      }
      this.logger.error(`Error in WhatsApp meme generation: ${err?.message || err}`);
      await this.sendTextMessage(
        to,
        `❌ *Generation Failed:*\n${err?.message || 'Internal processing error'}\n\n` +
        `Reply *Reset* to start fresh or try sending your inputs again.`
      );
      session.viralDraftId = null;
      session.viralOverrides = [];
      session.viralMissing = [];
      session.state = 'IDLE';
      await session.save();
    }
  }

  private uploadOf(filePath: string, mimeType: string | null | undefined) {
    const filename = path.basename(filePath);
    return { path: filePath, filename, originalName: filename, mimeType: mimeType || 'image/jpeg' };
  }

  /** Analyses the reference once and remembers its image slots (for the "send me a picture" questions). */
  private async analyzeReference(session: WhatsAppSessionDocument): Promise<void> {
    const draft = await this.viralAdaptation.analyzeDraft(this.uploadOf(session.referenceImagePath as string, session.referenceMimeType));
    const previous = session.viralSlots?.length || 0;
    session.viralDraftId = draft.draftId;
    session.viralSlots = (draft.slots || []).map((s: any) => ({ slot: s.slot, label: s.label || undefined, subject: s.subject || undefined }));
    // A re-analysis that finds a different number of image slots makes earlier slot numbers meaningless
    if (previous && previous !== session.viralSlots.length) session.viralOverrides = [];
    await session.save();
  }

  /** The user's pictures for slots, staged again for this run (staging expires after 15 minutes). */
  private async stageOverrides(session: WhatsAppSessionDocument): Promise<{ slot: number; token: string }[]> {
    const out: { slot: number; token: string }[] = [];
    for (const o of session.viralOverrides || []) {
      const st = await this.selection.stageUpload(o.path, path.basename(o.path));
      out.push({ slot: o.slot, token: st.token });
    }
    return out;
  }

  /** Slots the user must supply a picture for, taken from a discovery or identity failure (empty for any other error). */
  private missingSlotsFromError(err: any, alreadyGiven: Set<number>, session?: WhatsAppSessionDocument): number[] {
    const response = typeof err?.getResponse === 'function' ? err.getResponse() : err?.response;
    const details = response?.details || err?.details;

    // 1. Check structured discovery details
    if (details?.stage === 'discovery') {
      const rawSlot = String(details.failedSlot ?? '');
      const m = /(?:s|slot[ _]?)?(\d+)/i.exec(rawSlot);
      if (m) {
        const slotNum = Number(m[1]);
        if (!alreadyGiven.has(slotNum)) return [slotNum];
      }
    }

    // 2. Check unresolved identity slots
    if (details?.stage === 'identity' && Array.isArray(details.slots)) {
      const unres = details.slots
        .filter((s: any) => s.status !== 'resolved' && !alreadyGiven.has(Number(s.slot)))
        .map((s: any) => Number(s.slot));
      if (unres.length) return unres;
    }

    // 3. Fallback: Parse error message text (e.g. "Could not find a verified portrait of 'Dulquer Salmaan'... for slot 1")
    const msg = String(err?.message || response?.message || '');
    if (/Could not find a verified|unverified image|no image found|failed to find/i.test(msg)) {
      const slotMatch = /(?:for|in)\s+slot\s+(\d+)/i.exec(msg) || /slot\s+(\d+)/i.exec(msg) || /image\s+(\d+)/i.exec(msg);
      if (slotMatch) {
        const slotNum = Number(slotMatch[1]);
        if (!alreadyGiven.has(slotNum)) {
          // Extract subject name from quotes (e.g. "Dulquer Salmaan") to display in prompt
          const subMatch = /of\s+"([^"]+)"/i.exec(msg);
          if (subMatch && subMatch[1] && session) {
            const existing = (session.viralSlots || []).find(s => s.slot === slotNum);
            if (existing) {
              existing.subject = subMatch[1];
            } else {
              session.viralSlots = [...(session.viralSlots || []), { slot: slotNum, subject: subMatch[1] }];
            }
          }
          return [slotNum];
        }
      }
    }

    return [];
  }

  private async askForSlotImage(session: WhatsAppSessionDocument, to: string, reminder = false): Promise<void> {
    const slot = session.viralMissing?.[0];
    const info = (session.viralSlots || []).find(s => s.slot === slot);
    const subjectName = info?.subject || (info?.label && info.label !== info?.subject ? info.label : undefined);
    const targetDesc = subjectName ? `"${subjectName}" (Image ${slot})` : `Image ${slot}`;

    await this.sendTextMessage(
      to,
      (reminder ? '' : `🔍 *Could not find a verified photo online for ${targetDesc}.*\n\n`) +
      `📸 *Please send a photo of ${subjectName ? `"${subjectName}"` : `Image ${slot}`}* right here in this chat, and I will use it to complete your meme!\n\n` +
      ((session.viralMissing?.length || 0) > 1 ? `_(${session.viralMissing.length} pictures needed in total)_\n\n` : '') +
      `Reply *Reset* to start fresh anytime.`
    );
  }

  private async handleSlotImage(
    session: WhatsAppSessionDocument,
    from: string,
    downloaded: { filePath: string }
  ): Promise<void> {
    const slot = session.viralMissing?.[0];
    if (!slot) {
      session.state = 'IDLE';
      await session.save();
      return;
    }
    try {
      // Same checks as a picture chosen in the web app (real image, size limits, decodes)
      const staged = await this.selection.stageUpload(downloaded.filePath, path.basename(downloaded.filePath));
      this.selection.discard(staged.token);
    } catch (err: any) {
      await this.sendTextMessage(from, `⚠️ That picture cannot be used: ${err?.message || 'invalid image'}\nPlease send another one for image ${slot}.`);
      return;
    }
    session.viralOverrides = [...(session.viralOverrides || []).filter(o => o.slot !== slot), { slot, path: downloaded.filePath }];
    session.viralMissing = (session.viralMissing || []).slice(1);
    if (session.viralMissing.length) {
      await session.save();
      await this.sendTextMessage(from, `✅ Picture for image ${slot} saved.`);
      await this.askForSlotImage(session, from);
      return;
    }
    session.state = 'GENERATING';
    await session.save();
    await this.sendTextMessage(from, `✅ Got it. Continuing with your picture... this takes about 30 seconds.`);
    await this.generateAndSendMeme(session, from);
  }

  /** Sends the rendered meme to the user for review and moves the session to AWAITING_APPROVAL. */
  private async deliverMeme(session: WhatsAppSessionDocument, to: string, meme: any, punchlineText: string): Promise<void> {
    // Construct public HTTPS image URL for Meta WhatsApp
    const relativeImageUrl = meme.outputUrls?.jpeg || meme.outputUrls?.png;
    const publicBase = getConfig().instagram.publicBaseUrl;
    const publicImageUrl = relativeImageUrl
      ? `${publicBase}${relativeImageUrl}`
      : `${publicBase}/output/${meme.memeId}.jpeg`;

    this.logger.log(`Generated meme public URL for WhatsApp: ${publicImageUrl}`);

    const headline = meme.content?.headline || '';
    const punchline = punchlineText;

    const previewCaption =
      `🎭 *Meme Ready for Review!*\n\n` +
      (headline ? `📌 *Headline*: ${headline}\n` : '') +
      `💬 *Punchline*: ${punchline}\n\n` +
      `Reply:\n` +
      `👉 *Approve* — Publish to Instagram (@kanyaraasi_memes)\n` +
      `👉 *Reset* — Discard this meme`;

    // Send image preview to user
    const sent = await this.sendImageMessage(to, publicImageUrl, previewCaption);
    if (!sent) {
      // Fallback to text with link if image send fails
      await this.sendTextMessage(to, `🎭 *Meme Ready!*\nView image: ${publicImageUrl}\n\n${previewCaption}`);
    }

    session.state = 'AWAITING_APPROVAL';
    session.lastGeneratedMemeId = meme.memeId || (meme._id ? meme._id.toString() : null);
    session.lastGeneratedImageUrl = publicImageUrl;
    session.lastGeneratedCaption = punchline;
    await session.save();

    this.logger.log(`Generated meme ${session.lastGeneratedMemeId} delivered to WhatsApp user ${to}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Manual (own edit) flow: layout -> headline -> statement -> subject images (+labels) -> reaction -> punchline
  // ---------------------------------------------------------------------------------------------

  private static readonly MANUAL_TYPES = ['trending_news', 'facts_collage', 'comparison', 'movie_update', 'custom'] as const;
  private static readonly MAX_MANUAL_SUBJECTS = 10;

  private isManualState(session: WhatsAppSessionDocument): boolean {
    return session.mode === 'manual' && typeof session.state === 'string' && session.state.startsWith('MANUAL_');
  }

  private manualTypePrompt(): string {
    return (
      `✏️ *Manual meme*\n\n` +
      `Pick a layout (send the number):\n` +
      `1️⃣ News / update (default)\n` +
      `2️⃣ Facts collage\n` +
      `3️⃣ Comparison\n` +
      `4️⃣ Movie update\n` +
      `5️⃣ Custom\n\n` +
      `Send *skip* for the default. *Reset* cancels anytime.`
    );
  }

  private isSkip(text: string): boolean {
    return ['skip', 'none', 'no', '-'].includes(text.trim().toLowerCase());
  }

  private async handleManualText(session: WhatsAppSessionDocument, from: string, text: string): Promise<void> {
    switch (session.state) {
      case 'MANUAL_TYPE': {
        const n = Number(text.trim());
        if (this.isSkip(text)) session.manualMemeType = WhatsAppService.MANUAL_TYPES[0];
        else if (Number.isInteger(n) && n >= 1 && n <= WhatsAppService.MANUAL_TYPES.length) session.manualMemeType = WhatsAppService.MANUAL_TYPES[n - 1];
        else {
          await this.sendTextMessage(from, 'Please send a number from 1 to 5, or *skip*.');
          return;
        }
        session.state = 'MANUAL_HEADLINE';
        await session.save();
        await this.sendTextMessage(from, `📌 Send the *headline* for the top banner (or *skip*).`);
        return;
      }
      case 'MANUAL_HEADLINE':
        session.manualHeadline = this.isSkip(text) ? null : text;
        session.state = 'MANUAL_STATEMENT';
        await session.save();
        await this.sendTextMessage(from, `📝 Send the *statement / news text* (or *skip*).`);
        return;
      case 'MANUAL_STATEMENT':
        session.manualStatement = this.isSkip(text) ? null : text;
        session.state = 'MANUAL_SUBJECTS';
        await session.save();
        await this.sendTextMessage(
          from,
          `🖼️ Now send the *subject images* one by one (up to ${WhatsAppService.MAX_MANUAL_SUBJECTS}).\n` +
          `Add a *caption* to an image to use it as its label.\n` +
          `Send *done* when all subject images are in.`
        );
        return;
      case 'MANUAL_SUBJECTS': {
        if (['done', 'next', 'finish'].includes(text.trim().toLowerCase())) {
          if (!session.manualSubjects?.length) {
            await this.sendTextMessage(from, 'Please send at least one subject image first.');
            return;
          }
          session.state = 'MANUAL_REACTION';
          await session.save();
          await this.sendTextMessage(from, `🎭 ${session.manualSubjects.length} subject image(s) saved. Now send the *reaction image* (a caption becomes the punchline).`);
          return;
        }
        await this.sendTextMessage(from, 'Send a subject image, or *done* when you have sent them all.');
        return;
      }
      case 'MANUAL_REACTION':
        await this.sendTextMessage(from, 'Please send the *reaction image*.');
        return;
      case 'MANUAL_PUNCHLINE':
        session.punchline = text;
        await this.generateManualMeme(session, from);
        return;
    }
  }

  private async handleManualImage(
    session: WhatsAppSessionDocument,
    from: string,
    downloaded: { filePath: string; mimeType: string },
    caption: string
  ): Promise<void> {
    if (session.state === 'MANUAL_SUBJECTS') {
      if ((session.manualSubjects?.length || 0) >= WhatsAppService.MAX_MANUAL_SUBJECTS) {
        await this.sendTextMessage(from, `Maximum of ${WhatsAppService.MAX_MANUAL_SUBJECTS} subject images reached. Send *done*.`);
        return;
      }
      // Atomic push: several images can arrive in parallel webhooks.
      const updated = await this.sessionModel.findOneAndUpdate(
        { phoneNumber: from },
        { $push: { manualSubjects: { path: downloaded.filePath, mimeType: downloaded.mimeType, label: caption || undefined } } },
        { new: true }
      );
      const n = updated?.manualSubjects?.length || 0;
      await this.sendTextMessage(from, `✅ Subject ${n} added${caption ? ` (label: "${caption}")` : ''}. Send more, or *done*.`);
      return;
    }

    if (session.state === 'MANUAL_REACTION' || session.state === 'MANUAL_PUNCHLINE') {
      session.reactionImagePath = downloaded.filePath;
      session.reactionMimeType = downloaded.mimeType;
      if (caption) {
        session.punchline = caption;
        await this.generateManualMeme(session, from);
        return;
      }
      session.state = 'MANUAL_PUNCHLINE';
      await session.save();
      await this.sendTextMessage(from, `🎭 Reaction image received! Now send the *punchline* text.`);
      return;
    }

    await this.sendTextMessage(from, 'I was expecting text here. Send the requested text, or *Reset* to cancel.');
  }

  private async generateManualMeme(session: WhatsAppSessionDocument, to: string): Promise<void> {
    session.state = 'GENERATING';
    await session.save();
    await this.sendTextMessage(to, '⏳ *Generating your meme...*');
    try {
      const subjects = session.manualSubjects || [];
      if (!subjects.length || !session.reactionImagePath || !session.punchline) {
        throw new Error('Missing subject images, reaction image or punchline');
      }
      // Same validation/limits as the web form's upload-and-generate endpoint.
      const memeType = session.manualMemeType || 'trending_news';
      const labels = subjects.map(s => (s.label || '').trim());
      const { content, design, layout } = validateUploadPayload(
        JSON.stringify({
          content: {
            topic: session.manualHeadline || session.manualStatement || 'WhatsApp meme',
            headline: session.manualHeadline || undefined,
            statement: session.manualStatement || undefined,
            punchline: session.punchline,
            itemLabels: labels
          },
          layout: { memeType, arrangement: 'auto' },
          subjectLabels: labels
        })
      );

      const subjectImages: UploadedAsset[] = subjects.map((s, idx) => ({
        id: randomUUID(),
        originalName: path.basename(s.path),
        filename: path.basename(s.path),
        path: s.path,
        mimeType: s.mimeType || 'image/jpeg',
        role: idx === 0 ? 'subject_primary' : idx === 1 ? 'subject_secondary' : 'subject_item',
        orderIndex: idx,
        label: labels[idx] || undefined
      }));
      const reactionImage: UploadedAsset = {
        id: randomUUID(),
        originalName: path.basename(session.reactionImagePath),
        filename: path.basename(session.reactionImagePath),
        path: session.reactionImagePath,
        mimeType: session.reactionMimeType || 'image/jpeg',
        role: 'reaction_punchline',
        orderIndex: 99
      };

      const meme = await this.memeEngine.generateMeme({ content, assets: { subjectImages, reactionImage }, design, layout });
      await this.deliverMeme(session, to, meme, session.punchline);
    } catch (err: any) {
      this.logger.error(`Error in WhatsApp manual meme generation: ${err?.message || err}`);
      await this.sendTextMessage(
        to,
        `❌ *Generation Failed:*\n${err?.message || 'Internal processing error'}\n\nSend *Manual* to try again.`
      );
      await this.resetSession(session);
    }
  }

  private async resetSession(session: WhatsAppSessionDocument): Promise<void> {
    session.state = 'IDLE';
    session.referenceImagePath = null;
    session.referenceMimeType = null;
    session.reactionImagePath = null;
    session.reactionMimeType = null;
    session.punchline = null;
    session.reactionContext = null;
    session.mode = 'viral';
    session.viralDraftId = null;
    session.viralSlots = [];
    session.viralOverrides = [];
    session.viralMissing = [];
    session.manualMemeType = null;
    session.manualHeadline = null;
    session.manualStatement = null;
    session.manualSubjects = [];
    session.lastGeneratedMemeId = null;
    session.lastGeneratedImageUrl = null;
    session.lastGeneratedCaption = null;
    await session.save();
  }
}
