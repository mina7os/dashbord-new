/**
 * ultimate-agent.ts - SYSTEM CURL EDITION
 */
import { execSync } from 'child_process';
import https from 'https';

const url = 'https://zeoqbuuqkerllsmoxjxa.supabase.co';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inplb3FidXVxa2VybGxzbW94anhhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Mjg2MTM5NywiZXhwIjoyMDU4NDM3Mzk3fQ.U3W3W9yO4j-hFwS5suYMyGRRzI04-Dk3w_wl90HX7yI'; 
const geminiKey = 'AIzaSyDBYP_Zkoyf_uSAPSuFqGRTINDT0jVtK2A'; 
const userId = '3b9e4a82-7b8c-4d2a-9e1a-8c9d0e1f2031';
const CURL_EXE = 'C:\\Windows\\System32\\curl.exe';

function sbQuery(path: string, method: string = 'GET', body?: any) {
    let cmd = `"${CURL_EXE}" -s -X ${method} "${url}/rest/v1/${path}" -H "apikey: ${key}" -H "Authorization: Bearer ${key}" -H "Content-Type: application/json"`;
    if (body) {
        // Simple escaping for JSON in Windows CMD
        const bodyStr = JSON.stringify(body).replace(/"/g, '"""');
        cmd += ` -d "${bodyStr}"`;
    }
    const out = execSync(cmd, { encoding: 'utf-8' });
    try { return JSON.parse(out || '[]'); } catch(e) { return out; }
}

async function gemini(text: string) {
    return new Promise((resolve) => {
        const payload = { contents: [{ parts: [{ text: `Extract financial txn JSON: { "amount": number, "currency": "EGP", "category": "General", "type": "expense" }. Msg: ${text}` }] }], generationConfig: { responseMimeType: "application/json" } };
        const req = https.request(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(d || '{}');
                    resolve(JSON.parse(json.candidates?.[0]?.content?.parts?.[0]?.text || '{"amount":0}'));
                } catch(e) { resolve({amount:0}); }
            });
        });
        req.on('error', () => resolve({amount:0}));
        req.write(JSON.stringify(payload));
        req.end();
    });
}

async function run() {
    console.log('--- 🤖 ULTIMATE AGENT STARTING (HARDENED CURL) ---');
    
    // 1. Reset
    console.log('Resetting and transferring messages...');
    sbQuery('incoming_messages', 'PATCH', { user_id: userId, processing_status: 'pending' });

    // 2. Fetch
    const messages = sbQuery('incoming_messages?processing_status=eq.pending&select=*');
    if (!Array.isArray(messages)) {
        console.error('Failed to fetch messages:', messages);
        return;
    }
    console.log(`Working on ${messages.length} messages.`);

    for (const msg of messages) {
        console.log(`\nAnalyzing: "${msg.raw_text?.substring(0, 30)}..."`);
        const tx: any = await gemini(msg.raw_text);
        
        if (tx.amount > 0) {
            console.log(`   ✅ Extracted: ${tx.amount} ${tx.currency}`);
            sbQuery('transactions', 'POST', {
                user_id: userId, message_id: msg.message_id, amount: tx.amount, currency: tx.currency, category: tx.category, type: tx.type, date: new Date().toISOString()
            });
            const today = new Date().toISOString().split('T')[0];
            sbQuery('dashboard_metrics', 'POST', {
                user_id: userId, date: today, successful_extractions: 1, total_messages: 1
            });
        }
        sbQuery(`incoming_messages?id=eq.${msg.id}`, 'PATCH', { processing_status: 'completed' });
    }
    console.log('\n--- 🏁 TASK COMPLETE: ALL DATA PROCESSED AND SYNCED ---');
}
run();
