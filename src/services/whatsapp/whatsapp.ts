import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

import { Server } from 'socket.io';
import { supabaseAdmin } from '../../lib/supabase-server.ts';
import { messageProcessor } from './messageProcessor.ts';
import { insertIncomingMessage, STAGES } from './incomingMessages.ts';
import { incrementMetric } from '../transactionService.ts';
import fs from 'fs';
import path from 'path';
import { deriveMediaSourceTypeFromMime } from '../../types/media.ts';

const WA_AUTH_TIMEOUT_MS = Number(process.env.WA_AUTH_TIMEOUT_MS || 60000);
const WA_TAKEOVER_TIMEOUT_MS = Number(process.env.WA_TAKEOVER_TIMEOUT_MS || 10000);
const WA_QR_MAX_RETRIES = Number(process.env.WA_QR_MAX_RETRIES || 5);
const WA_STARTUP_TIMEOUT_MS = Number(process.env.WA_STARTUP_TIMEOUT_MS || 180000);
const WA_DISCOVERY_TIMEOUT_MS = Number(process.env.WA_DISCOVERY_TIMEOUT_MS || 25000);
const WA_DISCOVERY_RETRY_DELAY_MS = Number(process.env.WA_DISCOVERY_RETRY_DELAY_MS || 3000);
const WA_DISCOVERY_MAX_ATTEMPTS = Number(process.env.WA_DISCOVERY_MAX_ATTEMPTS || 3);
const WA_REPLY_READY_WAIT_MS = Number(process.env.WA_REPLY_READY_WAIT_MS || 2500);
const WA_REPLY_READY_ATTEMPTS = Number(process.env.WA_REPLY_READY_ATTEMPTS || 6);
const WA_ACTIVE_CHAT_SYNC_INTERVAL_MS = Number(process.env.WA_ACTIVE_CHAT_SYNC_INTERVAL_MS || 20000);
const WA_ACTIVE_CHAT_SYNC_MESSAGE_LIMIT = Number(process.env.WA_ACTIVE_CHAT_SYNC_MESSAGE_LIMIT || 8);
const WA_ACTIVE_CHAT_SYNC_LOOKBACK_SECONDS = Number(process.env.WA_ACTIVE_CHAT_SYNC_LOOKBACK_SECONDS || 1800);
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const WA_AUTO_REPLY_ENABLED = String(process.env.WA_AUTO_REPLY_ENABLED || 'false').toLowerCase() === 'true';

function resolveChromeExecutable(): string | undefined {
  if (PUPPETEER_EXECUTABLE_PATH) return PUPPETEER_EXECUTABLE_PATH;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find(candidate => fs.existsSync(candidate));
}

export interface WAState {
  status: 'disconnected' | 'initializing' | 'qr' | 'loading' | 'authenticated' | 'ready' | 'reconnecting' | 'failed';
  qr?: string;
  message?: string;
  percent?: number;
  reason?: string;
  lastEvent?: string;
  lastUpdatedAt?: string;
}

type WhatsAppClient = any;

export type ChatMessagePreview = {
  id: string;
  chatId: string;
  body: string;
  fromMe: boolean;
  senderName: string;
  timestamp: string | null;
  hasMedia: boolean;
};

// -----------------------------
// Pure Helpers
// -----------------------------
function getRawMessageText(msg: any): string {
  return msg.body || msg.caption || msg._data?.caption || '';
}

function getMessageUniqueId(msg: any): string {
  return msg?.id?.id || msg?.id?._serialized || '';
}

function getMessageTimestampISO(msg: any): string | null {
  const raw = Number(msg?.timestamp || 0);
  if (!raw) return null;
  return new Date(raw * 1000).toISOString();
}

async function resolveSenderDisplayName(msg: any, client: WhatsAppClient): Promise<string> {
  try {
    const contact = await msg.getContact();
    return contact.pushname || contact.name || contact.number || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function resolveChatDisplayName(chat: any): Promise<string> {
  try {
    return chat.name || chat.id._serialized || 'Unknown Chat';
  } catch {
    return 'Unknown Chat';
  }
}

async function downloadMessageMediaRobust(msg: any): Promise<{ imageBuffer?: Buffer; mimeType?: string }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const media = await Promise.race([
        msg.downloadMedia(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Media download timeout')), 15000))
      ]) as any;
      if (media?.data) {
        return { imageBuffer: Buffer.from(media.data, 'base64'), mimeType: media.mimetype };
      }
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return {};
}

async function safeDestroyClient(client: WhatsAppClient) {
  try {
    if (client.pupPage && !client.pupPage.isClosed()) await client.pupPage.close().catch(() => {});
    if (client.pupBrowser) await client.pupBrowser.close().catch(() => {});
    await client.destroy().catch(() => {});
  } catch (e) {}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveChatConfig(userId: string, chatId: string) {
  const { data } = await supabaseAdmin
    .from('whatsapp_connected_chats')
    .select('*')
    .eq('user_id', userId)
    .eq('chat_id', chatId)
    .eq('is_active', true)
    .maybeSingle();
  return data;
}

async function getLightweightChats(client: WhatsAppClient): Promise<Array<{ id: string; name: string; isGroup: boolean; unreadCount: number }>> {
  return client.pupPage.evaluate(() => {
    try {
      const models = window.require('WAWebCollections').Chat.getModelsArray();
      return models
        .map((chat: any) => {
          const id = chat?.id?._serialized || chat?.id?.toString?.() || '';
          const name = chat?.formattedTitle || chat?.name || id || 'Unknown Chat';
          const isGroup = Boolean(chat?.groupMetadata || chat?.isGroup);
          const unreadCount = Number(chat?.unreadCount || 0);
          return { id, name, isGroup, unreadCount };
        })
        .filter((chat: any) => chat.id && !chat.id.includes('status@broadcast'));
    } catch (error: any) {
      throw new Error(error?.message || 'Failed to read WhatsApp chat collection');
    }
  });
}

async function getLightweightContacts(client: WhatsAppClient): Promise<Array<{ id: string; name: string; isGroup: boolean; unreadCount: number }>> {
  return client.pupPage.evaluate(() => {
    try {
      const models = window.require('WAWebCollections').Contact.getModelsArray();
      return models
        .map((contact: any) => {
          const id = contact?.id?._serialized || '';
          const name =
            contact?.formattedName ||
            contact?.pushname ||
            contact?.name ||
            contact?.shortName ||
            id ||
            'Unknown Contact';
          return {
            id,
            name,
            isGroup: false,
            unreadCount: 0,
            isWAContact: Boolean(contact?.isWAContact),
            isMyContact: Boolean(contact?.isMyContact),
            isMe: Boolean(contact?.isMe),
          };
        })
        .filter((contact: any) => contact.id.endsWith('@c.us') && contact.isWAContact && !contact.isMe)
        .map(({ id, name, isGroup, unreadCount }: any) => ({ id, name, isGroup, unreadCount }));
    } catch (error: any) {
      throw new Error(error?.message || 'Failed to read WhatsApp contact collection');
    }
  });
}

// -----------------------------
// Main Manager
// -----------------------------
export class WhatsAppManager {
  private activeClients: Map<string, WhatsAppClient> = new Map(); // Only 'ready' clients
  private initializingClients: Map<string, WhatsAppClient> = new Map(); // Clients bootstrapping
  private states: Map<string, WAState> = new Map();
  private cachedChats: Map<string, Array<{ id: string; name: string; isGroup: boolean; unreadCount: number }>> = new Map();
  
  private inFlightMessages: Set<string> = new Set();
  private startupLocks: Map<string, { startedAt: number }> = new Map();
  private generations: Map<string, number> = new Map();
  private stageTimers: Map<string, NodeJS.Timeout> = new Map();
  private failureCounts: Map<string, number> = new Map();
  private ignoredOutgoingMessages: Map<string, Set<string>> = new Map();
  private activeChatSyncTimers: Map<string, NodeJS.Timeout> = new Map();

  private io: Server;

  constructor(io: Server) {
    this.io = io;
    this.handleConnectionFailure = this.handleConnectionFailure.bind(this);
    this.clearRuntimeState = this.clearRuntimeState.bind(this);
    this.startInstance = this.startInstance.bind(this);
    this.handleIncomingMessage = this.handleIncomingMessage.bind(this);
    this.sendAutomatedReply = this.sendAutomatedReply.bind(this);
    messageProcessor.setReplySender(this.sendAutomatedReply);
  }

  getStatus(userId: string): WAState {
    return this.states.get(userId) || { status: 'disconnected' };
  }

  private getReadyClient(userId: string): WhatsAppClient {
    const client = this.activeClients.get(userId);
    if (!client || this.getStatus(userId).status !== 'ready') {
      throw new Error('WhatsApp instance is not fully ready. Please wait for the green status.');
    }
    return client;
  }

  private async assertActiveChat(userId: string, chatId: string): Promise<void> {
    const chatConfig = await getActiveChatConfig(userId, chatId);
    if (!chatConfig) throw new Error('This chat is not configured as an active WhatsApp source.');
  }

  private async mapChatMessage(chatId: string, msg: any, client: WhatsAppClient): Promise<ChatMessagePreview> {
    const rawBody = getRawMessageText(msg).trim();
    const hasMedia = Boolean(msg?.hasMedia);
    return {
      id: getMessageUniqueId(msg) || `${chatId}-${msg?.timestamp || Date.now()}`,
      chatId,
      body: rawBody || (hasMedia ? '[Media attachment]' : '[Empty message]'),
      fromMe: Boolean(msg?.fromMe),
      senderName: msg?.fromMe ? 'You' : await resolveSenderDisplayName(msg, client),
      timestamp: getMessageTimestampISO(msg),
      hasMedia,
    };
  }

  private emitState(userId: string, eventName: string, partial: Partial<WAState>) {
    const current = this.states.get(userId) || { status: 'disconnected' };
    const next: WAState = { ...current, ...partial, lastEvent: eventName, lastUpdatedAt: new Date().toISOString() };
    this.states.set(userId, next);
    console.log(`[WhatsApp | ${userId}] State Update [${eventName}] =>`, { status: next.status, reason: next.reason });
    this.io.to(userId).emit('whatsapp_status_update', next);
  }

  private clearRuntimeState(userId: string, preserveReason?: string, emit: boolean = true) {
    this.activeClients.delete(userId);
    this.initializingClients.delete(userId);
    this.cachedChats.delete(userId);
    const syncTimer = this.activeChatSyncTimers.get(userId);
    if (syncTimer) {
      clearInterval(syncTimer);
      this.activeChatSyncTimers.delete(userId);
    }

    const current = this.states.get(userId) || { status: 'disconnected' as const };
    if (emit) {
      this.emitState(userId, 'runtime_cleared', {
        status: 'disconnected',
        reason: preserveReason ?? current.reason,
        percent: undefined, message: undefined, qr: undefined
      });
    } else {
      this.states.set(userId, { ...current, status: 'disconnected', reason: preserveReason ?? current.reason });
    }
  }

  private clearStageTimer(userId: string) {
    const t = this.stageTimers.get(userId);
    if (t) { clearTimeout(t); this.stageTimers.delete(userId); }
  }

  private setStageTimer(userId: string, stage: string, ms: number) {
    this.clearStageTimer(userId);
    const timer = setTimeout(async () => {
      console.error(`[WhatsApp | ${userId}] Stage watchdog fired: stuck in '${stage}' for ${ms}ms.`);
      await this.handleConnectionFailure(userId, `Stuck in '${stage}' stage after ${ms}ms`);
    }, ms);
    this.stageTimers.set(userId, timer);
  }

  private async cleanChromiumLocks(userId: string) {
    const sessionDir = path.join(process.cwd(), '.wwebjs_auth', `session-user-${userId}`);
    const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
    for (const lock of locks) {
      try {
        const lockPath = path.join(sessionDir, lock);
        if (fs.existsSync(lockPath)) await fs.promises.unlink(lockPath);
      } catch (e) {}
    }
  }

  private async handleConnectionFailure(userId: string, reason: string) {
    this.clearStageTimer(userId);
    this.startupLocks.delete(userId); 
    
    await this.teardownClient(userId);
    messageProcessor.stop(userId);

    const failures = (this.failureCounts.get(userId) || 0) + 1;
    this.failureCounts.set(userId, failures);

    if (reason.includes('Auth Failure')) {
      await this.executeHardWipe(userId);
      this.failureCounts.delete(userId);
      this.clearRuntimeState(userId, `Authentication failed. Please re-link your device.`);
    } else if (failures <= 2) {
      await this.cleanChromiumLocks(userId);
      this.clearRuntimeState(userId, `Recovering connection: ${reason}. Retrying...`);
      this.scheduleReconnect(userId);
    } else {
      this.emitState(userId, 'failed', { status: 'failed', reason: `Failed to connect after ${failures} tries.` });
      this.clearRuntimeState(userId, `Failed to connect after ${failures} tries. Please manually reconnect.`, false);
    }
  }

  private scheduleReconnect(userId: string) {
    this.emitState(userId, 'reconnecting', { status: 'reconnecting' });
    setTimeout(() => this.startInstance(userId), 3000);
  }

  async restoreExistingSessions(): Promise<void> {
    const authDir = path.join(process.cwd(), '.wwebjs_auth');
    if (!fs.existsSync(authDir)) return;
    try {
      const restoredUserIds = new Set<string>();
      const dirs = fs.readdirSync(authDir);
      for (const d of dirs) {
        let userId = '';
        if (d.startsWith('session-user-')) userId = d.replace('session-user-', '');
        else if (d.startsWith('session-')) userId = d.replace('session-', '');

        if (userId && !restoredUserIds.has(userId)) {
          console.log(`[WhatsApp] Auto-restoring session for user: ${userId}`);
          restoredUserIds.add(userId);
          this.startInstance(userId).catch(() => {});
        }
      }
    } catch {}
  }

  async startInstance(userId: string, options?: { freshSession?: boolean }): Promise<void> {
    const currentGen = (this.generations.get(userId) || 0) + 1;
    this.generations.set(userId, currentGen);
    
    // Check real startup lock
    const existingLock = this.startupLocks.get(userId);
    if (existingLock && (Date.now() - existingLock.startedAt) < WA_STARTUP_TIMEOUT_MS) {
      console.warn(`[WhatsApp | ${userId}] Startup already in progress. Ignoring duplicate.`);
      return;
    }
    
    this.startupLocks.set(userId, { startedAt: Date.now() });
    await this.cleanChromiumLocks(userId);

    try {
      if (options?.freshSession) {
        await this.executeHardWipe(userId);
        this.failureCounts.delete(userId);
      }

      const state = this.getStatus(userId);
      if (this.activeClients.has(userId) && ['ready', 'authenticated', 'loading'].includes(state.status)) {
        this.startupLocks.delete(userId);
        return;
      }
      
      await this.teardownClient(userId);

      this.emitState(userId, 'init', { status: 'initializing', message: 'Starting WhatsApp...', qr: undefined });
      this.setStageTimer(userId, 'initializing', WA_STARTUP_TIMEOUT_MS);

      const client = this.createClient(userId);
      this.initializingClients.set(userId, client);
      this.bindClientEvents(userId, client, currentGen);

      await client.initialize();
    } catch (err: any) {
      this.startupLocks.delete(userId);
      if (this.generations.get(userId) === currentGen) {
        await this.handleConnectionFailure(userId, `Initialize Error: ${err.message}`);
      }
    }
  }

  private createClient(userId: string): WhatsAppClient {
    return new Client({
      authStrategy: new LocalAuth({ clientId: `user-${userId}` }),
      puppeteer: {
        headless: true,
        executablePath: resolveChromeExecutable(),
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas', '--no-first-run', '--no-default-browser-check',
          '--disable-extensions', '--disable-gpu'
        ],
        protocolTimeout: 180000,
      },
      authTimeoutMs: WA_AUTH_TIMEOUT_MS,
      takeoverTimeoutMs: WA_TAKEOVER_TIMEOUT_MS,
      qrMaxRetries: WA_QR_MAX_RETRIES,
      webVersionCache: {
        type: 'remote',
        remotePath: (process.env.WWEBJS_REMOTE_HTML || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html')
          .replace('{version}', process.env.WWEBJS_WEB_VERSION || '2.2412.54')
      }
    });
  }

  private bindClientEvents(userId: string, client: WhatsAppClient, currentGen: number) {
    client.on('qr', (qr: string) => {
      if (this.generations.get(userId) !== currentGen) return;
      this.clearStageTimer(userId);
      this.emitState(userId, 'qr', { status: 'qr', qr });
    });

    client.on('loading_screen', (percent: number, message: string) => {
      if (this.generations.get(userId) !== currentGen) return;
      this.setStageTimer(userId, 'loading', 120000);
      this.emitState(userId, 'loading', { status: 'loading', percent, message });
    });

    client.on('authenticated', () => {
      if (this.generations.get(userId) !== currentGen) return;
      this.clearStageTimer(userId);
      this.emitState(userId, 'auth', { status: 'authenticated' });
    });

    client.on('auth_failure', (msg: string) => {
      if (this.generations.get(userId) !== currentGen) return;
      this.handleConnectionFailure(userId, `Auth Failure: ${msg}`);
    });

    client.on('ready', async () => {
      if (this.generations.get(userId) !== currentGen) return;
      this.markReady(userId, client);
    });

    client.on('disconnected', (reason: string) => {
      if (this.generations.get(userId) !== currentGen) return;
      this.handleConnectionFailure(userId, `Disconnected: ${reason}`);
    });

    const onIncoming = async (eventName: string, msg: any) => {
      if (this.generations.get(userId) !== currentGen) return;

      const state = this.getStatus(userId).status;
      if (!['ready', 'loading', 'authenticated'].includes(state)) {
        console.log(`[WhatsApp | ${userId}] Skipping ${eventName} while state=${state}`);
        return;
      }

      await this.handleIncomingMessage(userId, msg, client, eventName);
    };

    client.on('message', async (msg: any) => {
      await onIncoming('message', msg);
    });

    client.on('message_create', async (msg: any) => {
      await onIncoming('message_create', msg);
    });
  }

  private markReady(userId: string, client: WhatsAppClient) {
    this.clearStageTimer(userId);
    this.startupLocks.delete(userId);
    
    // Promote client to authoritative structure
    this.initializingClients.delete(userId);
    this.activeClients.set(userId, client);
    
    this.emitState(userId, 'ready', { status: 'ready' });
    messageProcessor.start(userId);
    this.startActiveChatSync(userId, client);
  }

  private async teardownClient(userId: string) {
    const active = this.activeClients.get(userId);
    const init = this.initializingClients.get(userId);
    if (active) await safeDestroyClient(active);
    if (init && init !== active) await safeDestroyClient(init);
    this.activeClients.delete(userId);
    this.initializingClients.delete(userId);
  }

  async handleIncomingMessage(userId: string, msg: any, client: WhatsAppClient, eventName: string = 'message_create'): Promise<'captured' | 'skipped' | 'failed'> {
    const messageId = getMessageUniqueId(msg);
    const chatId = msg.from;
    
    if (msg.fromMe) console.log(`[WhatsApp | ${userId}] 📥 Self-Message Intake via ${eventName}: ID=${messageId} chatId=${chatId}`);
    console.log(`[WhatsApp | ${userId}] 📨 Incoming msg via ${eventName} chatId=${chatId} fromMe=${msg.fromMe} hasMedia=${msg.hasMedia}`);
    if (!messageId || !chatId) return 'skipped';
    if (msg.fromMe && this.isIgnoredOutgoingMessage(userId, messageId)) {
      return 'skipped';
    }

    const iFKey = `${userId}:${messageId}`;
    if (this.inFlightMessages.has(iFKey)) return 'skipped';
    this.inFlightMessages.add(iFKey);

    try {
      const chatConfig = await getActiveChatConfig(userId, chatId);
      if (!chatConfig) {
        console.log(`[WhatsApp | ${userId}] ⚠️ SKIPPED — chatId=${chatId} is not a configured source. Go to Configure Sources and add this chat.`);
        return 'skipped';
      }

      const { data: existingIncoming } = await supabaseAdmin
        .from('incoming_messages')
        .select('id')
        .eq('user_id', userId)
        .eq('message_id', messageId)
        .maybeSingle();
      if (existingIncoming?.id) {
        return 'skipped';
      }

      const senderDisplayName = await resolveSenderDisplayName(msg, client);
      const rawText = getRawMessageText(msg);
      const hadMedia = Boolean(msg.hasMedia);
      
      let mediaUrl, actualMimeType, lastError;
      let mediaCaptureStage: string = STAGES.RECEIVED;
      let processingStatus: 'pending' | 'media_capture_failed' = 'pending';
      
      if (hadMedia) {
        try {
          const m = await downloadMessageMediaRobust(msg);
          if (m.imageBuffer) {
            const fileName = `${userId}/${messageId}-${Date.now()}.${m.mimeType?.split('/')[1] || 'bin'}`;
            const { data, error } = await supabaseAdmin.storage.from('receipts').upload(fileName, m.imageBuffer, { contentType: m.mimeType });
            if (error) throw error;
            mediaUrl = data.path;
            actualMimeType = m.mimeType;
            mediaCaptureStage = STAGES.MEDIA_PERSISTED;
          } else throw new Error('Media download returned no binary payload');
        } catch (mediaErr: any) {
          lastError = `Media capture failed: ${mediaErr.message}`;
          processingStatus = 'media_capture_failed';
          mediaCaptureStage = STAGES.MEDIA_CAPTURE_FAILED;
        }
      }

      const mediaCaptured = Boolean(mediaUrl);
      const incomingId = await insertIncomingMessage({
        userId, messageId, chatId, senderId: msg.author || msg.from, senderName: senderDisplayName,
        rawText, hasMedia: mediaCaptured, actualMimeType, mediaUrl, processingStage: mediaCaptureStage,
        processingStatus, lastError, metadata: {
          had_media: hadMedia, media_captured: mediaCaptured, mime_type: actualMimeType || null,
          normalized_modality: deriveMediaSourceTypeFromMime(actualMimeType, hadMedia)
        }
      });

      if (!incomingId) return 'skipped';

      await incrementMetric(userId, 'total_messages');
      if (mediaCaptureStage === 'media_persisted') await incrementMetric(userId, 'media_capture_success');
      else if (mediaCaptureStage === 'media_capture_failed') await incrementMetric(userId, 'media_capture_failed');

      this.io.to(userId).emit('whatsapp_message_received', {
        id: incomingId, message_id: messageId, chat_id: chatId, status: processingStatus, stage: mediaCaptureStage
      });
      return 'captured';
    } catch (err: any) {
      console.error(`[WhatsApp | ${userId}] ❌ Fatal intake error (ID=${messageId}):`, err.message);
      return 'failed';
    } finally {
      this.inFlightMessages.delete(iFKey);
    }
  }

  async getAvailableChats(userId: string) {
    const cached = this.cachedChats.get(userId);
    if (cached && cached.length > 0) return cached;

    const client = this.getReadyClient(userId);
    let lastMapped: Array<{ id: string; name: string; isGroup: boolean; unreadCount: number }> = [];

    for (let attempt = 1; attempt <= WA_DISCOVERY_MAX_ATTEMPTS; attempt++) {
      let mapped: Array<{ id: string; name: string; isGroup: boolean; unreadCount: number }> = [];

      try {
        mapped = await withTimeout(
          getLightweightChats(client),
          8000,
          'Lightweight chat discovery timed out.'
        );
        console.log(`[WhatsApp | ${userId}] Lightweight chat discovery returned ${mapped.length} chats on attempt ${attempt}.`);
      } catch (chatError: any) {
        console.warn(`[WhatsApp | ${userId}] Lightweight chat discovery failed on attempt ${attempt}:`, chatError?.message || chatError);
      }

      if (mapped.length === 0) {
        try {
          mapped = await withTimeout(
            getLightweightContacts(client),
            8000,
            'Contact discovery fallback timed out. Please try again in a few seconds.'
          );
          console.log(`[WhatsApp | ${userId}] Contact fallback returned ${mapped.length} contacts on attempt ${attempt}.`);
        } catch (contactError: any) {
          console.warn(`[WhatsApp | ${userId}] Contact fallback failed on attempt ${attempt}:`, contactError?.message || contactError);
        }
      }

      lastMapped = mapped;
      if (mapped.length > 0) {
        this.cachedChats.set(userId, mapped);
        console.log(`[WhatsApp | ${userId}] Chat discovery returned ${mapped.length} chats on attempt ${attempt}.`);
        return mapped;
      }

      if (attempt < WA_DISCOVERY_MAX_ATTEMPTS) {
        await sleep(WA_DISCOVERY_RETRY_DELAY_MS);
      }
    }

    console.warn(`[WhatsApp | ${userId}] Chat discovery returned no chats after ${WA_DISCOVERY_MAX_ATTEMPTS} attempts.`);
    throw new Error('No WhatsApp chats or contacts were available yet. Open WhatsApp on your phone, wait a few seconds after Ready, then try Configure Sources again.');
  }

  async getRecentMessages(userId: string, chatId: string, limit: number = 40): Promise<ChatMessagePreview[]> {
    await this.assertActiveChat(userId, chatId);
    const client = this.getReadyClient(userId);
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: Math.max(1, Math.min(limit, 100)) });
    const sorted = [...messages].sort((a: any, b: any) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
    return Promise.all(sorted.map((msg: any) => this.mapChatMessage(chatId, msg, client)));
  }

  async sendMessageToChat(userId: string, chatId: string, text: string): Promise<ChatMessagePreview> {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Message text is required.');
    await this.assertActiveChat(userId, chatId);
    const client = this.getReadyClient(userId);
    const sent = await client.sendMessage(chatId, trimmed);
    return this.mapChatMessage(chatId, sent, client);
  }

  async sendAutomatedReply(userId: string, chatId: string, text: string): Promise<void> {
    if (!WA_AUTO_REPLY_ENABLED) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    try {
      const client = await this.waitForReadyClient(userId);
      const sent = await client.sendMessage(chatId, trimmed);
      const sentId = getMessageUniqueId(sent);
      if (sentId) {
        const bucket = this.ignoredOutgoingMessages.get(userId) || new Set<string>();
        bucket.add(sentId);
        this.ignoredOutgoingMessages.set(userId, bucket);
        setTimeout(() => bucket.delete(sentId), 10 * 60 * 1000);
      }
      console.log(`[WhatsApp | ${userId}] Auto reply sent to ${chatId}`);
    } catch (err: any) {
      console.warn(`[WhatsApp | ${userId}] Auto reply failed:`, err.message || err);
    }
  }

  private async waitForReadyClient(userId: string): Promise<WhatsAppClient> {
    for (let attempt = 1; attempt <= WA_REPLY_READY_ATTEMPTS; attempt++) {
      const client = this.activeClients.get(userId);
      const state = this.getStatus(userId).status;
      if (client && state === 'ready') {
        return client;
      }

      if (!['loading', 'authenticated', 'initializing', 'reconnecting', 'ready'].includes(state)) {
        break;
      }

      await sleep(WA_REPLY_READY_WAIT_MS);
    }

    return this.getReadyClient(userId);
  }

  private isIgnoredOutgoingMessage(userId: string, messageId: string): boolean {
    const bucket = this.ignoredOutgoingMessages.get(userId);
    if (!bucket) return false;
    if (!bucket.has(messageId)) return false;
    bucket.delete(messageId);
    return true;
  }

  async stopInstance(userId: string, wipeSession: boolean = false): Promise<void> {
    await this.teardownClient(userId);
    messageProcessor.stop(userId);
    this.startupLocks.delete(userId);
    this.clearRuntimeState(userId, undefined);
    if (wipeSession) await this.executeHardWipe(userId);
  }

  async resetInstance(userId: string): Promise<void> {
    await this.stopInstance(userId, true);
    this.emitState(userId, 'reset', { status: 'disconnected', qr: undefined });
  }

  private async executeHardWipe(userId: string): Promise<void> {
    const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-user-${userId}`);
    if (fs.existsSync(sessionPath)) {
      await fs.promises.rm(sessionPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async backfillChat(userId: string, chatId: string, lookbackMinutes: number = 120): Promise<{ processed: number; skipped: number; errors: number }> {
    const client = this.getReadyClient(userId);
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 2000 });
    const cutoffTs = (Date.now() / 1000) - (lookbackMinutes * 60);

    let processed = 0, skipped = 0, errors = 0;
    for (const msg of messages) {
      if (Number(msg.timestamp) < cutoffTs) continue;
      try {
        const outcome = await this.handleIncomingMessage(userId, msg, client);
        if (outcome === 'captured') processed++;
        else if (outcome === 'skipped') skipped++;
        else errors++;
      } catch { errors++; }
    }
    this.io.to(userId).emit('backfill_complete', { processed, skipped, errors });
    return { processed, skipped, errors };
  }

  private startActiveChatSync(userId: string, client: WhatsAppClient) {
    const existingTimer = this.activeChatSyncTimers.get(userId);
    if (existingTimer) clearInterval(existingTimer);

    const timer = setInterval(() => {
      void this.syncActiveChats(userId, client);
    }, WA_ACTIVE_CHAT_SYNC_INTERVAL_MS) as unknown as NodeJS.Timeout;

    this.activeChatSyncTimers.set(userId, timer);
    void this.syncActiveChats(userId, client);
  }

  private async syncActiveChats(userId: string, client: WhatsAppClient) {
    if (this.getStatus(userId).status !== 'ready') return;

    const { data: activeChats, error } = await supabaseAdmin
      .from('whatsapp_connected_chats')
      .select('chat_id')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error || !activeChats?.length) return;

    const cutoffTs = Math.floor(Date.now() / 1000) - WA_ACTIVE_CHAT_SYNC_LOOKBACK_SECONDS;

    for (const row of activeChats) {
      try {
        const chat = await client.getChatById(row.chat_id);
        const messages = await chat.fetchMessages({ limit: WA_ACTIVE_CHAT_SYNC_MESSAGE_LIMIT });
        const sorted = [...messages].sort((a: any, b: any) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));

        for (const msg of sorted) {
          if (Number(msg?.timestamp || 0) < cutoffTs) continue;
          await this.handleIncomingMessage(userId, msg, client, 'active_chat_sync');
        }
      } catch (err: any) {
        console.warn(`[WhatsApp | ${userId}] Active chat sync failed for ${row.chat_id}:`, err?.message || err);
      }
    }
  }
}
