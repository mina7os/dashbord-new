import { supabaseAdmin } from '../../src/lib/supabase-server.ts';

async function checkLastError() {
  const { data, error } = await supabaseAdmin
    .from('incoming_messages')
    .select('id, raw_text, last_error, processing_status, attempt_count, updated_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.error('Error fetching:', error);
  } else {
    console.log('Latest Message Status:');
    console.log(JSON.stringify(data, null, 2));
  }
}

checkLastError();
