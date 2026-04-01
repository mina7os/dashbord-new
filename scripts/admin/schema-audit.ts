/**
 * schema_audit.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function run() {
  console.log('--- RPC DEFINITIONS ---');
  const rpcs = ['claim_messages', 'increment_dashboard_metric', 'increment_daily_metrics'];
  for (const rpc of rpcs) {
    const { data: rawDef, error: rawError } = await supabase.from('pg_proc').select('proname, prosrc').eq('proname', rpc);
    if (!rawError && rawDef && rawDef.length > 0) {
       console.log(`\n[${rpc}] Definition found.`);
    } else {
       console.log(`\n[${rpc}] could not fetch definition or missing.`);
    }
  }

  console.log('\n--- TABLE CONSTRAINTS ---');
  const tables = ['incoming_messages', 'transactions', 'review_queue', 'dashboard_metrics'];
  
  for (const table of tables) {
    const { data: columns, error: colError } = await supabase.from(table).select('*').limit(1);
    if (columns) {
      console.log(`${table} columns:`, Object.keys(columns[0] || {}));
    } else {
      console.log(`${table} access error:`, colError?.message);
    }
  }
}

run().catch(console.error);
