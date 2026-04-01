import dotenv from 'dotenv';
dotenv.config();
import { supabaseAdmin } from '../../src/lib/supabase-server.ts';

async function clearQueue() {
  console.log('[Clear] Fetching all retriable/pending messages...');
  const { data, error } = await supabaseAdmin
    .from('incoming_messages')
    .update({ processing_status: 'completed_non_transaction', last_error: 'Admin cleared queue' })
    .in('processing_status', ['pending', 'failed_retriable', 'processing']);

  if (error) {
    console.error('[Error]', error);
  } else {
    console.log('[Clear] Successfully cleared all stuck messages in the queue.');
  }
}

clearQueue();
