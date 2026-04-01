import { supabaseAdmin } from '../lib/supabase-server.ts';

export interface ValidationResult {
  passed: boolean;
  checked: string;
  error?: string;
  critical: boolean;
}

export async function validateInfrastructure(): Promise<{ success: boolean; results: ValidationResult[] }> {
  const results: ValidationResult[] = [];
  const resolvedEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY:
      (process.env.VITE_SUPABASE_PUBLISHABLE_KEY && process.env.VITE_SUPABASE_PUBLISHABLE_KEY !== '...')
        ? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
        : ((process.env.VITE_SUPABASE_ANON_KEY && process.env.VITE_SUPABASE_ANON_KEY !== '...')
        ? process.env.VITE_SUPABASE_ANON_KEY
        : (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY))
  };

  // 1. Critical Environment Variables
  const requiredEnvs = [
    'GEMINI_API_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY'
  ];

  for (const env of requiredEnvs) {
    if (!resolvedEnv[env as keyof typeof resolvedEnv]) {
      results.push({ passed: false, checked: `ENV: ${env}`, error: 'Missing from .env', critical: true });
    } else {
      results.push({ passed: true, checked: `ENV: ${env}`, critical: true });
    }
  }

  // 2. Supabase Connectivity & Tables
  const tables = [
    'incoming_messages',
    'transactions',
    'review_queue',
    'dashboard_metrics',
    'user_integrations',
    'whatsapp_connected_chats'
  ];

  try {
    const { error: connectionError } = await supabaseAdmin.from('user_integrations').select('user_id').limit(1);
    if (connectionError) throw connectionError;
    
    for (const table of tables) {
      const { error } = await supabaseAdmin.from(table).select('*').limit(1);
      if (error && error.code !== 'PGRST116') { // PGRST116 is 'No rows returned' which is fine
        results.push({ passed: false, checked: `Table: ${table}`, error: error.message, critical: true });
      } else {
        results.push({ passed: true, checked: `Table: ${table}`, critical: true });
      }
    }
  } catch (err: any) {
    results.push({ passed: false, checked: 'Supabase Connection', error: err.message, critical: true });
  }

  const supabaseHealthy = !results.some(r => r.checked === 'Supabase Connection' && !r.passed);

  // 3. Required RPCs
  const rpcs: Array<{ name: string; args: Record<string, any> }> = [
    {
      name: 'claim_messages',
      args: { p_user_id: '00000000-0000-0000-0000-000000000000', p_limit: 1 }
    },
    {
      name: 'increment_dashboard_metric',
      args: {
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_date: new Date().toISOString().split('T')[0],
        p_column: 'test_metric',
        p_delta: 0
      }
    },
    {
      name: 'increment_daily_metrics',
      args: {
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_date: new Date().toISOString().split('T')[0],
        p_amount: 0,
        p_tx_count: 0
      }
    }
  ];

  for (const rpc of rpcs) {
    if (!supabaseHealthy) {
      results.push({ passed: false, checked: `RPC: ${rpc.name}`, error: 'Skipped because Supabase connection is unhealthy', critical: true });
      continue;
    }

    const { error } = await supabaseAdmin.rpc(rpc.name, rpc.args);
    
    // PGRST204 is function not found, 22P02 is invalid text representation (uuid), 23503 is foreign_key_violation
    if (error && error.code !== '23503' && error.code !== '22P02') {
      results.push({ passed: false, checked: `RPC: ${rpc.name}`, error: `${error.code}: ${error.message}`, critical: true });
    } else {
      results.push({ passed: true, checked: `RPC: ${rpc.name}`, critical: true });
    }
  }

  // 4. Storage Bucket
  const { error: bucketError } = await supabaseAdmin.storage.getBucket('receipts');
  if (bucketError) {
    results.push({ passed: false, checked: 'Storage: receipts', error: bucketError.message, critical: true });
  } else {
    results.push({ passed: true, checked: 'Storage: receipts', critical: true });
  }

  const success = !results.some(r => r.critical && !r.passed);

  console.log('\n─── Infrastructure Health Report ───');
  results.forEach(r => {
    const icon = r.passed ? '✅' : '❌';
    console.log(`${icon} ${r.checked}${r.error ? ` [Error: ${r.error}]` : ''}`);
  });
  console.log('──────────────────────────────────\n');

  return { success, results };
}
