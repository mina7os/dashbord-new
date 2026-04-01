
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

async function run() {
    const sql = `
        ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS "Users can manage their own integrations" ON user_integrations;
        CREATE POLICY "Users can manage their own integrations" ON user_integrations 
            FOR ALL USING (auth.uid() = user_id);
    `;
    const { data, error } = await supabase.rpc('execute_sql', { sql_query: sql });
    if (error) console.error('Error:', error);
    else console.log('RLS Re-applied successfully');
    process.exit(0);
}

run();
