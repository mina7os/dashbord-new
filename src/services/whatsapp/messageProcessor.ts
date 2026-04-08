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
  markCompletedDuplicate,
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

      if (result.is_temporarily_unavailable) {
        await markFailedRetriable(row.id, 'AI model temporarily unavailable. Auto retry scheduled.', 60000);
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
        await markCompletedDuplicate(
          row.id,
          `Duplicate reference detected: ${tx.reference_number}`,
          tx.reference_number,
          {
            sender_name: tx.sender_name || row.sender_name || '',
            beneficiary_name: tx.beneficiary_name || '',
            client_name: tx.client_name || '',
            bank_name: tx.bank_name || '',
            amount: tx.amount ?? null,
            currency: tx.currency || 'EGP',
            reference_number: tx.reference_number || null,
            transaction_type: tx.transaction_type || 'transfer',
          }
        );
        this.sendReplySafe(userId, row.chat_id, this.buildDuplicateReply(tx));
        return; 
      }

      try {
        if (reviewRequired || tx.review_required) {
          await this.ensureReviewQueueEntry(userId, row, tx, result.review_reason || tx.review_reason || 'Manual review', tx.confidence || result.confidence, result);
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
          this.sendReplySafe(userId, row.chat_id, this.buildFailureReply(result.transactions));
          return;
        }
        await markReviewRequired(row.id, result.review_reason || 'Needs review', result.confidence);
        this.sendReplySafe(userId, row.chat_id, this.buildReviewReply(result.transactions));
      } else {
        await incrementMetric(userId, 'successful_extractions');
        const transactionsVisible = await this.ensureTransactionsPersisted(userId, row, result, context, savedTransactions);
        if (!transactionsVisible) {
          const reviewCreated = await this.createReviewFallback(userId, row, result, 'Transaction persistence verification failed');
          if (reviewCreated) {
            await incrementMetric(userId, 'pending_review');
            await markReviewRequired(row.id, 'Transaction saved inconsistently. Sent to manual review.', result.confidence);
            this.sendReplySafe(userId, row.chat_id, this.buildReviewReply(result.transactions));
            return;
          }
          await markFailedRetriable(row.id, 'Transaction persistence verification failed', 300000);
          this.sendReplySafe(userId, row.chat_id, this.buildFailureReply(result.transactions));
          return;
        }
        await markCompletedTransaction(row.id, { isFinancial: true, transactionCount: result.transactions.length });
        this.sendReplySafe(userId, row.chat_id, this.buildSuccessReply(result.transactions));
      }
    } else {
      await markFailedRetriable(row.id, 'Transaction persistence failed', 300000);
      this.sendReplySafe(userId, row.chat_id, this.buildFailureReply(result.transactions));
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
        await this.ensureReviewQueueEntry(
          userId,
          row,
          tx,
          reason,
          tx.confidence || result.confidence,
          result
        );
      }
      return true;
    } catch (reviewErr) {
      console.error(`[MessageProcessor | ${userId}] Review fallback failed row=${row.id}:`, reviewErr);
      return false;
    }
  }

  private async ensureLegacyRawMessageBridge(row: IncomingMessageRow, result?: any) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('raw_messages')
      .select('id')
      .eq('message_id', row.message_id)
      .maybeSingle();

    if (existingError) {
      throw new Error(`raw_messages lookup failed: ${existingError.message}`);
    }
    if (existing?.id) return;

    const attachmentType = row.actual_mime_type === 'application/pdf'
      ? 'pdf'
      : (row.actual_mime_type?.startsWith('image/') ? 'image' : (result?.source_type || 'text'));

    const { error } = await supabaseAdmin.from('raw_messages').insert([{
      user_id: row.user_id,
      message_id: row.message_id,
      message_text: row.raw_text || result?.ocr_text || '(binary media)',
      sender_name: row.sender_name || 'Unknown',
      sender_phone: row.sender_id || row.chat_id || 'unknown',
      group_name: row.chat_id || null,
      attachment_url: row.media_url || null,
      attachment_type: attachmentType,
      status: 'pending_review',
    }]);

    if (error) {
      throw new Error(`raw_messages bridge insert failed: ${error.message}`);
    }
  }

  private async ensureReviewQueueEntry(
    userId: string,
    row: IncomingMessageRow,
    tx: any,
    reason: string,
    confidence: number,
    result?: any
  ) {
    await this.ensureLegacyRawMessageBridge(row, result);

    const { data: existing, error: existingError } = await supabaseAdmin
      .from('review_queue')
      .select('id')
      .eq('user_id', userId)
      .eq('message_id', row.message_id)
      .eq('review_status', 'pending')
      .maybeSingle();

    if (existingError) {
      throw new Error(`review_queue lookup failed: ${existingError.message}`);
    }

    if (existing?.id) {
      const { error: updateError } = await supabaseAdmin
        .from('review_queue')
        .update({
          raw_text: tx.raw_text || row.raw_text || result?.ocr_text || null,
          suggested_data: tx,
          reason,
          confidence,
        })
        .eq('id', existing.id);
      if (updateError) {
        throw new Error(`review_queue update failed: ${updateError.message}`);
      }
      return;
    }

    const { error } = await supabaseAdmin.from('review_queue').insert([{
      user_id: userId,
      message_id: row.message_id,
      raw_text: tx.raw_text || row.raw_text || result?.ocr_text || null,
      suggested_data: tx,
      reason,
      confidence,
      attachment_url: row.media_url || null,
      review_status: 'pending',
    }]);

    if (error) {
      throw new Error(`review_queue insert failed: ${error.message}`);
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

  private formatTransactionSubject(transactions: any[]) {
    const first = transactions?.[0] || {};
    const sender = String(first.sender_name || '').trim();
    const amount = Number(first.amount) || 0;
    const currency = String(first.currency || 'EGP').trim() || 'EGP';
    const bank = String(first.bank_name || '').trim();
    const beneficiary = String(first.beneficiary_name || '').trim();
    const amountText = amount > 0 ? `${amount.toLocaleString()} ${currency}` : currency;

    if (sender && beneficiary) return `${sender} to ${beneficiary} (${amountText})`;
    if (sender) return `${sender} (${amountText})`;
    if (beneficiary) return `${beneficiary} (${amountText})`;
    if (bank) return `${bank} (${amountText})`;
    return `your transaction (${amountText})`;
  }

  private buildSuccessReply(transactions: any[]) {
    const transactionCount = transactions?.length || 0;
    const subject = this.formatTransactionSubject(transactions);
    const suffix = transactionCount > 1 ? `${transactionCount} transactions were` : `${subject} was`;
    return `Received. ${suffix} processed successfully. If this was a bank transfer or deposit, balance updates may take 1 to 2 days to appear.`;
  }

  private buildDuplicateReply(tx?: any) {
    const subject = this.formatTransactionSubject(tx ? [tx] : []);
    return tx?.reference_number
      ? `Received. ${subject} was already recorded under reference ${tx.reference_number}.`
      : `Received. ${subject} was already recorded.`;
  }

  private buildReviewReply(transactions: any[]) {
    const subject = this.formatTransactionSubject(transactions);
    return `Received. ${subject} needs manual review before final confirmation.`;
  }

  private buildFailureReply(transactions: any[]) {
    const subject = this.formatTransactionSubject(transactions);
    return `Received, but ${subject} could not be completed automatically. Please review it manually.`;
  }
}

export const messageProcessor = new MessageProcessor();
