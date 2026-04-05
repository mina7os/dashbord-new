/**
 * transactionService.ts
 * 
 * Shared logic for saving extracted transaction data to Supabase and enqueueing Google Sheets sync.
 */

import { supabaseAdmin } from '../lib/supabase-server.ts';
import { ExtractedTransaction } from './extraction.ts';
import { PipelineContext } from '../types/pipeline';

/**
 * Checks if a transaction with the same reference number already exists for this user.
 */
export async function checkDuplicateTransactionByReference(userId: string, reference: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('record_id')
    .eq('user_id', userId)
    .eq('reference_number', reference)
    .maybeSingle();
  
  if (error) return false;
  return !!data;
}

export interface SavedTransactionResult {
  recordId: number;
  idempotencyKey: string;
}

function isTransientSupabaseError(message?: string | null) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('502') ||
    text.includes('503') ||
    text.includes('504') ||
    text.includes('bad gateway') ||
    text.includes('gateway') ||
    text.includes('fetch failed') ||
    text.includes('timeout') ||
    text.includes('temporar') ||
    text.includes('network')
  );
}

async function pause(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Saves a single transaction to the 'transactions' table and enqueues to 'sheet_sync_queue'.
 */
export async function saveTransactionToOutputs(tx: ExtractedTransaction, context: PipelineContext): Promise<SavedTransactionResult> {
  // 1. Generate Idempotency Key (normalized)
  const normalizedRef = (tx.reference_number || tx.transaction_date || 'noref').toLowerCase().trim();
  const idKey = `tx:${context.userId}:${tx.amount}:${normalizedRef}`;

  // 2. Save to Supabase (Source of Truth)
  let dbTx: { record_id: number } | null = null;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .upsert([{
        user_id: context.userId,
        message_id: tx.message_id, 
        transaction_date: tx.transaction_date || new Date().toISOString().split('T')[0],
        transaction_type: tx.transaction_type,
        channel: 'whatsapp',
        bank_name: tx.bank_name,
        sender_name: tx.sender_name,
        beneficiary_name: tx.beneficiary_name,
        beneficiary_account: tx.beneficiary_account,
        amount: tx.amount,
        currency: tx.currency || 'EGP',
        reference_number: tx.reference_number,
        confidence: tx.confidence,
        review_required: tx.review_required || false,
        duplicate: tx.duplicate || false,
        raw_text: tx.raw_text,
        processing_status: 'completed',
        idempotency_key: idKey
      }], { onConflict: 'idempotency_key' })
      .select('record_id')
      .single();

    if (!error && data?.record_id) {
      dbTx = data;
      break;
    }

    lastError = error?.message || 'Unknown Supabase save failure';
    console.error(`[TransactionService] Supabase write failed on attempt ${attempt}:`, lastError);

    if (!isTransientSupabaseError(lastError) || attempt === 3) {
      break;
    }

    await pause(500 * attempt);
  }

  if (!dbTx) {
    throw new Error(`Supabase save failed: ${lastError || 'Unknown error'}`);
  }

  // 3. Queue for Google Sheets (Asynchronous and Observable)
  if (context.sheetId && context.tokens) {
    const rowData = [
      tx.transaction_date || new Date().toISOString().split('T')[0],
      tx.transaction_time || new Date().toLocaleTimeString(),
      tx.transaction_type || 'unknown',
      tx.bank_name || '',
      tx.transaction_location || '',
      tx.sender_name || '',
      tx.sender_code || '',
      tx.beneficiary_name || '',
      tx.beneficiary_account || '',
      tx.amount || 0,
      tx.currency || 'EGP',
      'completed',
      tx.reference_number || '',
    ];

    const { error: qError } = await supabaseAdmin.from('sheet_sync_queue').insert([{
      user_id: context.userId,
      transaction_id: String(dbTx.record_id),  // record_id is bigint, cast to string
      sheet_id: context.sheetId,
      row_data: rowData,
      status: 'pending',
      attempt_count: 0
    }]);

    if (qError) {
      console.error('[TransactionService] Failed to enqueue sheet sync:', qError.message);
      // We do not throw because the transaction is safely saved to Truth Source. 
      // The worker will retry missing syncs later if implemented in bulk sync.
    }
  }

  return {
    recordId: Number(dbTx.record_id),
    idempotencyKey: idKey,
  };
}

/**
 * Increments a specific observability metric for a user.
 */
export async function incrementMetric(userId: string, column: string, delta = 1): Promise<void> {
  const { error } = await supabaseAdmin.rpc('increment_dashboard_metric', {
    p_user_id: userId,
    p_date: new Date().toISOString().split('T')[0],
    p_column: column,
    p_delta: delta
  });
  if (error) console.warn(`[Metrics] Increment failed for ${column}:`, error.message);
}

/**
 * Upserts daily metrics for a successful transaction.
 */
export async function upsertDailyMetrics(userId: string, date: string, tx: ExtractedTransaction): Promise<void> {
  const { error } = await supabaseAdmin.rpc('increment_daily_metrics', {
    p_user_id: userId,
    p_date: date,
    p_amount: tx.amount || 0,
    p_tx_count: 1
  });

  if (error) {
    console.error('[TransactionService] Metrics update failed:', error.message);
  }
}
