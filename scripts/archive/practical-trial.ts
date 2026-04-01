
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { extractMessage } from '../../src/services/extraction.ts';
import { saveTransactionToOutputs } from '../../src/services/transactionService.ts';

dotenv.config();

const supabaseAdmin = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function runTrial() {
  const userId = 'bdc564f5-5952-42aa-b14c-4321e284af3c';
  
  console.log('🚀 Starting Practical Trial...');
  console.log('1. Checking Connection...');
  const { data: testData, error: testErr } = await supabaseAdmin.from('profiles').select('id').limit(1);
  if (testErr) {
    console.error('❌ Supabase Connection Failed:', testErr.message);
    return;
  }
  console.log('✅ Supabase Connected.');

  console.log('2. Fetching one failing message...');
  const { data: messages, error: msgErr } = await supabaseAdmin
    .from('incoming_messages')
    .select('*')
    .eq('user_id', userId)
    .eq('processing_status', 'failed_retriable')
    .limit(1);

  if (msgErr || !messages || messages.length === 0) {
    console.error('❌ No retriable messages found for user.');
    return;
  }

  const msg = messages[0];
  console.log(`✅ Found message: ${msg.id} (Attempt: ${msg.attempt_count}, Last Error: ${msg.last_error?.substring(0, 50)}...)`);

  console.log('3. Running AI Extraction...');
  try {
    const context = { 
      userId, 
      sheetId: undefined as string | undefined, 
      tokens: undefined as any,
      activeChats: new Set([msg.chat_id])
    };

    // Load integration context
    const { data: integration } = await supabaseAdmin
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    
    context.sheetId = integration?.sheet_id;
    context.tokens = integration?.google_tokens;

    console.log(`   Modality: ${msg.has_media ? 'media' : 'text'}`);
    
    let imageBuffer: Buffer | undefined;
    if (msg.media_url) {
       console.log('   Downloading media...');
       const { data: blob } = await supabaseAdmin.storage.from('receipts').download(msg.media_url);
       if (blob) imageBuffer = Buffer.from(await blob.arrayBuffer());
    }

    const start = Date.now();
    const result = await extractMessage(
      msg.raw_text || '', 
      context as any, 
      imageBuffer, 
      msg.actual_mime_type?.includes('pdf') ? 'pdf' : 'image',
      msg.actual_mime_type
    );
    const duration = (Date.now() - start) / 1000;

    console.log(`4. Extraction Result (${duration}s):`);
    console.log(`   Status: ${result.status}`);
    console.log(`   Confidence: ${result.confidence}`);
    console.log(`   Transactions found: ${result.transactions.length}`);

    if (result.status === 'ERROR') {
      console.error('❌ Extraction Failed:', result.review_reason);
      return;
    }

    if (result.transactions.length > 0) {
      console.log('5. Testing Google Sheet Sync...');
      if (!context.sheetId || !context.tokens) {
        console.warn('⚠️ No Google Sheet configured for this user.');
      } else {
         for (const tx of result.transactions) {
            console.log(`   Sending transaction: ${tx.amount} ${tx.currency}...`);
            try {
               await saveTransactionToOutputs(tx as any, context as any);
               console.log('   ✅ Sync success.');
            } catch (err: any) {
               console.error('   ❌ Sync failed:', err.message);
            }
         }
      }
    }

  } catch (err: any) {
    console.error('❌ Trial crashed:', err.message);
  }
}

runTrial();
