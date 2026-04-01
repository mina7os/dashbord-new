import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const adminClient = createClient(supabaseUrl, serviceRoleKey);

async function run() {
  console.log('1. Creating test user...');
  const email = `qa-test-${Date.now()}@example.com`;
  const password = 'TestPassword123!';
  
  const { data: authData, error: authErr } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  
  if (authErr) {
    console.error('Failed to create user:', authErr.message);
    process.exit(1);
  }
  
  const userId = authData.user.id;
  console.log('User created:', userId);

  // Sign in to get a JWT
  const anonClient = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || '');
  const { data: signInData, error: signInErr } = await anonClient.auth.signInWithPassword({ email, password });
  
  if (signInErr) {
    console.error('Failed to sign in:', signInErr.message);
    process.exit(1);
  }
  
  const token = signInData.session?.access_token;
  console.log('Got JWT token. Testing API endpoints...');

  // Test /api/whatsapp/disconnect
  console.log('2. Testing /api/whatsapp/disconnect...');
  const res1 = await fetch('http://localhost:3000/api/whatsapp/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ userId })
  });
  console.log('Disconnect response:', res1.status, await res1.json().catch(()=>''));

  // Test /api/ingest (will fail business logic because no integrations set up, but should pass auth and routing)
  console.log('3. Testing /api/ingest...');
  const res2 = await fetch('http://localhost:3000/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ userId, message_text: 'Received 100 EGP from Test', attachment_type: 'text' })
  });
  console.log('Ingest response:', res2.status, await res2.json().catch(()=>''));

  console.log('4. Cleaning up test user...');
  await adminClient.auth.admin.deleteUser(userId);
  console.log('Done.');
}

run().catch(console.error);
