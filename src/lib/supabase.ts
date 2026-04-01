/**
 * supabase.ts — Browser-only Supabase client.
 * Uses VITE_ prefixed environment variables (injected at build time).
 * NEVER use this in server code — use supabase-server.ts instead.
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta as any).env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = (import.meta as any).env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'Check your .env file and restart.'
  );
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');
export default supabase;
