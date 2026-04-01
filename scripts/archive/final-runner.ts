/**
 * final-runner.ts
 * THE ULTIMATE FIX.
 * Resolves Quote Mismatch, Ownership, and Networking.
 */
import fs from 'fs';
import path from 'path';

// 1. Manually parse .env to handle quotes/whitespace correctly
const envFile = fs.readFileSync('.env', 'utf-8');
const env: any = {};
envFile.split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
        const key = parts[0].trim();
        let val = parts.slice(1).join('=').trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.substring(1, val.length - 1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.substring(1, val.length - 1);
        env[key] = val;
        process.env[key] = val;
    }
});

import { supabaseAdmin } from '../../src/lib/supabase-server.ts';
import { runFinancialAgent } from '../../src/services/agent/financialAgent.ts';

async function main() {
    console.log('--- 🚀 STARTING ULTIMATE RECOVERY ---');
    console.log(`Using Project: ${process.env.VITE_SUPABASE_URL}`);
    
    // 2. Transfer ownership in ZEOQ
    const targetUserId = '3b9e4a82-7b8c-4d2a-9e1a-8c9d0e1f2031';
    console.log(`Transferring ownership to ${targetUserId}...`);
    const { count, error: upError } = await supabaseAdmin
        .from('incoming_messages')
        .update({ user_id: targetUserId, processing_status: 'pending' })
        .neq('id', '00000000-0000-0000-0000-000000000000');

    if (upError) console.error('Ownership transfer failed:', upError);
    else console.log(`✅ Ownership transferred for ${count} rows (or all).`);

    // 3. Run Agent
    await runFinancialAgent();
    
    console.log('--- 🏁 RECOVERY COMPLETE ---');
}

main().catch(console.error);
