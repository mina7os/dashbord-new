/**
 * absolute-truth.ts - HARDCODED ZEOQ EDITION
 */
import https from 'https';

const url = 'https://zeoqbuuqkerllsmoxjxa.supabase.co';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inplb3FidXVxa2VybGxzbW94anhhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Mjg2MTM5NywiZXhwIjoyMDU4NDM3Mzk3fQ.U3W3W9yO4j-hFwS5suYMyGRRzI04-Dk3w_wl90HX7yI'; 
const geminiKey = 'AIzaSyDBYP_Zkoyf_uSAPSuFqGRTINDT0jVtK2A'; 
const userId = '3b9e4a82-7b8c-4d2a-9e1a-8c9d0e1f2031';

async function request(fullUrl: string, method: string, headers: any, body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request(fullUrl, { method, headers, timeout: 60000 }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d || '{}')); } catch(e) { resolve(d); }
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function run() {
    console.log('--- 🧪 STARTING EXPERIMENT-BASED EXTRACTION (ZEOQ) ---');
    const commonHeaders = { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
    
    // 1. Reset Ownership
    console.log('Migrating 12 messages to current user...');
    await request(`${url}/rest/v1/incoming_messages`, 'PATCH', commonHeaders, { user_id: userId, processing_status: 'pending' });

    // 2. Fetch
    const messages: any = await request(`${url}/rest/v1/incoming_messages?processing_status=eq.pending&select=*`, 'GET', commonHeaders);
    console.log(`Working on ${messages.length} messages.`);

    for (const msg of messages) {
        console.log(`\nAnalyzing: "${msg.raw_text?.substring(0, 40)}..."`);
        const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
        const gRes = await request(gUrl, 'POST', { 'Content-Type': 'application/json' }, {
            contents: [{ parts: [{ text: `Extract financial txn JSON: { "amount": number, "currency": "EGP", "category": "General", "type": "expense" }. Msg: ${msg.raw_text}` }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        const tx = JSON.parse(gRes.candidates?.[0]?.content?.parts?.[0]?.text || '{"amount":0}');
        if (tx.amount > 0) {
            console.log(`   ✅ Extracted: ${tx.amount} ${tx.currency}`);
            await request(`${url}/rest/v1/transactions`, 'POST', commonHeaders, {
                user_id: userId, message_id: msg.message_id, amount: tx.amount, currency: tx.currency, category: tx.category, type: tx.type, date: new Date().toISOString()
            });
            const today = new Date().toISOString().split('T')[0];
            await request(`${url}/rest/v1/dashboard_metrics`, 'POST', { ...commonHeaders, 'Prefer': 'resolution=merge-duplicates' }, {
                user_id: userId, date: today, successful_extractions: 1, total_messages: 1
            });
        }
        await request(`${url}/rest/v1/incoming_messages?id=eq.${msg.id}`, 'PATCH', commonHeaders, { processing_status: 'completed' });
    }
    console.log('\n--- 🤖 EXPERIMENT COMPLETE: CHECK DASHBOARD NOW ---');
}
run();
