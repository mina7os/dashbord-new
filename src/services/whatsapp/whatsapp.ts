import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

import { Server } from 'socket.io';
import { supabaseAdmin } from '../../lib/supabase-server.ts';
import { messageProcessor } from './messageProcessor.ts';
import { insertIncomingMessage, STAGES } from './incomingMessages.ts';
import { incrementMetric } from '../transactionService.ts';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { deriveMediaSourceTypeFromMime } from '../../types/media.ts';

const WA_AUTH_TIMEOUT_MS = Number(process.env.WA_AUTH_TIMEOUT_MS || 60000);
const WA_TAKEOVER_TIMEOUT_MS = Number(process.env.WA_TAKEOVER_TIMEOUT_MS || 10000);
const WA_QR_MAX_RETRIES = Number(process.env.WA_QR_MAX_RETRIES || 5);
const WA_STARTUP_TIMEOUT_MS = Number(process.env.WA_STARTUP_TIMEOUT_MS || 180000);
const WA_DISCOVERY_TIMEOUT_MS = Number(process.env.WA_DISCOVERY_TIMEOUT_MS || 25000);
const WA_DISCOVERY_RETRY_DELAY_MS = Number(process.env.WA_DISCOVERY_RETRY_DELAY_MS || 3000);
const WA_DISCOVERY_MAX_ATTEMPTS = Number(process.env.WA_DISCOVERY_MAX_ATTEMPTS || 3);
const WA_DISCOVERY_LIGHTWEIGHT_TIMEOUT_MS = Math.max(3000, Number(process.env.WA_DISCOVERY_LIGHTWEIGHT_TIMEOUT_MS || 8000));
const WA_DISCOVERY_CONTACT_TIMEOUT_MS = Math.max(3000, Number(process.env.WA_DISCOVERY_CONTACT_TIMEOUT_MS || 5000));
const WA_DISCOVERY_HYDRATED_TIMEOUT_MS = Math.max(5000, Number(process.env.WA_DISCOVERY_HYDRATED_TIMEOUT_MS || 12000));
const WA_REPLY_READY_WAIT_MS = Number(process.env.WA_REPLY_READY_WAIT_MS || 2500);
const WA_REPLY_READY_ATTEMPTS = Number(process.env.WA_REPLY_READY_ATTEMPTS || 6);
const WA_RECONNECT_MAX_ATTEMPTS = Math.max(3, Number(process.env.WA_RECONNECT_MAX_ATTEMPTS || 6));
const WA_RECONNECT_BASE_DELAY_MS = Math.max(2000, Number(process.env.WA_RECONNECT_BASE_DELAY_MS || 5000));
const WA_RECONNECT_MAX_DELAY_MS = Math.max(WA_RECONNECT_BASE_DELAY_MS, Number(process.env.WA_RECONNECT_MAX_DELAY_MS || 60000));
const WA_LOADING_TIMEOUT_MS = Math.max(120000, Number(process.env.WA_LOADING_TIMEOUT_MS || 180000));
const WA_AUTHENTICATED_TIMEOUT_MS = Math.max(60000, Number(process.env.WA_AUTHENTICATED_TIMEOUT_MS || 90000));
const WA_AUTO_RESTORE_LOOKBACK_DAYS = Math.max(1, Number(process.env.WA_AUTO_RESTORE_LOOKBACK_DAYS || 30));
const WA_AUTO_RESTORE_MAX_SESSIONS = Math.max(1, Number(process.env.WA_AUTO_RESTORE_MAX_SESSIONS || 2));
const WA_AUTO_RESTORE_START_DELAY_MS = Math.max(1000, Number(process.env.WA_AUTO_RESTORE_START_DELAY_MS || 15000));
const WA_ACTIVE_CHAT_SYNC_INTERVAL_MS = Number(process.env.WA_ACTIVE_CHAT_SYNC_INTERVAL_MS || 20000);
const WA_ACTIVE_CHAT_SYNC_MESSAGE_LIMIT = Number(process.env.WA_ACTIVE_CHAT_SYNC_MESSAGE_LIMIT || 8);
const WA_ACTIVE_CHAT_SYNC_LOOKBACK_SECONDS = Number(process.env.WA_ACTIVE_CHAT_SYNC_LOOKBACK_SECONDS || 1800);
const WA_MESSAGE_DEDUPE_TTL_MS = Number(process.env.WA_MESSAGE_DEDUPE_TTL_MS || 10 * 60 * 1000);
const WWEBJS_WEB_VERSION = String(process.env.WWEBJS_WEB_VERSION || '').trim();
const WWEBJS_REMOTE_HTML = String(process.env.WWEBJS_REMOTE_HTML || '').trim();
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
type ChatSummary = { id: string; name: string; isGroup: boolean; unreadCount: number };
type StoredSessionInfo = { userId: string; dirName: string; touchedAt: number };

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

function normalizeText(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const AUTOMATED_REPLY_PREFIXES = [
  'received.',
  'received, but',
];

function getMessageTimestampISO(msg: any): string | null {
  const raw = Number(msg?.timestamp || 0);
  if (!raw) return null;
  return new Date(raw * 1000).toISOString();
}

function isKnownAutomatedReplyText(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (!AUTOMATED_REPLY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }

  return (
    normalized.includes('processed successfully') ||
    normalized.includes('already recorded') ||
    normalized.includes('needs manual review') ||
    normalized.includes('could not be completed automatically') ||
    normalized.includes('was reviewed and rejected') ||
    normalized.includes('was approved and processed successfully')
  );
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

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(file, args, () => resolve());
  });
}

function mergeChatSummaries(...sources: ChatSummary[][]): ChatSummary[] {
  const merged = new Map<string, ChatSummary>();

  for (const source of sources) {
    for (const item of source) {
      if (!item?.id) continue;

      const existing = merged.get(item.id);
      if (!existing) {
        merged.set(item.id, item);
        continue;
      }

      merged.set(item.id, {
        id: item.id,
        name: existing.name && existing.name !== existing.id ? existing.name : item.name,
        isGroup: existing.isGroup || item.isGroup,
        unreadCount: Math.max(existing.unreadCount || 0, item.unreadCount || 0),
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
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

async function getDatabaseBackedChats(userId: string): Promise<ChatSummary[]> {
  const [connectedChatsRes, incomingMessagesRes] = await Promise.all([
    supabaseAdmin
      .from('whatsapp_connected_chats')
      .select('chat_id, chat_name, chat_type, is_active, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(100),
    supabaseAdmin
      .from('incoming_messages')
      .select('chat_id, sender_name, received_at')
      .eq('user_id', userId)
      .order('received_at', { ascending: false })
      .limit(200),
  ]);

  const connectedChats = Array.isArray(connectedChatsRes.data) ? connectedChatsRes.data : [];
  const incomingMessages = Array.isArray(incomingMessagesRes.data) ? incomingMessagesRes.data : [];

  const fromConnections: ChatSummary[] = connectedChats
    .map((row: any) => ({
      id: String(row.chat_id || '').trim(),
      name: String(row.chat_name || row.chat_id || 'Known Source').trim(),
      isGroup: String(row.chat_type || '').toLowerCase() === 'group',
      unreadCount: row.is_active ? 1 : 0,
    }))
    .filter((row) => row.id);

  const seen = new Set(fromConnections.map((row) => row.id));
  const fromIncoming: ChatSummary[] = [];
  for (const row of incomingMessages) {
    const chatId = String((row as any).chat_id || '').trim();
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    fromIncoming.push({
      id: chatId,
      name: String((row as any).sender_name || chatId || 'Recent WhatsApp Chat').trim(),
      isGroup: chatId.endsWith('@g.us'),
      unreadCount: 0,
    });
  }

  return mergeChatSummaries(fromConnections, fromIncoming);
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

async function getHydratedContacts(client: WhatsAppClient): Promise<ChatSummary[]> {
  const contacts = await (client.getContacts() as Promise<any[]>);
  return (Array.isArray(contacts) ? contacts : [])
    .map((contact: any) => ({
      id: contact?.id?._serialized || '',
      name:
        contact?.pushname ||
        contact?.name ||
        contact?.shortName ||
        contact?.number ||
        contact?.formattedName ||
        contact?.id?._serialized ||
        'Unknown Contact',
      isGroup: false,
      unreadCount: 0,
      isWAContact: Boolean(contact?.isWAContact),
      isMe: Boolean(contact?.isMe),
    }))
    .filter((contact: any) => contact.id.endsWith('@c.us') && contact.isWAContact && !contact.isMe)
    .map(({ id, name, isGroup, unreadCount }: any) => ({ id, name, isGroup, unreadCount }));
}

async function getHydratedChats(client: WhatsAppClient): Promise<ChatSummary[]> {
  const chats = await (client.getChats() as Promise<any[]>);
  return (Array.isArray(chats) ? chats : [])
    .map((chat: any) => ({
      id: chat?.id?._serialized || '',
      name: chat?.name || chat?.formattedTitle || chat?.id?._serialized || 'Unknown Chat',
      isGroup: Boolean(chat?.isGroup),
      unreadCount: Number(chat?.unreadCount || 0),
    }))
    .filter((chat: any) => chat.id && !chat.id.includes('status@broadcast'));
}

function parseStoredSessionInfos(authDir: string): StoredSessionInfo[] {
  if (!fs.existsSync(authDir)) return [];

  const seen = new Set<string>();
  const sessions: StoredSessionInfo[] = [];
  for (const dirName of fs.readdirSync(authDir)) {
    let userId = '';
    if (dirName.startsWith('session-user-')) userId = dirName.replace('session-user-', '');
    else if (dirName.startsWith('session-')) userId = dirName.replace('session-', '');
    if (!userId || seen.has(userId)) continue;

    const dirPath = path.join(authDir, dirName);
    let touchedAt = 0;
    try {
      touchedAt = fs.statSync(dirPath).mtimeMs;
    } catch {}

    seen.add(userId);
    sessions.push({ userId, dirName, touchedAt });
  }

  return sessions.sort((a, b) => b.touchedAt - a.touchedAt);
}

// -----------------------------
// Main Manager
// -----------------------------
export class WhatsAppManager {
  private activeClients: Map<string, WhatsAppClient> = new Map(); // Only 'ready' clients
  private initializingClients: Map<string, WhatsAppClient> = new Map(); // Clients bootstrapping
  private states: Map<string, WAState> = new Map();
  private cachedChats: Map<string, ChatSummary[]> = new Map();
  
  private inFlightMessages: Set<string> = new Set();
  private startupLocks: Map<string, { startedAt: number }> = new Map();
  private generations: Map<string, number> = new Map();
  private stageTimers: Map<string, NodeJS.Timeout> = new Map();
  private failureCounts: Map<string, number> = new Map();
  private ignoredOutgoingMessages: Map<string, Set<string>> = new Map();
  private ignoredOutgoingTexts: Map<string, Set<string>> = new Map();
  private activeChatSyncTimers: Map<string, NodeJS.Timeout> = new Map();
  private recentlySeenMessages: Map<string, number> = new Map();

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

  triggerActiveChatSync(userId: string) {
    const state = this.getStatus(userId).status;
    const client = this.getSyncClient(userId);

    if (!client) return;

    const browserDisconnected = Boolean(client?.pupBrowser?.isConnected && !client.pupBrowser.isConnected());
    const pageClosed = Boolean(client?.pupPage?.isClosed && client.pupPage.isClosed());

    if (browserDisconnected || pageClosed) {
      void this.handleConnectionFailure(userId, 'Browser session became unavailable.');
      return;
    }

    if (state === 'ready') {
      const cached = this.cachedChats.get(userId);
      if (!cached || cached.length === 0) {
        void this.refreshChatCache(userId, client).catch(() => {});
      }
    }
  }

  private getReadyClient(userId: string): WhatsAppClient {
    const client = this.activeClients.get(userId);
    if (!client || this.getStatus(userId).status !== 'ready') {
      throw new Error('WhatsApp instance is not fully ready. Please wait for the green status.');
    }
    return client;
  }

  private getSyncClient(userId: string): WhatsAppClient | null {
    return this.activeClients.get(userId) || this.initializingClients.get(userId) || null;
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
    this.ignoredOutgoingTexts.delete(userId);

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
    const authDir = path.join(process.cwd(), '.wwebjs_auth');
    const sessionDir = path.join(authDir, `session-user-${userId}`);
    const wwebjsCache = path.join(process.cwd(), '.wwebjs_cache');
    const lockNames = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'LOCK']);

    const removeLocks = async (dir: string) => {
      if (!fs.existsSync(dir)) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { continue; }

        if (!lockNames.has(entry.name)) continue;
        try {
          await fs.promises.unlink(entryPath);
          console.log(`[WhatsApp | ${userId}] Cleared stale lock file: ${entryPath}`);
        } catch (e: any) {
          console.warn(`[WhatsApp | ${userId}] Could not clear lock file ${entryPath}:`, e.message);
        }
      }
    };

    if (fs.existsSync(sessionDir)) await removeLocks(sessionDir);
    await removeLocks(authDir);
    await removeLocks(wwebjsCache);
  }

  private async killStaleChromiumProcesses(userId: string) {
    if (process.platform !== 'linux') return;
    const sessionMarker = `session-user-${userId}`;
    try {
      await execFileAsync('pkill', ['-f', sessionMarker]);
    } catch (e) {
      // Ignored: pkill returns >0 if no process matches
    }
    await sleep(1000);
  }

  private async resolveAutoRestoreCandidates(sessions: StoredSessionInfo[]): Promise<StoredSessionInfo[]> {
    if (sessions.length === 0) return [];

    const userIds = sessions.map((session) => session.userId);
    const cutoffIso = new Date(Date.now() - WA_AUTO_RESTORE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const scores = new Map<string, number>();

    const [connectedChatsRes, incomingMessagesRes] = await Promise.all([
      supabaseAdmin
        .from('whatsapp_connected_chats')
        .select('user_id, is_active, updated_at')
        .in('user_id', userIds)
        .order('updated_at', { ascending: false })
        .limit(500),
      supabaseAdmin
        .from('incoming_messages')
        .select('user_id, received_at, created_at')
        .in('user_id', userIds)
        .gte('created_at', cutoffIso)
        .order('created_at', { ascending: false })
        .limit(500),
    ]);

    for (const row of Array.isArray(connectedChatsRes.data) ? connectedChatsRes.data : []) {
      const userId = String((row as any).user_id || '').trim();
      if (!userId) continue;
      const next = (scores.get(userId) || 0) + ((row as any).is_active ? 100 : 25);
      scores.set(userId, next);
    }

    for (const row of Array.isArray(incomingMessagesRes.data) ? incomingMessagesRes.data : []) {
      const userId = String((row as any).user_id || '').trim();
      if (!userId) continue;
      const next = (scores.get(userId) || 0) + 10;
      scores.set(userId, next);
    }

    const ranked = sessions
      .map((session) => ({ session, score: scores.get(session.userId) || 0 }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return b.session.touchedAt - a.session.touchedAt;
      })
      .map(({ session }) => session);

    if (ranked.length > 0) {
      return ranked.slice(0, WA_AUTO_RESTORE_MAX_SESSIONS);
    }

    // Fall back to the most recently touched stored session rather than reviving every stale session.
    return sessions.slice(0, 1);
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
    } else if (reason.includes('Max qrcode retries reached')) {
      await this.executeHardWipe(userId);
      this.failureCounts.delete(userId);
      this.emitState(userId, 'failed', { status: 'failed', reason: 'QR code expired before linking completed.' });
      this.clearRuntimeState(userId, 'QR code expired before linking completed. Please reconnect when you are ready to scan.', false);
    } else if (failures <= WA_RECONNECT_MAX_ATTEMPTS) {
      await this.cleanChromiumLocks(userId);
      const delayMs = Math.min(WA_RECONNECT_BASE_DELAY_MS * Math.max(1, failures), WA_RECONNECT_MAX_DELAY_MS);
      this.clearRuntimeState(userId, `Recovering connection: ${reason}. Retrying in ${Math.round(delayMs / 1000)}s...`);
      this.scheduleReconnect(userId, delayMs);
    } else {
      this.emitState(userId, 'failed', { status: 'failed', reason: `Failed to connect after ${failures} tries.` });
      this.clearRuntimeState(userId, `Failed to connect after ${failures} tries. Please manually reconnect.`, false);
    }
  }

  private scheduleReconnect(userId: string, delayMs: number = WA_RECONNECT_BASE_DELAY_MS) {
    this.emitState(userId, 'reconnecting', {
      status: 'reconnecting',
      message: `Retrying in ${Math.round(delayMs / 1000)}s...`
    });
    setTimeout(() => this.startInstance(userId), delayMs);
  }

  async restoreExistingSessions(): Promise<void> {
    const authDir = path.join(process.cwd(), '.wwebjs_auth');
    if (!fs.existsSync(authDir)) return;
    try {
      const sessions = parseStoredSessionInfos(authDir);
      const candidates = await this.resolveAutoRestoreCandidates(sessions);
      const skipped = sessions.filter((session) => !candidates.some((candidate) => candidate.userId === session.userId));

      if (skipped.length > 0) {
        console.log(`[WhatsApp] Skipping auto-restore for stale sessions: ${skipped.map((session) => session.userId).join(', ')}`);
      }

      for (const [index, session] of candidates.entries()) {
        const delayMs = index * WA_AUTO_RESTORE_START_DELAY_MS;
        console.log(`[WhatsApp] Auto-restoring session for user: ${session.userId}${delayMs ? ` after ${delayMs}ms` : ''}`);
        setTimeout(() => {
          this.startInstance(session.userId).catch(() => {});
        }, delayMs);
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
    await this.killStaleChromiumProcesses(userId);
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
    const clientOptions: any = {
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
    };

    // Checkpoint 2 behavior: only pin a WA Web build when operators explicitly configure it.
    if (WWEBJS_WEB_VERSION && WWEBJS_REMOTE_HTML) {
      clientOptions.webVersionCache = {
        type: 'remote',
        remotePath: WWEBJS_REMOTE_HTML.replace('{version}', WWEBJS_WEB_VERSION),
      };
    }

    return new Client(clientOptions);
  }

  private bindClientEvents(userId: string, client: WhatsAppClient, currentGen: number) {
    client.on('qr', (qr: string) => {
      if (this.generations.get(userId) !== currentGen) return;
      this.clearStageTimer(userId);
      this.emitState(userId, 'qr', { status: 'qr', qr });
    });

    client.on('loading_screen', (percent: number, message: string) => {
      if (this.generations.get(userId) !== currentGen) return;
      this.setStageTimer(userId, 'loading', WA_LOADING_TIMEOUT_MS);
      this.emitState(userId, 'loading', { status: 'loading', percent, message });
    });

    client.on('authenticated', () => {
      if (this.generations.get(userId) !== currentGen) return;
      this.setStageTimer(userId, 'authenticated', WA_AUTHENTICATED_TIMEOUT_MS);
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

  async shutdownAll() {
    console.log('[WhatsApp] Shutting down all active sessions gracefully...');
    const users = Array.from(new Set([...this.activeClients.keys(), ...this.initializingClients.keys()]));
    await Promise.all(users.map(u => this.teardownClient(u).catch(() => {})));
  }

  async handleIncomingMessage(userId: string, msg: any, client: WhatsAppClient, eventName: string = 'message_create'): Promise<'captured' | 'skipped' | 'failed'> {
    const messageId = getMessageUniqueId(msg);
    const chatId = msg.fromMe ? (msg.to || msg.from) : msg.from;
    const rawText = getRawMessageText(msg);
    
    if (msg.fromMe) console.log(`[WhatsApp | ${userId}] 📥 Self-Message Intake via ${eventName}: ID=${messageId} chatId=${chatId}`);
    console.log(`[WhatsApp | ${userId}] 📨 Incoming msg via ${eventName} chatId=${chatId} fromMe=${msg.fromMe} hasMedia=${msg.hasMedia}`);
    if (!messageId || !chatId) return 'skipped';
    if (msg.fromMe && this.isIgnoredOutgoingMessage(userId, messageId)) {
      return 'skipped';
    }
    if (msg.fromMe && this.isIgnoredOutgoingText(userId, rawText)) {
      return 'skipped';
    }
    if (msg.fromMe && isKnownAutomatedReplyText(rawText)) {
      return 'skipped';
    }

    const seenKey = `${userId}:${messageId}`;
    if (this.isRecentlySeenMessage(seenKey)) {
      console.log(`[WhatsApp | ${userId}] Duplicate message ignored via recent dedupe: ID=${messageId} event=${eventName}`);
      return 'skipped';
    }

    const iFKey = `${userId}:${messageId}`;
    if (this.inFlightMessages.has(iFKey)) return 'skipped';
    this.inFlightMessages.add(iFKey);

    try {
      const chatConfig = await getActiveChatConfig(userId, chatId);
      if (!chatConfig) {
        console.log(`[WhatsApp | ${userId}] ⚠️ SKIPPED — chatId=${chatId} is not a configured source. from=${msg.from || ''} to=${msg.to || ''}`);
        return 'skipped';
      }

      const { data: existingIncoming } = await supabaseAdmin
        .from('incoming_messages')
        .select('id')
        .eq('user_id', userId)
        .eq('message_id', messageId)
        .maybeSingle();
      if (existingIncoming?.id) {
        this.rememberSeenMessage(seenKey);
        return 'skipped';
      }

      const senderDisplayName = await resolveSenderDisplayName(msg, client);
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

      this.rememberSeenMessage(seenKey);

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

  private isRecentlySeenMessage(key: string): boolean {
    const seenAt = this.recentlySeenMessages.get(key);
    if (!seenAt) return false;
    if (Date.now() - seenAt > WA_MESSAGE_DEDUPE_TTL_MS) {
      this.recentlySeenMessages.delete(key);
      return false;
    }
    return true;
  }

  private rememberSeenMessage(key: string) {
    this.recentlySeenMessages.set(key, Date.now());
    setTimeout(() => {
      const seenAt = this.recentlySeenMessages.get(key);
      if (seenAt && Date.now() - seenAt >= WA_MESSAGE_DEDUPE_TTL_MS) {
        this.recentlySeenMessages.delete(key);
      }
    }, WA_MESSAGE_DEDUPE_TTL_MS + 1000);
  }

  private async refreshChatCache(userId: string, client: WhatsAppClient): Promise<ChatSummary[]> {
    let lastMapped: ChatSummary[] = [];

    for (let attempt = 1; attempt <= WA_DISCOVERY_MAX_ATTEMPTS; attempt++) {
      let lightweightChats: ChatSummary[] = [];
      let lightweightContacts: ChatSummary[] = [];
      let hydratedChats: ChatSummary[] = [];
      let hydratedContacts: ChatSummary[] = [];

      const lightweightTimeoutMs = Math.min(
        WA_DISCOVERY_TIMEOUT_MS + ((attempt - 1) * 2000),
        WA_DISCOVERY_LIGHTWEIGHT_TIMEOUT_MS + ((attempt - 1) * 2000)
      );
      const contactTimeoutMs = Math.min(
        WA_DISCOVERY_TIMEOUT_MS + ((attempt - 1) * 2000),
        WA_DISCOVERY_CONTACT_TIMEOUT_MS + ((attempt - 1) * 2000)
      );
      const hydratedTimeoutMs = Math.min(
        WA_DISCOVERY_TIMEOUT_MS + ((attempt - 1) * 5000),
        WA_DISCOVERY_HYDRATED_TIMEOUT_MS + ((attempt - 1) * 5000)
      );

      const [chatResult, contactResult] = await Promise.allSettled([
        withTimeout(
          getLightweightChats(client),
          lightweightTimeoutMs,
          'Lightweight chat discovery timed out.'
        ),
        withTimeout(
          getLightweightContacts(client),
          contactTimeoutMs,
          'Contact discovery timed out.'
        ),
      ]);

      if (chatResult.status === 'fulfilled') {
        lightweightChats = chatResult.value;
        console.log(`[WhatsApp | ${userId}] Lightweight chat discovery returned ${lightweightChats.length} chats on attempt ${attempt}.`);
      } else {
        console.warn(`[WhatsApp | ${userId}] Lightweight chat discovery failed on attempt ${attempt}:`, (chatResult.reason as any)?.message || chatResult.reason);
      }

      if (contactResult.status === 'fulfilled') {
        lightweightContacts = contactResult.value;
        console.log(`[WhatsApp | ${userId}] Contact discovery returned ${lightweightContacts.length} contacts on attempt ${attempt}.`);
      } else {
        console.warn(`[WhatsApp | ${userId}] Contact discovery failed on attempt ${attempt}:`, (contactResult.reason as any)?.message || contactResult.reason);
      }

      let mapped = mergeChatSummaries(lightweightChats, lightweightContacts);
      if (mapped.length > 0) {
        this.cachedChats.set(userId, mapped);
        return mapped;
      }

      const [hydratedChatResult, hydratedContactResult] = await Promise.allSettled([
        withTimeout(
          getHydratedChats(client),
          hydratedTimeoutMs,
          'Hydrated WhatsApp chat discovery timed out.'
        ),
        withTimeout(
          getHydratedContacts(client),
          hydratedTimeoutMs,
          'Hydrated WhatsApp contact discovery timed out.'
        ),
      ]);

      if (hydratedChatResult.status === 'fulfilled') {
        hydratedChats = hydratedChatResult.value;
        console.log(`[WhatsApp | ${userId}] Hydrated chat discovery returned ${hydratedChats.length} chats on attempt ${attempt}.`);
      } else {
        console.warn(`[WhatsApp | ${userId}] Hydrated chat discovery failed on attempt ${attempt}:`, (hydratedChatResult.reason as any)?.message || hydratedChatResult.reason);
      }

      if (hydratedContactResult.status === 'fulfilled') {
        hydratedContacts = hydratedContactResult.value;
        console.log(`[WhatsApp | ${userId}] Hydrated contact discovery returned ${hydratedContacts.length} contacts on attempt ${attempt}.`);
      } else {
        console.warn(`[WhatsApp | ${userId}] Hydrated contact discovery failed on attempt ${attempt}:`, (hydratedContactResult.reason as any)?.message || hydratedContactResult.reason);
      }

      mapped = mergeChatSummaries(lightweightChats, hydratedChats, lightweightContacts, hydratedContacts);
      lastMapped = mapped;
      if (mapped.length > 0) {
        this.cachedChats.set(userId, mapped);
        return mapped;
      }

      if (attempt < WA_DISCOVERY_MAX_ATTEMPTS) {
        await sleep(WA_DISCOVERY_RETRY_DELAY_MS);
      }
    }

    return lastMapped;
  }

  async getAvailableChats(userId: string) {
    const cached = this.cachedChats.get(userId);
    if (cached && cached.length > 0) return cached;

    const client = this.getReadyClient(userId);
    const databaseBackedChats = await getDatabaseBackedChats(userId);
    if (databaseBackedChats.length > 0) {
      this.cachedChats.set(userId, databaseBackedChats);
      void this.refreshChatCache(userId, client)
        .then((freshChats) => {
          if (freshChats.length > 0) {
            this.cachedChats.set(userId, freshChats);
          }
        })
        .catch(() => {});
      console.log(`[WhatsApp | ${userId}] Returning ${databaseBackedChats.length} database-backed chats while live discovery refreshes in background.`);
      return databaseBackedChats;
    }

    const mapped = await this.refreshChatCache(userId, client);
    if (mapped.length > 0) {
      console.log(`[WhatsApp | ${userId}] Chat discovery returned ${mapped.length} chats.`);
      return mapped;
    }

    console.warn(`[WhatsApp | ${userId}] Chat discovery returned no chats after ${WA_DISCOVERY_MAX_ATTEMPTS} attempts.`);
    throw new Error('No WhatsApp chats or contacts were available yet. Open WhatsApp on your phone, wait a few seconds after Ready, then try Configure Sources again.');
  }

  async getRecentMessages(userId: string, chatId: string, limit: number = 40): Promise<ChatMessagePreview[]> {
    await this.assertActiveChat(userId, chatId);
    try {
      const client = await this.waitForReadyClient(userId);
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: Math.max(1, Math.min(limit, 100)) });
      const sorted = [...messages].sort((a: any, b: any) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
      return Promise.all(sorted.map((msg: any) => this.mapChatMessage(chatId, msg, client)));
    } catch (err: any) {
      if (String(err?.message || '').toLowerCase().includes('detached frame')) {
        await this.handleConnectionFailure(userId, 'Detached browser frame while loading recent messages.');
        throw new Error('WhatsApp session was refreshing. Please wait a few seconds and try again.');
      }
      throw err;
    }
  }

  async sendMessageToChat(userId: string, chatId: string, text: string): Promise<ChatMessagePreview> {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Message text is required.');
    await this.assertActiveChat(userId, chatId);
    try {
      const client = await this.waitForReadyClient(userId);
      const sent = await client.sendMessage(chatId, trimmed);
      return this.mapChatMessage(chatId, sent, client);
    } catch (err: any) {
      if (String(err?.message || '').toLowerCase().includes('detached frame')) {
        await this.handleConnectionFailure(userId, 'Detached browser frame while sending a message.');
        throw new Error('WhatsApp session was refreshing. Please wait for reconnection, then retry the message.');
      }
      throw err;
    }
  }

  async sendAutomatedReply(userId: string, chatId: string, text: string): Promise<void> {
    if (!WA_AUTO_REPLY_ENABLED) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    try {
      const client = await this.waitForReadyClient(userId);
      const sent = await client.sendMessage(chatId, trimmed);
      const sentId = getMessageUniqueId(sent);
      this.rememberIgnoredOutgoingText(userId, trimmed);
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

  private rememberIgnoredOutgoingText(userId: string, text: string) {
    const normalized = normalizeText(text);
    if (!normalized) return;
    const bucket = this.ignoredOutgoingTexts.get(userId) || new Set<string>();
    bucket.add(normalized);
    this.ignoredOutgoingTexts.set(userId, bucket);
    setTimeout(() => {
      const current = this.ignoredOutgoingTexts.get(userId);
      current?.delete(normalized);
    }, 10 * 60 * 1000);
  }

  private isIgnoredOutgoingText(userId: string, text: string): boolean {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    const bucket = this.ignoredOutgoingTexts.get(userId);
    if (!bucket?.has(normalized)) return false;
    bucket.delete(normalized);
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
    try {
      const client = await this.waitForReadyClient(userId);
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
        } catch {
          errors++;
        }
      }
      this.io.to(userId).emit('backfill_complete', { processed, skipped, errors });
      return { processed, skipped, errors };
    } catch (err: any) {
      if (String(err?.message || '').toLowerCase().includes('detached frame')) {
        await this.handleConnectionFailure(userId, 'Detached browser frame during backfill.');
        throw new Error('WhatsApp session refreshed during backfill. Wait for it to reconnect, then run backfill again.');
      }
      throw err;
    }
  }

  private startActiveChatSync(userId: string, client: WhatsAppClient) {
    return;
  }

  private async syncActiveChats(userId: string, forcedClient?: WhatsAppClient) {
    return;
  }
}
