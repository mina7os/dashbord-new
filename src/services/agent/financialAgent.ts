import { supabaseAdmin } from '../../lib/supabase-server.ts';
import { extractMessage } from '../extraction.ts';
import { saveTransactionToOutputs } from '../transactionService.ts';

/**
 * Antigravity Financial Agent
 * Direct, resilient processing of WhatsApp financial data.
 * Bypasses UI barriers to deliver results.
 */
export async function runFinancialAgent() {
  console.log('--- 🤖 Antigravity Financial Agent Starting ---');

  // 1. Fetch pending messages
  const { data: messages, error } = await supabaseAdmin
    .from('incoming_messages')
    .select('*')
    .eq('processing_status', 'pending')
    .order('received_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch pending messages:', error);
    return;
  }

  if (!messages || messages.length === 0) {
    console.log('No pending messages found. Task complete.');
    return;
  }

  console.log(`Found ${messages.length} messages to process.`);

  for (const msg of messages) {
    console.log(`\n[Agent] Processing Message ID: ${msg.id}`);
    
    try {
      const { data: integration } = await supabaseAdmin
        .from('user_integrations')
        .select('sheet_id, google_tokens')
        .eq('user_id', msg.user_id)
        .maybeSingle();

      const context = {
        userId: msg.user_id,
        sheetId: integration?.sheet_id || undefined,
        tokens: integration?.google_tokens || undefined,
        activeChats: new Set<string>([msg.chat_id]),
      };

      // 2. Claim message
      await supabaseAdmin.from('incoming_messages').update({ 
        processing_status: 'processing',
        processing_stage: 'extraction' 
      }).eq('id', msg.id);

      // 3. Extract (Gemini)
      const extraction = await extractMessage(
        msg.raw_text || '',
        context,
        undefined,
        undefined,
        msg.actual_mime_type || undefined
      );
      
      if (!extraction || extraction.transactions.length === 0) {
        console.log('   - No transactions found or extraction failed.');
        await supabaseAdmin.from('incoming_messages').update({ 
          processing_status: 'failed',
          last_error: 'No transactions extracted' 
        }).eq('id', msg.id);
        continue;
      }

      console.log(`   - Extracted ${extraction.transactions.length} transactions.`);

      // 4. Sync each transaction
      for (const tx of extraction.transactions) {
        console.log(`   - Syncing ${tx.amount} ${tx.currency}...`);
        
        await saveTransactionToOutputs({
          ...tx,
          user_id: msg.user_id,
          message_id: msg.message_id,
          raw_text: msg.raw_text || extraction.ocr_text
        }, context);
      }

      // 5. Update Metrics (Dashboard Graph)
      const date = new Date().toISOString().split('T')[0];
      const { data: metrics } = await supabaseAdmin
        .from('dashboard_metrics')
        .select('*')
        .eq('user_id', msg.user_id)
        .eq('date', date)
        .maybeSingle();

      const update = metrics ? {
        total_messages: (metrics.total_messages || 0) + 1,
        successful_extractions: (metrics.successful_extractions || 0) + 1,
        financial_candidates: (metrics.financial_candidates || 0) + 1
      } : {
        user_id: msg.user_id,
        date: date,
        total_messages: 1,
        successful_extractions: 1,
        financial_candidates: 1
      };

      await supabaseAdmin.from('dashboard_metrics').upsert(update);

      // 6. Complete
      await supabaseAdmin.from('incoming_messages').update({ 
        processing_status: 'completed',
        processing_stage: 'synced',
        extraction_confidence: extraction.confidence 
      }).eq('id', msg.id);

      console.log('   ✅ Successfully processed.');

    } catch (err: any) {
      console.error(`   ❌ Failed: ${err.message}`);
      await supabaseAdmin.from('incoming_messages').update({ 
        processing_status: 'failed',
        last_error: err.message 
      }).eq('id', msg.id);
    }
  }

  console.log('\n--- 🤖 Antigravity Financial Agent Finished ---');
}
