/**
 * verify_rpc.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function run() {
  console.log('--- RPC VERIFICATION BY CALL ---');
  
  // Try calling claim_messages with a dummy UUID
  const dummyId = '00000000-0000-0000-0000-000000000000';
  const { data, error } = await supabase.rpc('claim_messages', { 
    p_user_id: dummyId,
    p_limit: 1 
  });

  if (error) {
    if (error.message.includes('function') && error.message.includes('does not exist')) {
      console.log('❌ FAIL: claim_messages RPC does NOT exist.');
    } else {
      console.log('✅ PASS (Indirectly): RPC exists but returned error:', error.message);
    }
  } else {
    console.log('✅ PASS: claim_messages RPC exists and returned data:', data);
  }

  // Try calling increment_dashboard_metric
  const { error: err2 } = await supabase.rpc('increment_dashboard_metric', {
    p_user_id: dummyId,
    p_date: '2024-03-23',
    p_column: 'total_messages',
    p_delta: 0
  });

  if (err2) {
    if (err2.message.includes('function') && err2.message.includes('does not exist')) {
      console.log('❌ FAIL: increment_dashboard_metric RPC does NOT exist.');
    } else {
      console.log('✅ PASS (Indirectly): RPC exists but returned error:', err2.message);
    }
  } else {
    console.log('✅ PASS: increment_dashboard_metric RPC exists.');
  }
}

run().catch(console.error);
