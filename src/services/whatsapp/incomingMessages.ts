/**
 * incomingMessages.ts
 * 
 * Helpers for writing and advancing the inbox state machine.
 */

import { supabaseAdmin } from '../../lib/supabase-server.ts';
import { MediaSourceType } from '../../types/media.ts';

// ─── Status & Stage Types ─────────────────────────────────────────────────────

export type IncomingMessageStatus =
  | 'pending'            // Awaiting worker classification/processing
  | 'processing'         // Worker is currently handling the row
  | 'completed'          // Success (financial or non-financial)
  | 'completed_transaction'
  | 'completed_non_transaction'
  | 'completed_duplicate'
  | 'review_required'    // Low confidence or ambiguous
  | 'failed_retriable'   // Transient error (retry later)
  | 'failed_terminal'    // Permanent failure
  | 'media_capture_failed';

export const STAGES = {
  RECEIVED: 'received',
  MEDIA_CAPTURE: 'media_capture',
  MEDIA_PERSISTED: 'media_persisted',
  MEDIA_CAPTURE_FAILED: 'media_capture_failed',
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  EXTRACTING: 'extracting',
  CLASSIFYING: 'classifying',
  SAVING: 'saving',
  REVIEW: 'review',
  SYNCING: 'syncing',
  RETRY_SCHEDULED: 'retry_scheduled',
  COMPLETED: 'completed',
  FAILED: 'failed'
} as const;

export interface IncomingMessageRow {
  id: string;
  user_id: string;
  message_id: string;
  chat_id: string;
  sender_id?: string;
  sender_name?: string;
  raw_text?: string;
  has_media: boolean;
  actual_mime_type?: string;
  raw_media_data?: string;   // Deprecated: Base64
  media_url?: string;        // New: Storage path
  classification?: MediaSourceType;
  is_financial: boolean;
  processing_status: IncomingMessageStatus;
  processing_stage?: string;
  attempt_count: number;
  last_error?: string;
  extraction_confidence?: number;
  ocr_text?: string;
  review_reason?: string;
  transaction_count: number;
  received_at: string;
  processed_at?: string;
  source_type?: string;
  metadata?: any;
}

// ─── State Machine Enforcements ───────────────────────────────────────────────

const TERMINAL_STATUSES: IncomingMessageStatus[] = [
  'completed', 'completed_transaction', 'completed_non_transaction', 
  'completed_duplicate', 'failed_terminal'
];

/**
 * Validates if a transition is legal. 
 * Prevents moving out of a terminal state unless specifically reset.
 */
function isLegalTransition(currentStatus: IncomingMessageStatus, nextStatus: IncomingMessageStatus): boolean {
  if (TERMINAL_STATUSES.includes(currentStatus) && nextStatus !== 'pending') {
    return false; // Cannot leave terminal state without explicit manual reset
  }
  return true;
}

// ─── Insert raw inbound record ────────────────────────────────────────────────

export async function insertIncomingMessage(opts: {
  userId: string; messageId: string; chatId: string;
  senderId?: string; senderName?: string; rawText?: string;
  hasMedia: boolean; actualMimeType?: string; rawMediaData?: string;
  mediaUrl?: string; processingStage?: string; processingStatus?: IncomingMessageStatus;
  sourceType?: string; lastError?: string; metadata?: any;
}): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('incoming_messages')
    .insert([{
      user_id: opts.userId, message_id: opts.messageId, chat_id: opts.chatId,
      sender_id: opts.senderId || null, sender_name: opts.senderName || null,
      raw_text: opts.rawText || null, has_media: opts.hasMedia,
      actual_mime_type: opts.actualMimeType || null, raw_media_data: opts.rawMediaData || null,
      media_url: opts.mediaUrl || null, processing_status: opts.processingStatus || 'pending',
      processing_stage: opts.processingStage || 'received', source_type: opts.sourceType || 'whatsapp',
      last_error: opts.lastError || null, metadata: opts.metadata || null, attempt_count: 0,
    }])
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') return null; 
    console.error('[IncomingMessages] Insert failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

// ─── Core State Advancer ──────────────────────────────────────────────────────

export async function advanceStage(
  incomingId: string,
  stage: string,
  status: IncomingMessageStatus,
  extra?: Partial<{
    lastError: string; classification: MediaSourceType; isFinancial: boolean;
    extractionConfidence: number; ocrText: string; reviewReason: string;
    transactionCount: number; nextRetryAt?: string; metadata?: any;
  }>
): Promise<void> {
  const { data: current } = await supabaseAdmin.from('incoming_messages').select('processing_status').eq('id', incomingId).single();
  
  if (current && !isLegalTransition(current.processing_status, status)) {
    console.warn(`[State Machine] Illegal transition attempted ID=${incomingId}: ${current.processing_status} -> ${status}`);
    return;
  }

  const payload: Record<string, any> = { processing_stage: stage, processing_status: status, updated_at: new Date().toISOString() };

  if (extra?.lastError !== undefined) payload.last_error = extra.lastError;
  if (extra?.nextRetryAt !== undefined) payload.next_retry_at = extra.nextRetryAt;
  if (extra?.classification !== undefined) payload.classification = extra.classification;
  if (extra?.isFinancial !== undefined) payload.is_financial = extra.isFinancial;
  if (extra?.extractionConfidence !== undefined) payload.extraction_confidence = extra.extractionConfidence;
  if (extra?.ocrText !== undefined) payload.ocr_text = extra.ocrText;
  if (extra?.reviewReason !== undefined) payload.review_reason = extra.reviewReason;
  if (extra?.transactionCount !== undefined) payload.transaction_count = extra.transactionCount;
  if (extra?.metadata !== undefined) payload.metadata = extra.metadata;

  // Successful terminal states should not retain stale transient failure data.
  if (status === 'completed' || status === 'completed_transaction' || status === 'completed_non_transaction' || status === 'completed_duplicate') {
    payload.last_error = null;
    payload.next_retry_at = null;
  }

  if (TERMINAL_STATUSES.includes(status) || status === 'review_required') {
    payload.processed_at = new Date().toISOString();
  }

  const { error } = await supabaseAdmin.from('incoming_messages').update(payload).eq('id', incomingId);
  if (error) console.warn('[IncomingMessages] advanceStage failed:', error.message);
  else console.log(`[IncomingMessages] Stage transition id=${incomingId} stage=${stage} status=${status}`);
}

// ─── Explicit Semantic Helpers ────────────────────────────────────────────────

export async function markClaimed(incomingId: string) {
  await advanceStage(incomingId, STAGES.CLAIMED, 'processing');
}

export async function markExtracting(incomingId: string) {
  await advanceStage(incomingId, STAGES.EXTRACTING, 'processing');
}

export async function markCompletedTransaction(incomingId: string, metrics: { isFinancial: boolean; transactionCount: number }) {
  await advanceStage(incomingId, 'completed_via_pipeline', 'completed_transaction', metrics);
}

export async function markCompletedDuplicate(
  incomingId: string,
  reason: string,
  duplicateReference?: string | null,
  duplicateCandidate?: Record<string, any> | null
) {
  await advanceStage(incomingId, 'duplicate_reference', 'completed_duplicate', {
    reviewReason: reason,
    metadata: {
      duplicate_reference: duplicateReference || null,
      duplicate_confirmed: false,
      duplicate_candidate: duplicateCandidate || null,
    },
  });
}

export async function markReviewRequired(incomingId: string, reason: string, confidence: number) {
  await advanceStage(incomingId, STAGES.REVIEW, 'review_required', { reviewReason: reason, extractionConfidence: confidence });
}

export async function markFailedRetriable(incomingId: string, errorMessage: string, retryInMs: number) {
  const nextRetryAt = new Date(Date.now() + retryInMs).toISOString();
  await advanceStage(incomingId, STAGES.RETRY_SCHEDULED, 'failed_retriable', { lastError: errorMessage, nextRetryAt });
}

export async function markFailedPermanent(incomingId: string, errorMessage: string) {
  await advanceStage(incomingId, STAGES.FAILED, 'failed_terminal', { lastError: errorMessage });
}

// ─── Mark attempt count ───────────────────────────────────────────────────────

export async function incrementAttempt(incomingId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('increment_message_attempt', { p_id: incomingId });
  if (error) {
    const { data } = await supabaseAdmin.from('incoming_messages').select('attempt_count').eq('id', incomingId).single();
    if (data) {
      await supabaseAdmin.from('incoming_messages').update({ attempt_count: (data.attempt_count || 0) + 1, updated_at: new Date().toISOString() }).eq('id', incomingId);
    }
  }
}

// ─── Worker Fetch Helpers ─────────────────────────────────────────────────────

export async function claimMessages(userId: string, limit = 5): Promise<IncomingMessageRow[]> {
  const { data, error } = await supabaseAdmin.rpc('claim_messages', { p_user_id: userId, p_limit: limit });
  if (error) {
    console.error('[IncomingMessages] claimMessages error:', error.message);
    return [];
  }
  return (data || []) as IncomingMessageRow[];
}

export async function fetchRetriableMessages(userId: string, limit = 10): Promise<IncomingMessageRow[]> {
  const { data, error } = await supabaseAdmin.from('incoming_messages').select('*').eq('user_id', userId)
    .eq('processing_status', 'failed_retriable').lte('next_retry_at', new Date().toISOString())
    .lt('attempt_count', 20).order('next_retry_at', { ascending: true }).limit(limit);

  if (error) {
    console.error('[IncomingMessages] fetchRetriableMessages error:', error.message);
    return [];
  }
  return (data || []) as IncomingMessageRow[];
}

export async function getIncomingMessageStats(userId: string): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin.from('incoming_messages').select('processing_status').eq('user_id', userId);
  if (error || !data) return {};
  return data.reduce((acc: any, row: any) => {
    acc[row.processing_status] = (acc[row.processing_status] || 0) + 1;
    return acc;
  }, {});
}
