import { createClient } from '@supabase/supabase-js';

declare global {
  interface Window {
    __APP_CONFIG__?: {
      supabaseUrl?: string;
      supabaseAnonKey?: string;
    };
  }
}

const runtimeConfig =
  typeof window !== 'undefined' && window.__APP_CONFIG__ ? window.__APP_CONFIG__ : undefined;

const supabaseUrl =
  runtimeConfig?.supabaseUrl || ((import.meta as any).env.VITE_SUPABASE_URL as string | undefined);
const supabaseAnonKey =
  runtimeConfig?.supabaseAnonKey ||
  ((import.meta as any).env.VITE_SUPABASE_ANON_KEY as string | undefined);

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('[Supabase] Missing public config. Check /api/public-config or Vite envs.');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');
export default supabase;
