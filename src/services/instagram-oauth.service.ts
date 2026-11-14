import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { getConfig } from '../config/app-config';
import { InstagramAccount, InstagramAccountDocument } from '../schemas/instagram-account.schema';
import { InstagramTokenService } from './instagram-token.service';

export interface SanitizedInstagramAccount {
  connected: boolean;
  account?: {
    instagramUserId: string;
    username: string;
    name?: string;
    profilePictureUrl?: string;
    facebookPageName?: string;
    status: string;
    scopes: string[];
    connectedAt: Date;
    tokenExpiresAt?: Date;
    daysUntilExpiration?: number;
    isExpired?: boolean;
  };
  metaConfigured: boolean;
  missingSecret: boolean;
}

@Injectable()
export class InstagramOAuthService {
  private readonly logger = new Logger(InstagramOAuthService.name);
  private readonly activeStates = new Map<string, number>();

  constructor(
    @InjectModel(InstagramAccount.name)
    private readonly instagramAccountModel: Model<InstagramAccountDocument>,
    private readonly tokenService: InstagramTokenService
  ) {
    // Prune expired CSRF states every 5 minutes
    setInterval(() => this.pruneExpiredStates(), 5 * 60 * 1000).unref();
  }

  private pruneExpiredStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.activeStates.entries()) {
      if (now > expiresAt) {
        this.activeStates.delete(state);
      }
    }
  }

  /**
   * Generates a CSRF-protected Meta OAuth authorization URL.
   */
  generateAuthUrl(): { url: string; state: string } {
    const cfg = getConfig().instagram;
    if (!cfg.metaAppId || !cfg.loginConfigId || !cfg.redirectUri) {
      throw new InternalServerErrorException('Meta Instagram OAuth configuration is incomplete in .env.');
    }

    const state = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minute validity
    this.activeStates.set(state, expiresAt);

    const params = new URLSearchParams({
      client_id: cfg.metaAppId,
      config_id: cfg.loginConfigId,
      redirect_uri: cfg.redirectUri,
      response_type: 'code',
      state
    });

    const url = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
    return { url, state };
  }

  /**
   * Validates state nonce to prevent CSRF.
   */
  validateState(state: string): boolean {
    if (!state) return false;
    const expiresAt = this.activeStates.get(state);
    if (!expiresAt) return false;
    this.activeStates.delete(state);
    return Date.now() <= expiresAt;
  }

  /**
   * Handles the complete OAuth callback: code exchange, long-lived token exchange, profile retrieval,
   * and secure database storage.
   */
  async handleCallback(code: string, state: string): Promise<{ username: string; instagramUserId: string }> {
    if (!this.validateState(state)) {
      throw new BadRequestException('Invalid or expired OAuth state parameter (CSRF protection failed).');
    }

    const cfg = getConfig().instagram;
    if (!cfg.metaAppSecret) {
      throw new BadRequestException('META_APP_SECRET is not configured in backend .env. Please add it to complete authentication.');
    }

    // 1. Exchange authorization code for short-lived access token
    this.logger.log('Exchanging authorization code with Meta Graph API...');
    const shortTokenRes = await this.exchangeCodeForToken(code, cfg);

    // 2. Exchange for 60-day long-lived token
    this.logger.log('Exchanging for 60-day long-lived access token...');
    const longTokenRes = await this.exchangeForLongLivedToken(shortTokenRes.access_token, cfg);
    const finalUserToken = longTokenRes.access_token;
    const expiresInSeconds = longTokenRes.expires_in || shortTokenRes.expires_in || 60 * 24 * 3600;
    const tokenExpiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // 3. Find connected Instagram Business / Creator account
    this.logger.log('Retrieving linked Instagram Business account profile...');
    const igProfile = await this.discoverInstagramAccount(finalUserToken, cfg.targetUsername);

    // 4. Encrypt tokens at rest
    const encryptedUserToken = this.tokenService.encrypt(finalUserToken);
    let encryptedPageToken: { cipherText: string; iv: string; tag: string } | undefined;
    if (igProfile.pageAccessToken) {
      encryptedPageToken = this.tokenService.encrypt(igProfile.pageAccessToken);
    }

    // 5. Store / Upsert in MongoDB
    await this.instagramAccountModel.findOneAndUpdate(
      { instagramUserId: igProfile.instagramUserId },
      {
        instagramUserId: igProfile.instagramUserId,
        username: igProfile.username,
        name: igProfile.name || igProfile.username,
        profilePictureUrl: igProfile.profilePictureUrl,
        facebookPageId: igProfile.pageId,
        facebookPageName: igProfile.pageName,
        encryptedAccessToken: encryptedUserToken.cipherText,
        iv: encryptedUserToken.iv,
        tag: encryptedUserToken.tag,
        encryptedPageAccessToken: encryptedPageToken?.cipherText,
        pageIv: encryptedPageToken?.iv,
        pageTag: encryptedPageToken?.tag,
        tokenType: longTokenRes.token_type || 'Bearer',
        tokenExpiresAt,
        scopes: ['instagram_basic', 'instagram_content_publish'],
        status: 'connected',
        connectedAt: new Date(),
        lastCheckedAt: new Date(),
        lastError: undefined
      },
      { upsert: true, new: true }
    );

    this.logger.log(`Successfully connected Instagram account @${igProfile.username} (${igProfile.instagramUserId})`);
    return {
      username: igProfile.username,
      instagramUserId: igProfile.instagramUserId
    };
  }

  private async exchangeCodeForToken(code: string, cfg: ReturnType<typeof getConfig>['instagram']): Promise<{ access_token: string; token_type: string; expires_in?: number }> {
    const params = new URLSearchParams({
      client_id: cfg.metaAppId,
      client_secret: cfg.metaAppSecret || '',
      redirect_uri: cfg.redirectUri,
      code
    });

    const url = `https://graph.facebook.com/v21.0/oauth/access_token?${params.toString()}`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      const msg = data.error?.message || `Meta OAuth token exchange failed with status ${res.status}`;
      this.logger.error(`Meta token exchange error: ${msg}`);
      throw new BadRequestException(msg);
    }

    return data;
  }

  private async exchangeForLongLivedToken(shortToken: string, cfg: ReturnType<typeof getConfig>['instagram']): Promise<{ access_token: string; token_type: string; expires_in?: number }> {
    const params = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: cfg.metaAppId,
      client_secret: cfg.metaAppSecret || '',
      fb_exchange_token: shortToken
    });

    const url = `https://graph.facebook.com/v21.0/oauth/access_token?${params.toString()}`;
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      this.logger.warn(`Could not exchange for long-lived token, falling back to original token: ${data.error?.message || res.statusText}`);
      return { access_token: shortToken, token_type: 'Bearer' };
    }

    return data;
  }

  private async discoverInstagramAccount(
    accessToken: string,
    targetUsername: string
  ): Promise<{
    instagramUserId: string;
    username: string;
    name?: string;
    profilePictureUrl?: string;
    pageId?: string;
    pageName?: string;
    pageAccessToken?: string;
  }> {
    const cfg = getConfig().instagram;
    const candidates: Array<{
      instagramUserId: string;
      username: string;
      name?: string;
      profilePictureUrl?: string;
      pageId?: string;
      pageName?: string;
      pageAccessToken?: string;
      source: string;
    }> = [];

    const fetchIgProfileDetails = async (igUserId: string, token: string) => {
      try {
        const url = `https://graph.facebook.com/v21.0/${igUserId}?fields=id,username,name,profile_picture_url&access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.id && data.username) {
          return {
            id: String(data.id),
            username: String(data.username),
            name: data.name,
            profilePictureUrl: data.profile_picture_url
          };
        }
      } catch (err: any) {
        this.logger.warn(`Could not fetch details for IG user ${igUserId}: ${err.message}`);
      }
      return null;
    };

    // Strategy 1: Check /me/assigned_instagram_accounts (Primary for Facebook Login for Business / Unified Login)
    try {
      this.logger.log('Discovery Strategy 1: Checking /me/assigned_instagram_accounts...');
      const assignedUrl = `https://graph.facebook.com/v21.0/me/assigned_instagram_accounts?fields=id,username,name,profile_picture_url&access_token=${encodeURIComponent(accessToken)}`;
      const assignedRes = await fetch(assignedUrl);
      const assignedData = await assignedRes.json().catch(() => ({}));

      if (assignedRes.ok && Array.isArray(assignedData.data) && assignedData.data.length > 0) {
        this.logger.log(`Found ${assignedData.data.length} assigned Instagram account(s) via /me/assigned_instagram_accounts.`);
        for (const item of assignedData.data) {
          if (item.id) {
            candidates.push({
              instagramUserId: String(item.id),
              username: item.username || targetUsername,
              name: item.name,
              profilePictureUrl: item.profile_picture_url,
              source: 'assigned_instagram_accounts'
            });
          }
        }
      } else {
        this.logger.log(`Strategy 1: /me/assigned_instagram_accounts returned ${assignedData.data ? assignedData.data.length : 'no'} items.`);
      }
    } catch (err: any) {
      this.logger.warn(`Strategy 1 (assigned_instagram_accounts) notice: ${err.message}`);
    }

    // Strategy 2: Check /debug_token granular_scopes (Inspects which IG accounts the user authorized during OAuth)
    if (cfg.metaAppId && cfg.metaAppSecret) {
      try {
        this.logger.log('Discovery Strategy 2: Checking /debug_token granular_scopes...');
        const appToken = `${cfg.metaAppId}|${cfg.metaAppSecret}`;
        const debugUrl = `https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appToken)}`;
        const debugRes = await fetch(debugUrl);
        const debugData = await debugRes.json().catch(() => ({}));

        if (debugRes.ok && debugData.data) {
          const granularScopes = debugData.data.granular_scopes || [];
          this.logger.log(`debug_token returned ${granularScopes.length} granular scope(s).`);
          const targetIds = new Set<string>();

          for (const gs of granularScopes) {
            if (Array.isArray(gs.target_ids)) {
              for (const tid of gs.target_ids) {
                targetIds.add(String(tid));
              }
            }
          }

          for (const tid of targetIds) {
            if (!candidates.some(c => c.instagramUserId === tid)) {
              this.logger.log(`Fetching profile for target_id from granular_scopes: ${tid}...`);
              const profile = await fetchIgProfileDetails(tid, accessToken);
              if (profile) {
                candidates.push({
                  instagramUserId: profile.id,
                  username: profile.username,
                  name: profile.name,
                  profilePictureUrl: profile.profilePictureUrl,
                  source: 'debug_token_granular_scopes'
                });
              }
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(`Strategy 2 (debug_token) notice: ${err.message}`);
      }
    }

    // Strategy 3: Check /me/accounts (Facebook Pages with linked Instagram Business accounts)
    try {
      this.logger.log('Discovery Strategy 3: Checking /me/accounts...');
      const pagesUrl = `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,profile_picture_url},connected_instagram_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(accessToken)}`;
      const pagesRes = await fetch(pagesUrl);
      const pagesData = await pagesRes.json().catch(() => ({}));

      if (pagesRes.ok && Array.isArray(pagesData.data) && pagesData.data.length > 0) {
        this.logger.log(`Found ${pagesData.data.length} Facebook page(s). Checking for linked Instagram accounts...`);
        for (const page of pagesData.data) {
          const ig = page.instagram_business_account || page.connected_instagram_account;
          if (ig && ig.id) {
            candidates.push({
              instagramUserId: String(ig.id),
              username: ig.username || targetUsername,
              name: ig.name,
              profilePictureUrl: ig.profile_picture_url,
              pageId: page.id,
              pageName: page.name,
              pageAccessToken: page.access_token,
              source: 'facebook_page_linked_account'
            });
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Strategy 3 (me/accounts) notice: ${err.message}`);
    }

    // Strategy 4: Check graph.instagram.com/me (Direct Instagram Login)
    try {
      this.logger.log('Discovery Strategy 4: Checking graph.instagram.com/me...');
      const igMeUrl = `https://graph.instagram.com/v21.0/me?fields=id,username,name,profile_picture_url,account_type&access_token=${encodeURIComponent(accessToken)}`;
      const igMeRes = await fetch(igMeUrl);
      const igMeData = await igMeRes.json().catch(() => ({}));

      if (igMeRes.ok && igMeData.id) {
        this.logger.log(`Found direct Instagram user: @${igMeData.username} (${igMeData.id})`);
        candidates.push({
          instagramUserId: String(igMeData.id),
          username: igMeData.username || targetUsername,
          name: igMeData.name,
          profilePictureUrl: igMeData.profile_picture_url,
          source: 'instagram_direct_login'
        });
      }
    } catch (err: any) {
      this.logger.warn(`Strategy 4 (graph.instagram.com/me) notice: ${err.message}`);
    }

    // Strategy 5: Check graph.facebook.com/me (Safe fields: id, name - NO username)
    if (candidates.length === 0) {
      try {
        this.logger.log('Discovery Strategy 5: Checking graph.facebook.com/me (safe fields)...');
        const fbMeUrl = `https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`;
        const fbMeRes = await fetch(fbMeUrl);
        const fbMeData = await fbMeRes.json().catch(() => ({}));

        if (fbMeRes.ok && fbMeData.id) {
          const profile = await fetchIgProfileDetails(fbMeData.id, accessToken);
          if (profile) {
            candidates.push({
              instagramUserId: profile.id,
              username: profile.username,
              name: profile.name,
              profilePictureUrl: profile.profilePictureUrl,
              source: 'facebook_me_direct'
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(`Strategy 5 (facebook/me) notice: ${err.message}`);
      }
    }

    if (candidates.length > 0) {
      this.logger.log(`Discovered ${candidates.length} candidate Instagram account(s): ${candidates.map(c => `@${c.username} (${c.instagramUserId}) via ${c.source}`).join(', ')}`);

      // If target username matches, pick that one; otherwise pick the first available
      const cleanTarget = targetUsername.toLowerCase().replace(/^@/, '');
      const matched = candidates.find(
        c => c.username?.toLowerCase() === cleanTarget
      ) || candidates[0];

      return {
        instagramUserId: matched.instagramUserId,
        username: matched.username,
        name: matched.name,
        profilePictureUrl: matched.profilePictureUrl,
        pageId: matched.pageId,
        pageName: matched.pageName,
        pageAccessToken: matched.pageAccessToken
      };
    }

    throw new BadRequestException(
      `No connected Instagram Business or Creator account found for your Meta login. Please ensure your Instagram account (@${targetUsername}) was selected in the Meta permissions dialog and is a Professional (Creator or Business) account.`
    );
  }

  /**
   * Retrieves sanitized account details for frontend presentation. Never returns secrets or tokens.
   */
  async getSanitizedAccount(): Promise<SanitizedInstagramAccount> {
    const cfg = getConfig().instagram;
    const metaConfigured = Boolean(cfg.metaAppId && cfg.loginConfigId && cfg.redirectUri);
    const missingSecret = !cfg.metaAppSecret;

    const account = await this.instagramAccountModel
      .findOne({ status: 'connected' })
      .sort({ updatedAt: -1 })
      .exec();

    if (!account) {
      return {
        connected: false,
        metaConfigured,
        missingSecret
      };
    }

    const now = Date.now();
    const tokenExpiresAt = account.tokenExpiresAt;
    let daysUntilExpiration: number | undefined;
    let isExpired = false;

    if (tokenExpiresAt) {
      const diffMs = tokenExpiresAt.getTime() - now;
      daysUntilExpiration = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      isExpired = diffMs <= 0;
    }

    return {
      connected: true,
      metaConfigured,
      missingSecret,
      account: {
        instagramUserId: account.instagramUserId,
        username: account.username,
        name: account.name,
        profilePictureUrl: account.profilePictureUrl,
        facebookPageName: account.facebookPageName,
        status: isExpired ? 'expired' : account.status,
        scopes: account.scopes || [],
        connectedAt: account.connectedAt,
        tokenExpiresAt: account.tokenExpiresAt,
        daysUntilExpiration,
        isExpired
      }
    };
  }

  /**
   * Disconnects the active Instagram account.
   */
  async disconnect(): Promise<{ disconnected: boolean }> {
    await this.instagramAccountModel.updateMany(
      { status: 'connected' },
      {
        $set: {
          status: 'disconnected',
          encryptedAccessToken: '',
          iv: '',
          tag: '',
          encryptedPageAccessToken: undefined,
          pageIv: undefined,
          pageTag: undefined
        }
      }
    );
    this.logger.log('Disconnected Instagram account.');
    return { disconnected: true };
  }

  /**
   * Internal helper for publishing service to get decrypted token.
   */
  async getDecryptedTokenForPublishing(): Promise<{
    instagramUserId: string;
    accessToken: string;
    username: string;
  } | null> {
    const account = await this.instagramAccountModel
      .findOne({ status: 'connected' })
      .sort({ updatedAt: -1 })
      .exec();

    if (!account) return null;

    // Use page access token if available, otherwise user access token
    let token: string;
    if (account.encryptedPageAccessToken && account.pageIv && account.pageTag) {
      token = this.tokenService.decrypt({
        cipherText: account.encryptedPageAccessToken,
        iv: account.pageIv,
        tag: account.pageTag
      });
    } else {
      token = this.tokenService.decrypt({
        cipherText: account.encryptedAccessToken,
        iv: account.iv,
        tag: account.tag
      });
    }

    return {
      instagramUserId: account.instagramUserId,
      accessToken: token,
      username: account.username
    };
  }
}

