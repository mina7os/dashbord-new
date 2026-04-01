/**
 * supabase-server.ts
 * Server-only Supabase client using the secret/service key.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// --- Global Client Cache ---
let _client: SupabaseClient | null = null;

/**
 * Returns the hardened Supabase Admin client.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client;

  const clean = (s?: string) => s?.replace(/['"]/g, '').trim() || '';
  const url = clean(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL);
  const key = clean(
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY
  );

  if (!url || !key) {
    console.error('[Supabase Server] Critical: Missing URL or Key.');
  }

  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    // Use Node.js native fetch (available in Node v18+)
    global: { fetch: fetch as any }
  });

  return _client;
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get: (_target, prop) => {
    const client = getSupabaseAdmin();
    const val = (client as any)[prop];
    return typeof val === 'function' ? val.bind(client) : val;
  }
});
