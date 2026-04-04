/**
 * messageProcessor.ts
 * 
 * Background worker for processing incoming WhatsApp messages.
 * Polls 'incoming_messages' for pending rows, runs extraction,
 * and handles database/sheet persistence sequentially.
 */

import { 
  claimMessages, 
  fetchRetriableMessages, 
  advanceStage,
  markClaimed,
  markExtracting,
  markCompletedTransaction,
  markReviewRequired,
  markFailedRetriable,
  markFailedPermanent,
  incrementAttempt,
  IncomingMessageRow,
  STAGES
} from './incomingMessages.ts';
import { extractMessage } from '../extraction.ts';
import { 
  saveTransactionToOutputs, 
  checkDuplicateTransactionByReference, 
  upsertDailyMetrics,
  incrementMetric,
  SavedTransactionResult
} from '../transactionService.ts';
import { supabaseAdmin } from '../../lib/supabase-server.ts';
import { PipelineContext, GoogleTokens } from '../../types/pipeline';
import { deriveMediaSourceTypeFromMime } from '../../types/media.ts';

export class MessageProcessor {
  private usersPolling: Map<string, NodeJS.Timeout> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private processingUsers: Set<string> = new Set();
  private circuitBreakers: Map<string, number> = new Map();
  private replySender?: (userId: string, chatId: string, text: string) => Promise<void>;
  private replyAfterPersistWaitMs = 1200;

  public start(userId: string) {
    if (this.usersPolling.has(userId)) return;
    console.log(`[MessageProcessor | ${userId}] Starting sequential processor...`);
    
    const runTick = async () => {
      if (!this.usersPolling.has(userId)) return;
      try {
        await this.tick(userId);
      } catch (e) {
        console.error(`[MessageProcessor | ${userId}] Tick error:`, e);
      }
      if (this.usersPolling.has(userId)) {
        this.usersPolling.set(userId, setTimeout(runTick, 15000) as any);
      }
    };
    this.usersPolling.set(userId, setTimeout(runTick, 2000) as any);
  }

  public stop(userId: string) {
    const timer = this.usersPolling.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.usersPolling.delete(userId);
      console.log(`[MessageProcessor | ${userId}] Processor stopped.`);
    }
  }

  public trigger(userId: string) {
    if (!this.usersPolling.has(userId)) this.start(userId);
  }

  public setReplySender(sender: (userId: string, chatId: string, text: string) => Promise<void>) {
    this.replySender = sender;
  }

  private async tick(userId: string) {
    if (this.processingUsers.has(userId)) return;
    
    const cbExpiresAt = this.circuitBreakers.get(userId);
    if (cbExpiresAt && Date.now() < cbExpiresAt) {
      return; // Circuit is open, skip polling
    } else if (cbExpiresAt) {
      this.circuitBreakers.delete(userId);
      console.log(`[MessageProcessor | ${userId}] Circuit breaker closed. Resuming operations.`);
    }

    this.processingUsers.add(userId);

    const failCount = this.consecutiveFailures.get(userId) || 0;
    
    try {
      // 1. Process pending: Fetch up to 3 but process SEQUENTIALLY
      const pending = await claimMessages(userId, 3);
      this.consecutiveFailures.set(userId, 0);

      if (pending.length > 0) {
        console.log(`[MessageProcessor | ${userId}] Processing ${pending.length} message(s) sequentially...`);
        for (const row of pending) {
          await this.processMessage(userId, row);
          await new Promise(r => setTimeout(r, 4500)); // Respect Gemini 15 RPM limit
        }
      }

      // 2. Process retriable: 1 at a time
      const retriable = await fetchRetriableMessages(userId, 1);
      if (retriable.length > 0) {
        console.log(`[MessageProcessor | ${userId}] Retrying failed message...`);
        for (const row of retriable) {
          await this.processMessage(userId, row);
        }
      }
    } catch (err: any) {
      const newFailCount = failCount + 1;
      this.consecutiveFailures.set(userId, newFailCount);
      const backoffMs = Math.min(newFailCount * 30000, 300000); 
      console.error(`[MessageProcessor | ${userId}] Tick error. Backing off for ${backoffMs/1000}s. Error:`, err.message);
      await new Promise(r => setTimeout(r, backoffMs));
    } finally {
      this.processingUsers.delete(userId);
    }
  }

  private async processMessage(userId: string, row: IncomingMessageRow) {
    try {
      console.log(`[MessageProcessor | ${userId}] Claim row=${row.id} msg_id=${row.message_id} stage=${row.processing_stage}`);
      
      await markClaimed(row.id);
      await incrementAttempt(row.id);

      const mediaBuffer = await this.restoreMediaBuffer(userId, row);
      if (row.has_media && !mediaBuffer) return; // Errors already handled in restoreMediaBuffer

      if (!mediaBuffer && !(row.raw_text || '').trim()) {
        await markFailedRetriable(row.id, 'Message has no usable text and no reconstructed media', 300000);
        return;
      }

      const context = await this.buildContext(userId, row.chat_id);
      
      await markExtracting(row.id);
      const sourceType = deriveMediaSourceTypeFromMime(row.actual_mime_type, row.has_media);
      const result = await extractMessage(row.raw_text || '', context, mediaBuffer, sourceType, row.actual_mime_type);
      
      await this.handleOutcome(userId, row, result, context);

    } catch (err: any) {
      console.error(`[MessageProcessor | ${userId}] Critical error processing row [${row.id}]:`, err);
      await markFailedRetriable(row.id, err.message || 'Worker crash', 600000);
    }
  }

  private async restoreMediaBuffer(userId: string, row: IncomingMessageRow): Promise<Buffer | undefined> {
    if (row.raw_media_data) return Buffer.from(row.raw_media_data, 'base64');
    
    if (row.media_url) {
      const { data: blob, error } = await supabaseAdmin.storage.from('receipts').download(row.media_url);
      if (error) {
        await markFailedRetriable(row.id, `Storage retrieval failure: ${error.message}`, 300000);
        return undefined;
      }
      return Buffer.from(await blob.arrayBuffer());
    }

    if (row.has_media) {
      await markFailedRetriable(row.id, 'Message marked has_media=true without raw_media_data or media_url', 300000);
    }
    return undefined;
  }

  private async buildContext(userId: string, chatId: string): Promise<PipelineContext> {
    const { data: integration } = await supabaseAdmin.from('user_integrations').select('*').eq('user_id', userId).maybeSingle();
    return {
      userId,
      sheetId: integration?.sheet_id || undefined,
      tokens: (integration?.google_tokens as GoogleTokens | undefined) || undefined,
      activeChats: new Set([chatId]),
    };
  }

  private async handleOutcome(userId: string, row: IncomingMessageRow, result: any, context: PipelineContext) {
    if (result.status === 'ERROR') {
      await incrementMetric(userId, 'extraction_failed_count');
      
      if (result.is_quota_exceeded) {
        console.warn(`[MessageProcessor | ${userId}] GLOBAL_QUOTA_EXHAUSTED reached. Tripping Circuit Breaker for 10 minutes.`);
        this.circuitBreakers.set(userId, Date.now() + 10 * 60 * 1000); // 10 min cooldown

        // Decrement attempt so systemic failure doesn't penalize the message
        const { data } = await supabaseAdmin.from('incoming_messages').select('attempt_count').eq('id', row.id).single();
        if (data && data.attempt_count > 0) {
          await supabaseAdmin.from('incoming_messages').update({ attempt_count: data.attempt_count - 1 }).eq('id', row.id);
        }

        await markFailedRetriable(row.id, 'API Quota Exhausted. Global circuit open.', 10 * 60 * 1000);
        return;
      }

      await markFailedRetriable(row.id, result.review_reason || 'AI Extraction failed', 300000);
      return;
    }

    if (result.status === 'NO_FINANCIAL') {
      await advanceStage(row.id, STAGES.COMPLETED, 'completed_non_transaction', { classification: result.source_type, isFinancial: false });
      return;
    }

    await incrementMetric(userId, 'financial_candidates');
    const today = new Date().toISOString().split('T')[0];
    let allClean = true;
    const savedTransactions: Array<{ tx: any; saved: SavedTransactionResult }> = [];
    let reviewRequired = result.confidence < 0.4 || result.review_reason !== undefined;

    for (const tx of result.transactions) {
      tx.user_id = userId;
      tx.message_id = row.message_id;
      tx.sender_name = tx.sender_name || row.sender_name || 'Unknown';
      tx.raw_text = row.raw_text || result.ocr_text;

      if (tx.reference_number && await checkDuplicateTransactionByReference(userId, tx.reference_number)) {
        await incrementMetric(userId, 'duplicates');
        await advanceStage(row.id, 'duplicate_reference', 'completed_duplicate');
        this.sendReplySafe(userId, row.chat_id, this.buildDuplicateReply(tx.reference_number));
        return; 
      }

      try {
        if (reviewRequired || tx.review_required) {
          await supabaseAdmin.from('review_queue').insert([{
            user_id: userId, message_id: row.message_id, raw_text: tx.raw_text,
            suggested_data: tx, reason: result.review_reason || tx.review_reason || 'Manual review',
            confidence: tx.confidence || result.confidence, review_status: 'pending'
          }]);
        } else {
          const saved = await saveTransactionToOutputs(tx, context);
          savedTransactions.push({ tx, saved });
          await upsertDailyMetrics(userId, today, tx);
        }
      } catch (saveErr) {
        console.error(`[MessageProcessor | ${userId}] Persistence failure row=${row.id}:`, saveErr);
        allClean = false;
      }
    }

    if (allClean) {
      if (result.status === 'LOW_CONFIDENCE' || reviewRequired) {
        await incrementMetric(userId, 'pending_review');
        const reviewVisible = await this.waitForReviewVisible(userId, row.message_id);
        if (!reviewVisible) {
          await markFailedRetriable(row.id, 'Review persistence verification failed', 300000);
          this.sendReplySafe(userId, row.chat_id, this.buildFailureReply());
          return;
        }
        await markReviewRequired(row.id, result.review_reason || 'Needs review', result.confidence);
        this.sendReplySafe(userId, row.chat_id, this.buildReviewReply());
      } else {
        await incrementMetric(userId, 'successful_extractions');
        const transactionsVisible = await this.ensureTransactionsPersisted(userId, row, result, context, savedTransactions);
        if (!transactionsVisible) {
          const reviewCreated = await this.createReviewFallback(userId, row, result, 'Transaction persistence verification failed');
          if (reviewCreated) {
            await incrementMetric(userId, 'pending_review');
            await markReviewRequired(row.id, 'Transaction saved inconsistently. Sent to manual review.', result.confidence);
            this.sendReplySafe(userId, row.chat_id, this.buildReviewReply());
            return;
          }
          await markFailedRetriable(row.id, 'Transaction persistence verification failed', 300000);
          this.sendReplySafe(userId, row.chat_id, this.buildFailureReply());
          return;
        }
        await markCompletedTransaction(row.id, { isFinancial: true, transactionCount: result.transactions.length });
        this.sendReplySafe(userId, row.chat_id, this.buildSuccessReply(result.transactions.length));
      }
    } else {
      await markFailedRetriable(row.id, 'Transaction persistence failed', 300000);
      this.sendReplySafe(userId, row.chat_id, this.buildFailureReply());
    }
  }

  private sendReplySafe(userId: string, chatId: string, text: string) {
    if (!this.replySender || !text.trim()) return;
    void this.replySender(userId, chatId, text).catch((err) => {
      console.warn(`[MessageProcessor | ${userId}] Auto-reply skipped:`, err?.message || err);
    });
  }

  private async waitForTransactionsVisible(userId: string, messageId: string, minimumCount: number) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const { data, error } = await supabaseAdmin
        .from('transactions')
        .select('record_id')
        .eq('user_id', userId)
        .eq('message_id', messageId);

      if (!error && (data?.length || 0) >= Math.max(1, minimumCount)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, this.replyAfterPersistWaitMs));
    }
    return false;
  }

  private async waitForSavedTransactionVisible(userId: string, saved: SavedTransactionResult, messageId: string) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const { data, error } = await supabaseAdmin
        .from('transactions')
        .select('record_id,message_id,idempotency_key')
        .eq('user_id', userId)
        .eq('record_id', saved.recordId)
        .maybeSingle();

      if (!error && data && (data.message_id === messageId || data.idempotency_key === saved.idempotencyKey)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, this.replyAfterPersistWaitMs));
    }
    return false;
  }

  private async ensureTransactionsPersisted(
    userId: string,
    row: IncomingMessageRow,
    result: any,
    context: PipelineContext,
    savedTransactions: Array<{ tx: any; saved: SavedTransactionResult }>
  ) {
    if (savedTransactions.length === 0) return false;

    const initialVisible = await Promise.all(
      savedTransactions.map(({ saved }) => this.waitForSavedTransactionVisible(userId, saved, row.message_id))
    );
    if (initialVisible.every(Boolean)) return true;

    console.warn(`[MessageProcessor | ${userId}] Transaction visibility retry for row=${row.id}`);

    const retriedSaves: Array<{ tx: any; saved: SavedTransactionResult }> = [];
    for (const entry of savedTransactions) {
      try {
        const saved = await saveTransactionToOutputs(entry.tx, context);
        retriedSaves.push({ tx: entry.tx, saved });
      } catch (retryErr) {
        console.error(`[MessageProcessor | ${userId}] Retry save failed row=${row.id}:`, retryErr);
        return false;
      }
    }

    const retriedVisible = await Promise.all(
      retriedSaves.map(({ saved }) => this.waitForSavedTransactionVisible(userId, saved, row.message_id))
    );
    return retriedVisible.every(Boolean);
  }

  private async createReviewFallback(userId: string, row: IncomingMessageRow, result: any, reason: string) {
    try {
      for (const tx of result.transactions) {
        await supabaseAdmin.from('review_queue').upsert([{
          user_id: userId,
          message_id: row.message_id,
          raw_text: tx.raw_text || row.raw_text || result.ocr_text || null,
          suggested_data: tx,
          reason,
          confidence: tx.confidence || result.confidence,
          review_status: 'pending',
        }], { onConflict: 'user_id,message_id' });
      }
      return true;
    } catch (reviewErr) {
      console.error(`[MessageProcessor | ${userId}] Review fallback failed row=${row.id}:`, reviewErr);
      return false;
    }
  }

  private async waitForReviewVisible(userId: string, messageId: string) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const { data, error } = await supabaseAdmin
        .from('review_queue')
        .select('id')
        .eq('user_id', userId)
        .eq('message_id', messageId)
        .eq('review_status', 'pending');

      if (!error && (data?.length || 0) > 0) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, this.replyAfterPersistWaitMs));
    }
    return false;
  }

  private buildSuccessReply(transactionCount: number) {
    const suffix = transactionCount > 1 ? `${transactionCount} transactions were` : 'The transaction was';
    return `Received. ${suffix} processed successfully. If this was a bank transfer, balance updates may take 1 to 2 days to appear.`;
  }

  private buildDuplicateReply(referenceNumber?: string) {
    return referenceNumber
      ? `Received. This transaction was already recorded under reference ${referenceNumber}.`
      : 'Received. This transaction was already recorded.';
  }

  private buildReviewReply() {
    return 'Received. The transaction needs manual review before final confirmation.';
  }

  private buildFailureReply() {
    return 'Received, but processing could not be completed automatically. Please review it manually.';
  }
}

export const messageProcessor = new MessageProcessor();
