import dotenv from 'dotenv';
import { supabaseAdmin } from '../../src/lib/supabase-server.ts';

dotenv.config();

const mockUserId = process.env.VITE_TEST_USER_ID || '00000000-0000-0000-0000-000000000000'; // Replace with an actual test user UUID

async function runMock() {
  console.log('[Test] Injecting mock transaction...');

  // 1. Inject into incoming_messages manually
  const messageData = {
    user_id: mockUserId,
    chat_id: '12345678@c.us',
    message_id: `mock-${Date.now()}`,
    raw_text: 'You have paid INR 500 to DemoMerchant via UPI Ref: 123456789012',
    timestamp: new Date().toISOString(),
    is_media: false,
    processing_status: 'pending'
  };

  const { data, error } = await supabaseAdmin
    .from('incoming_messages')
    .insert([messageData])
    .select('id')
    .single();

  if (error) {
    console.error('[Test Error] Failed to inject message:', error.message);
    process.exit(1);
  }

  console.log(`[Test] Injected message id: ${data.id}. The worker will pick it up automatically.`);
}

runMock();
