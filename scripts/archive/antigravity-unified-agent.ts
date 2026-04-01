/**
 * antigravity-unified-agent.ts
 * THE FINAL WORD.
 */
import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';
import https from 'https';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const targetUserId = '3b9e4a82-7b8c-4d2a-9e1a-8c9d0e1f2031';

const customFetch = (url: string, options: any) => {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: options.method || 'GET', headers: options.headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({
        ok: res.statusCode! >= 200 && res.statusCode! < 300,
        status: res.statusCode,
        json: async () => JSON.parse(data || '{}'),
        text: async () => data,
        headers: { get: (n: string) => '' }
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
};

const supabase = createClient(supabaseUrl, serviceRoleKey, { global: { fetch: customFetch as any } });

async function extract(text: string) {
  const payload = { contents: [{ parts: [{ text: `Extract financial txn JSON: { "amount": number, "currency": "EGP"|"USD", "category": string, "type": "income"|"expense" }. Text: ${text}` }] }], generationConfig: { responseMimeType: "application/json" } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;
  const res: any = await customFetch(url, { method: 'POST', body: JSON.stringify(payload) });
  const json = await res.json();
  const resultText = json.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(resultText || '{"amount":0}');
}

async function run() {
  console.log('--- 🤖 ANTIGRAVITY UNIFIED AGENT OVERRIDE ---');
  
  // 1. MASS RESET and OWNERSHIP TRANSFER
  console.log('Resetting all messages and transferring to current user...');
  await supabase.from('incoming_messages').update({ 
    user_id: targetUserId, 
    processing_status: 'pending' 
  }).neq('id', '00000000-0000-0000-0000-000000000000'); // All

  // 2. Fetch pending
  const { data: messages } = await supabase.from('incoming_messages').select('*').eq('processing_status', 'pending');
  console.log(`Processing ${messages?.length || 0} messages...`);

  for (const msg of (messages || [])) {
    try {
      console.log(`Processing ${msg.id}: "${msg.raw_text?.substring(0, 30)}..."`);
      const tx = await extract(msg.raw_text);
      
      if (tx.amount > 0) {
        console.log(`   ✅ Extracted ${tx.amount} ${tx.currency}`);
        
        // Save Transaction
        await supabase.from('transactions').insert({
          user_id: targetUserId,
          message_id: msg.message_id,
          amount: tx.amount,
          currency: tx.currency || 'EGP',
          category: tx.category || 'General',
          type: tx.type || 'expense',
          date: new Date().toISOString()
        });

        // Update Stats for Graph
        const today = new Date().toISOString().split('T')[0];
        const { data: m } = await supabase.from('dashboard_metrics').select('*').eq('user_id', targetUserId).eq('date', today).maybeSingle();
        if (m) await supabase.from('dashboard_metrics').update({ successful_extractions: m.successful_extractions + 1, total_messages: m.total_messages + 1 }).eq('id', m.id);
        else await supabase.from('dashboard_metrics').insert({ user_id: targetUserId, date: today, successful_extractions: 1, total_messages: 1 });
      }

      await supabase.from('incoming_messages').update({ processing_status: 'completed' }).eq('id', msg.id);
    } catch (e: any) {
      console.error(`   ❌ Failed ${msg.id}: ${e.message}`);
    }
  }
  
  console.log('\n--- 🧪 SUMMARY REPORT ---');
  const { count } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', targetUserId);
  console.log(`Final Transaction Count for user: ${count}`);
  console.log('--- 🤖 TASK COMPLETE ---');
}

run();
