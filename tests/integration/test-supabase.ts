import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

async function test() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.log('URL:', url);
  console.log('Key length:', key?.length);

  if (!url || !key) {
    console.error('Missing URL or Key');
    return;
  }

  const supabase = createClient(url, key);
  try {
    const { data, error } = await supabase.from('user_integrations').select('*').limit(1);
    if (error) {
      console.error('Supabase Error:', error);
    } else {
      console.log('Supabase Success:', data);
    }
  } catch (err) {
    console.error('Fetch Error:', err);
  }
}

test();
