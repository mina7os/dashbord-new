/**
 * google-auth.ts
 * Shared Google OAuth2 helper that automatically refreshes expired access tokens.
 * All services (sheets.ts, google-setup.ts) should use this.
 */
import { google } from 'googleapis';
import { supabaseAdmin } from './supabase-server';

export interface GoogleTokens {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date?: number;
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

/**
 * Returns a configured OAuth2 client with a valid (auto-refreshed) access token.
 * Persists the refreshed token back to Supabase if refreshed.
 */
export async function getAuthenticatedClient(userId: string, tokens: GoogleTokens) {
  // Use public client_id/secret if available, otherwise rely on token-only mode
  const oauth2Client = GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
    ? new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
    : new google.auth.OAuth2();

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  // Auto-refresh if expired or expiring within 5 minutes
  const now = Date.now();
  const expiresIn = (tokens.expiry_date || 0) - now;
  if (expiresIn < 5 * 60 * 1000) {
    try {
      console.log(`[GoogleAuth] Token for user ${userId} is expired/expiring — refreshing...`);
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);

      // Persist refreshed tokens back to Supabase
      const updatedTokens: GoogleTokens = {
        access_token: credentials.access_token || null,
        refresh_token: credentials.refresh_token || tokens.refresh_token,
        expiry_date: credentials.expiry_date || undefined,
      };

      await supabaseAdmin
        .from('user_integrations')
        .update({ google_tokens: updatedTokens, updated_at: new Date().toISOString() })
        .eq('user_id', userId);

      console.log(`[GoogleAuth] Token refreshed and persisted for user ${userId}`);
    } catch (err) {
      console.error(`[GoogleAuth] Token refresh failed for user ${userId}:`, err);
      // Continue with existing credentials — might still work if not fully expired
    }
  }

  return oauth2Client;
}
