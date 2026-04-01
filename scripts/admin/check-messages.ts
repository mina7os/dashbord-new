import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

async function test() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Missing URL or Key');
    return;
  }

  const supabase = createClient(url, key);
  try {
    const { data, error } = await supabase.from('incoming_messages').select('*').order('created_at', { ascending: false }).limit(5);
    if (error) {
      console.error('Supabase Error:', error);
    } else {
      console.log('LATEST_MESSAGES_START');
      console.log(JSON.stringify(data.map(m => ({ 
        id: m.id, 
        msg_id: m.message_id, 
        status: m.processing_status, 
        stage: m.processing_stage, 
        attempts: m.attempt_count,
        last_error: m.last_error,
        updated_at: m.updated_at
      })), null, 2));
      console.log('LATEST_MESSAGES_END');
    }
  } catch (err) {
    console.error('Fetch Error:', err);
  }
}

test();
