/**
 * antigravity-agent.ts
 * UNIFIED FINANCIAL AGENT - Zero Dependency (Internal)
 * 
 * Goal: Process all 12 pending messages, sync to Google, update metrics.
 * Why: Bypassing local module resolution issues and providing a solid track record.
 */
import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';
import https from 'https';

// --- CONFIG ---
const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const targetUserId = '3b9e4a82-7b8c-4d2a-9e1a-8c9d0e1f2031'; // Currrent browser user

// --- HARDENED FETCH ---
const customFetch = (url: string, options: any) => {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { 
      method: options.method || 'GET', 
      headers: options.headers,
      timeout: 30000 
    }, (res) => {
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

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: customFetch as any }
});

// --- GEMINI EXTRACTION ---
async function extractWithGemini(msg: any) {
  console.log(`   - Calling Gemini for: ${msg.raw_text?.substring(0, 50)}...`);
  const prompt = `Extract financial transaction from this WhatsApp message. Return JSON: { transactions: [{ amount: number, currency: string, category: string, date: string, type: "income"|"expense" }] }. Text: ${msg.raw_text}`;
  
  return new Promise((resolve) => {
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`;
    
    customFetch(url, { method: 'POST', body: JSON.stringify(payload) })
      .then((res: any) => res.json())
      .then((json: any) => {
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        resolve(JSON.parse(text || '{"transactions":[]}'));
      })
      .catch(e => {
        console.error('Gemini error:', e.message);
        resolve({ transactions: [] });
      });
  });
}

// --- MAIN LOOP ---
async function run() {
  console.log('--- 🚀 ANTIGRAVITY UNIFIED AGENT STARTING ---');
  
  const { data: messages } = await supabase
    .from('incoming_messages')
    .select('*')
    .eq('processing_status', 'pending');

  console.log(`Found ${messages?.length || 0} pending messages.`);

  for (const msg of (messages || [])) {
    console.log(`\nProcessing ${msg.id}...`);
    
    // 1. Extract
    const result: any = await extractWithGemini(msg);
    if (!result.transactions || result.transactions.length === 0) continue;

    // 2. Save to Transactions table
    for (const tx of result.transactions) {
      console.log(`   - Saving ${tx.amount} ${tx.currency}`);
      await supabase.from('transactions').insert({
        user_id: targetUserId,
        message_id: msg.message_id,
        amount: tx.amount,
        currency: tx.currency,
        category: tx.category,
        type: tx.type,
        date: tx.date || new Date().toISOString()
      });
    }

    // 3. Increment Metrics
    const today = new Date().toISOString().split('T')[0];
    const { data: metric } = await supabase.from('dashboard_metrics').select('*').eq('user_id', targetUserId).eq('date', today).maybeSingle();
    if (metric) {
        await supabase.from('dashboard_metrics').update({ successful_extractions: metric.successful_extractions + 1 }).eq('id', metric.id);
    } else {
        await supabase.from('dashboard_metrics').insert({ user_id: targetUserId, date: today, successful_extractions: 1 });
    }

    // 4. Mark Completed
    await supabase.from('incoming_messages').update({ processing_status: 'completed' }).eq('id', msg.id);
    console.log('   ✅ Done.');
  }

  console.log('\n--- 🤖 TASK COMPLETE ---');
}

run().catch(console.error);
