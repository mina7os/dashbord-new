import dotenv from "dotenv";
dotenv.config();

import express, { Request, Response, NextFunction } from "express";
import { createServer as createViteServer } from "vite";
import http from "http";
import { Server as SocketServer } from "socket.io";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./src/lib/supabase-server.ts";
import { WhatsAppManager } from "./src/services/whatsapp/whatsapp.ts";
import { setupUserDatabase } from "./src/services/google-setup.ts";
import { validateInfrastructure } from "./src/services/validator.ts";
import {
  ensureAccessSchema,
  getAccessContext,
  inferRoleFromEmail,
  listUserRoles,
  logChangeAudit,
  requireReadAllData,
  requireRole,
  upsertUserRole,
} from "./src/services/access.ts";

/** ─── Config & State ──────────────────────────────────────────────────────── */
const anonClient = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  (process.env.VITE_SUPABASE_PUBLISHABLE_KEY && process.env.VITE_SUPABASE_PUBLISHABLE_KEY !== '...')
    ? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    : ((process.env.VITE_SUPABASE_ANON_KEY && process.env.VITE_SUPABASE_ANON_KEY !== '...')
      ? process.env.VITE_SUPABASE_ANON_KEY
      : (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || ''))
);

interface ServerDependencies {
  whatsapp: WhatsAppManager;
  degradedMode: boolean;
}

/** ─── Middleware ──────────────────────────────────────────────────────────── */
const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await anonClient.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  (req as any).user = user;
  (req as any).access = await getAccessContext(user);
  next();
};

function requireOwnership(req: Request & { user?: any }, res: Response, next: NextFunction) {
  const userId = req.body?.userId || req.query?.userId;
  if (userId && userId !== (req as any).user?.id && !(req as any).access?.canReadAllData) {
    return res.status(403).json({ error: 'Access denied: userId mismatch' });
  }
  next();
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function rateLimit(maxRequests: number, windowMs: number, scope = 'global') {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${scope}:${(req as any).user?.id || req.ip}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

async function fetchScopedUserIds(access: any): Promise<string[]> {
  if (access.canReadAllData) {
    const { data, error } = await supabaseAdmin.from('user_roles').select('user_id').eq('is_active', true);
    if (error || !data?.length) return [access.userId];
    return data.map((row: any) => row.user_id);
  }
  return [access.userId];
}

function applyUserScope(query: any, access: any, column = 'user_id') {
  if (access.canReadAllData) return query;
  return query.eq(column, access.userId);
}

/** ─── App Setup & Bootstrap ────────────────────────────────────────────────── */
async function startServer() {
  await ensureAccessSchema();
  console.log('[Startup] Validating infrastructure...');
  const { success, results } = await validateInfrastructure();
  
  const degradedMode = results.some(r => !r.passed && (r.checked === 'Supabase Connection' || r.checked.startsWith('Storage')));
  
  if (!success) {
    console.warn('\n[WARNING] Critical infrastructure checks failed. Starting in degraded mode.');
    results.filter(r => !r.passed).forEach(r => console.warn(` - ${r.checked}: ${r.error}`));
    console.warn('Some features (e.g., auto-restore) will be disabled until resolved.\n');
  } else {
    console.log('[Startup] Infrastructure healthy.');
    
    // Start background workers exactly once
    const { startSheetSyncPoller } = await import('./src/services/sheets.ts');
    startSheetSyncPoller();
  }

  const app = express();
  const server = http.createServer(app);

  const isProduction = process.env.NODE_ENV === 'production';
  const configuredAppUrl = (process.env.APP_URL || '').trim();
  const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
  const allowedOrigin = railwayUrl || ((!configuredAppUrl || configuredAppUrl === 'MY_APP_URL')
    ? 'http://localhost:3000'
    : configuredAppUrl);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (isProduction) {
      if (origin === allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const socketCorsOrigin = isProduction ? (allowedOrigin === '*' ? '*' : [allowedOrigin, 'https://whatsapp-dashboard-production-71b8.up.railway.app']) : '*';
  const io = new SocketServer(server, { cors: { origin: socketCorsOrigin, credentials: true } });
  const PORT = parseInt(process.env.PORT || '3000', 10);
  app.use(express.json({ limit: '50mb' }));

  // Dependencies injection container
  const whatsapp = new WhatsAppManager(io);
  const deps: ServerDependencies = { whatsapp, degradedMode };

  if (degradedMode) {
    console.warn('[Startup] Skipping WhatsApp auto-restore due to degraded mode.');
  } else {
    await whatsapp.restoreExistingSessions().catch(err => {
      console.error('[Startup] Auto-restore session failed:', err.message);
    });
  }

  io.on("connection", (socket) => {
    socket.on("join", async (userId: string, token: string) => {
      if (!token) { socket.disconnect(); return; }
      const { data: { user }, error } = await anonClient.auth.getUser(token);
      if (error || !user || user.id !== userId) { socket.disconnect(); return; }
      socket.join(userId);
      console.log(`[Socket] Verified user ${userId} joined room`);
    });
  });

  // Health endpoint (Public)
  app.get('/api/health', async (_req, res) => {
    const { success, results } = await validateInfrastructure();
    res.json({
      status: success ? 'healthy' : 'degraded',
      degradedMode: !success,
      whatsappRestoreEnabled: !degradedMode,
      infrastructure: results,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  app.get('/api/public-config', (_req, res) => {
    res.json({
      supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
      supabaseAnonKey:
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
        process.env.VITE_SUPABASE_ANON_KEY ||
        process.env.SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        '',
    });
  });

  const api = express.Router();
  api.use(requireAuth as any);
  api.use(requireOwnership as any);

  api.get('/me/context', async (req: any, res) => {
    const userIds = await fetchScopedUserIds(req.access);
    const { data: integrations } = await supabaseAdmin
      .from('user_integrations')
      .select('user_id, sheet_id')
      .in('user_id', userIds);

    const { data: roleRows } = await supabaseAdmin
      .from('user_roles')
      .select('user_id, email, role')
      .in('user_id', userIds);

    const accessibleSheets = (integrations || [])
      .filter((row: any) => row.sheet_id)
      .map((row: any) => {
        const roleRow = roleRows?.find((candidate: any) => candidate.user_id === row.user_id);
        const effectiveRole =
          row.user_id === req.user.id
            ? req.access.role
            : inferRoleFromEmail(String(roleRow?.email || ''));
        return {
          user_id: row.user_id,
          email: roleRow?.email || '',
          role: roleRow?.role || effectiveRole,
          sheet_id: row.sheet_id,
          url: `https://docs.google.com/spreadsheets/d/${row.sheet_id}`,
        };
      });

    res.json({
      access: req.access,
      accessibleSheets,
    });
  });

  api.get('/access/users', async (req: any, res) => {
    try {
      const rows = await listUserRoles(req.access);
      res.json({ users: rows });
    } catch (err: any) {
      res.status(403).json({ error: err.message || 'Access denied' });
    }
  });

  api.post('/access/users', async (req: any, res) => {
    try {
      await upsertUserRole(req.access, String(req.body.email || ''), req.body.role);
      res.json({ status: 'success' });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to assign role' });
    }
  });

  // Modular Route Registrations
  registerIntegrationRoutes(api, deps);
  registerWhatsAppRoutes(api, deps);
  registerPipelineRoutes(api, deps);
  registerDashboardRoutes(api, deps);
  registerReviewRoutes(api, deps);

  app.use('/api', api as any);

  // Vite Static Fallback
  if (!isProduction) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   State: ${degradedMode ? 'DEGRADED' : 'HEALTHY'}`);
    console.log(`   CORS allowed origin: ${allowedOrigin}\n`);
  });
}

/** ─── Route Handlers ───────────────────────────────────────────────────────── */

function registerIntegrationRoutes(api: express.Router, deps: ServerDependencies) {
  api.get('/integrations/status', async (req: any, res) => {
    try {
      const userIds = await fetchScopedUserIds(req.access);
      const { data: ownIntegration, error } = await supabaseAdmin
        .from('user_integrations')
        .select('google_tokens, sheet_id')
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (error) throw error;

      const { data: integrations } = await supabaseAdmin
        .from('user_integrations')
        .select('user_id, sheet_id')
        .in('user_id', userIds);
      const { data: roleRows } = await supabaseAdmin
        .from('user_roles')
        .select('user_id, email, role')
        .in('user_id', userIds);

      const accessibleSheets = (integrations || [])
        .filter((row: any) => row.sheet_id)
        .map((row: any) => {
          const roleRow = roleRows?.find((candidate: any) => candidate.user_id === row.user_id);
          const effectiveRole =
            row.user_id === req.user.id
              ? req.access.role
              : inferRoleFromEmail(String(roleRow?.email || ''));
          return {
            user_id: row.user_id,
            email: roleRow?.email || '',
            role: roleRow?.role || effectiveRole,
            sheetId: row.sheet_id,
            url: `https://docs.google.com/spreadsheets/d/${row.sheet_id}`,
          };
        });

      res.json({
        connected: !!ownIntegration?.google_tokens,
        sheetId: ownIntegration?.sheet_id,
        accessibleSheets,
        canUseIntegrations: req.access.canUseIntegrations,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch status' });
    }
  });

  api.post('/integrations/reset', async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    const userId = req.user.id;
    try {
      await supabaseAdmin.from('user_integrations').delete().eq('user_id', userId);
      await supabaseAdmin.from('incoming_messages').update({
        processing_status: 'pending',
        processing_stage: 'received',
        last_error: null,
        attempt_count: 0
      }).eq('user_id', userId);
      res.json({ status: 'success', message: 'Integration cleanly reset.' });
    } catch (err: any) {
      res.status(500).json({ error: 'Reset failed: ' + err.message });
    }
  });

  api.post('/integrations/google-tokens', async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    const userId = req.user.id;
    const { tokens } = req.body;
    if (!tokens) return res.status(400).json({ error: 'Tokens required' });

    try {
      const { error } = await supabaseAdmin.from('user_integrations').upsert({
        user_id: userId,
        google_tokens: tokens,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

      if (error) throw error;
      res.json({ status: 'success' });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to save tokens: ' + err.message });
    }
  });

  api.post('/integrations/setup-database', async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    const userId = req.user.id;
    try {
      const { data: existing } = await supabaseAdmin.from('user_integrations').select('google_tokens, sheet_id').eq('user_id', userId).maybeSingle();
      if (existing?.sheet_id && existing?.sheet_id !== '1mock_sheet_id') {
        return res.json({ status: 'success', message: 'Already setup' });
      }
      if (!existing?.google_tokens) {
        return res.status(400).json({ error: 'Google tokens not found. Please connect your account first.' });
      }
      const result = await setupUserDatabase(userId, existing.google_tokens);
      res.json({ status: "success", data: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to setup database" });
    }
  });
}

function registerWhatsAppRoutes(api: express.Router, deps: ServerDependencies) {
  api.get('/whatsapp/chats', rateLimit(20, 60000, 'whatsapp.chats') as any, async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    try {
      const chats = await deps.whatsapp.getAvailableChats(req.user.id);
      res.json({ chats });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Failed to fetch chats" });
    }
  });

  api.get('/whatsapp/status', rateLimit(60, 60000, 'whatsapp.status') as any, (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    deps.whatsapp.triggerActiveChatSync(req.user.id);
    res.json(deps.whatsapp.getStatus(req.user.id));
  });

  api.get('/whatsapp/messages', rateLimit(60, 60000, 'whatsapp.messages.get') as any, async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    try {
      const messages = await deps.whatsapp.getRecentMessages(req.user.id, String(req.query.chatId || ''), Number(req.query.limit || 40));
      res.json({ messages });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Failed to fetch WhatsApp messages" });
    }
  });

  api.post('/whatsapp/connect', rateLimit(5, 60000, 'whatsapp.connect') as any, async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    try {
      await deps.whatsapp.startInstance(req.user.id);
      res.json(deps.whatsapp.getStatus(req.user.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to start WhatsApp" });
    }
  });

  api.post('/whatsapp/disconnect', async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    try {
      await deps.whatsapp.stopInstance(req.user.id);
      res.json({ status: "disconnected" });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to disconnect" });
    }
  });

  api.post('/whatsapp/messages', rateLimit(30, 60000, 'whatsapp.messages.post') as any, async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    try {
      const message = await deps.whatsapp.sendMessageToChat(req.user.id, String(req.body.chatId || ''), String(req.body.text || ''));
      res.json({ message });
    } catch (err: any) {
      res.status(400).json({ error: err.message || "Failed to send WhatsApp message" });
    }
  });

  api.post('/whatsapp/backfill', rateLimit(10, 60000, 'whatsapp.backfill') as any, async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    if (!req.body.chatId) return res.status(400).json({ error: 'chatId is required' });
    try {
      const result = await deps.whatsapp.backfillChat(req.user.id, String(req.body.chatId), Number(req.body.lookbackMinutes || 120));
      res.json({ status: 'success', ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Backfill failed' });
    }
  });
}

function registerPipelineRoutes(api: express.Router, deps: ServerDependencies) {
  api.get('/pipeline/incoming', async (req: any, res) => {
    const { status, stage, chatId, limit = 50 } = req.query;
    try {
      if (!req.access.canReview && !req.access.canReadAllData) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      let query = supabaseAdmin.from('incoming_messages').select('*').order('created_at', { ascending: false }).limit(Number(limit));
      query = applyUserScope(query, req.access);
      if (status) query = query.eq('processing_status', status);
      if (stage) query = query.eq('processing_stage', stage);
      if (chatId) query = query.eq('chat_id', chatId);

      const { data, error } = await query;
      if (error) throw error;
      res.json({ queue: data || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch queue' });
    }
  });

  api.get('/pipeline/incoming/:id', async (req: any, res) => {
    try {
      if (!req.access.canReview && !req.access.canReadAllData) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      const { data: incoming, error: incError } = await supabaseAdmin.from('incoming_messages').select('*')
        .or(`id.eq.${req.params.id},message_id.eq.${req.params.id}`)
        .maybeSingle();

      if (incError) throw incError;
      if (!incoming) return res.status(404).json({ error: 'Message not found in processing queue' });
      if (!req.access.canReadAllData && incoming.user_id !== req.access.userId) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      const [{ data: transactions }, { data: reviews }] = await Promise.all([
        supabaseAdmin.from('transactions').select('*').eq('message_id', incoming.message_id).eq('user_id', incoming.user_id),
        supabaseAdmin.from('review_queue').select('*').eq('message_id', incoming.message_id).eq('user_id', incoming.user_id)
      ]);

      res.json({
        id: incoming.id,
        message_id: incoming.message_id,
        chat_id: incoming.chat_id,
        status: incoming.processing_status,
        stage: incoming.processing_stage,
        attempts: incoming.attempt_count,
        last_error: incoming.last_error,
        received_at: incoming.received_at,
        is_financial: incoming.is_financial,
        confidence: incoming.extraction_confidence,
        raw_text: incoming.raw_text,
        media_url: incoming.media_url,
        results: { transactions: transactions || [], reviews: reviews || [] }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Inspector failed' });
    }
  });

  api.get('/inspect/:id', async (req: any, res) => res.redirect(`/api/pipeline/incoming/${req.params.id}`));

  api.post('/ingest', async (req: any, res) => {
    try {
      requireRole(req.access, ['manager']);
    } catch (err: any) {
      return res.status(403).json({ error: err.message });
    }
    const { message_text, image_base64, attachment_type } = req.body;
    if (!message_text && !image_base64) return res.status(400).json({ error: 'message_text or image_base64 required' });

    try {
      const { insertIncomingMessage } = await import('./src/services/whatsapp/incomingMessages.ts');
      const { messageProcessor } = await import('./src/services/whatsapp/messageProcessor.ts');
      const messageId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let mediaUrl, actualMimeType, lastError;
      let stage = 'received', status: any = 'pending';

      if (image_base64) {
        const imageBuffer = Buffer.from(image_base64, 'base64');
        actualMimeType = attachment_type === 'pdf' ? 'application/pdf' : 'image/jpeg';
        const fileName = `${req.user.id}/${messageId}.${attachment_type === 'pdf' ? 'pdf' : 'jpg'}`;
        const { data, error } = await supabaseAdmin.storage.from('receipts').upload(fileName, imageBuffer, { contentType: actualMimeType });
        if (!error) {
          mediaUrl = data.path; stage = 'media_persisted';
        } else {
          stage = 'media_capture_failed'; status = 'media_capture_failed'; lastError = `Media capture failed: ${error.message}`;
        }
      }

      const incomingId = await insertIncomingMessage({
        userId: req.user.id, messageId, chatId: 'api-manual', senderId: 'api-user', rawText: message_text,
        hasMedia: !!image_base64, actualMimeType, mediaUrl, processingStage: stage, processingStatus: status,
        sourceType: 'api', lastError, metadata: { had_media: Boolean(image_base64), media_captured: Boolean(mediaUrl), mime_type: actualMimeType || null }
      });

      messageProcessor.trigger(req.user.id);

      res.json({ status: 'queued', id: incomingId, message_id: messageId, inspect_url: `/api/inspect/${incomingId}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Ingestion failed' });
    }
  });
}

function registerDashboardRoutes(api: express.Router, deps: ServerDependencies) {
  api.get('/dashboard/stats', rateLimit(120, 60000, 'dashboard.stats') as any, async (req: any, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const userIds = await fetchScopedUserIds(req.access);
      const [metricsRes, transactionsRes] = await Promise.all([
        req.access.canReadAllData
          ? supabaseAdmin.from('dashboard_metrics').select('*').in('user_id', userIds).eq('date', today)
          : supabaseAdmin.from('dashboard_metrics').select('*').eq('user_id', req.user.id).eq('date', today).maybeSingle(),
        req.access.canReadAllData
          ? supabaseAdmin.from('transactions').select('amount, currency').in('user_id', userIds)
          : supabaseAdmin.from('transactions').select('amount, currency').eq('user_id', req.user.id),
      ]);

      const blankStats = { total_messages: 0, financial_candidates: 0, successful_extractions: 0, pending_review: 0, duplicates: 0 };
      const stats = Array.isArray(metricsRes.data)
        ? metricsRes.data.reduce((acc: any, row: any) => ({
            total_messages: acc.total_messages + (Number(row.total_messages) || 0),
            financial_candidates: acc.financial_candidates + (Number(row.financial_candidates) || 0),
            successful_extractions: acc.successful_extractions + (Number(row.successful_extractions) || 0),
            pending_review: acc.pending_review + (Number(row.pending_review) || 0),
            duplicates: acc.duplicates + (Number(row.duplicates) || 0),
          }), blankStats)
        : (metricsRes.data || blankStats);
      const totals = { egp_total: 0, usd_total: 0 };
      transactionsRes.data?.forEach((tx: any) => {
        const amt = Number(tx.amount) || 0;
        if (tx.currency === 'EGP') totals.egp_total += amt;
        if (tx.currency === 'USD') totals.usd_total += amt;
      });

      res.json({ stats, totals });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  api.get('/dashboard/history', rateLimit(120, 60000, 'dashboard.history') as any, async (req: any, res) => {
    try {
      const userIds = await fetchScopedUserIds(req.access);
      const { data, error } = await (
        req.access.canReadAllData
          ? supabaseAdmin.from('dashboard_metrics').select('date, successful_extractions').in('user_id', userIds)
          : supabaseAdmin.from('dashboard_metrics').select('date, successful_extractions').eq('user_id', req.user.id)
      )
        .order('date', { ascending: true })
        .limit(30);

      if (error) throw error;

      const bucket = new Map<string, number>();
      (data || []).forEach((row: any) => {
        bucket.set(row.date, (bucket.get(row.date) || 0) + (Number(row.successful_extractions) || 0));
      });

      res.json({
        metrics: Array.from(bucket.entries()).map(([date, successful_extractions]) => ({
          date,
          successful_extractions,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch history' });
    }
  });

  api.get('/transactions', rateLimit(120, 60000, 'dashboard.transactions') as any, async (req: any, res) => {
    try {
      const userIds = await fetchScopedUserIds(req.access);
      const query = req.access.canReadAllData
        ? supabaseAdmin.from('transactions').select('*').in('user_id', userIds)
        : supabaseAdmin.from('transactions').select('*').eq('user_id', req.user.id);
      const { data, error } = await query.order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      res.json({ transactions: data || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch transactions' });
    }
  });

  api.get('/review-queue', rateLimit(120, 60000, 'dashboard.review-queue') as any, async (req: any, res) => {
    try {
      if (!req.access.canReview && !req.access.canReadAllData) {
        return res.json({ reviewQueue: [] });
      }
      const userIds = await fetchScopedUserIds(req.access);
      const query = req.access.canReadAllData
        ? supabaseAdmin.from('review_queue').select('*').in('user_id', userIds)
        : supabaseAdmin.from('review_queue').select('*').eq('user_id', req.user.id);
      const { data, error } = await query.eq('review_status', 'pending').order('created_at', { ascending: false });
      if (error) throw error;
      res.json({ reviewQueue: data || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch review queue' });
    }
  });
}

function registerReviewRoutes(api: express.Router, deps: ServerDependencies) {
  api.patch('/review/:id', async (req: any, res) => {
    const { action, corrected_data, comment } = req.body;
    if (!['approve', 'reject', 'edit'].includes(action)) return res.status(400).json({ error: "Invalid action." });

    try {
      requireRole(req.access, ['manager', 'cfo', 'admin']);
      if (req.access.mustProvideChangeReason && !String(comment || '').trim()) {
        return res.status(400).json({ error: 'Comment is required for admin changes.' });
      }

      const { data: item } = await supabaseAdmin.from('review_queue').select('*').eq('id', req.params.id).single();
      if (!item) return res.status(404).json({ error: 'Review item not found' });
      if (!req.access.canEditAllData && item.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied.' });
      }

      const { saveTransactionToOutputs, upsertDailyMetrics, incrementMetric } = await import('./src/services/transactionService.ts');
      const { advanceStage } = await import('./src/services/whatsapp/incomingMessages.ts');
      const targetUserId = item.user_id;
      const { data: incomingRow } = await supabaseAdmin.from('incoming_messages').select('id').eq('user_id', targetUserId).eq('message_id', item.message_id).maybeSingle();

      if (action === 'reject') {
        await Promise.all([
          supabaseAdmin.from('review_queue').update({ review_status: 'rejected' }).eq('id', req.params.id),
          incomingRow?.id ? advanceStage(incomingRow.id, 'rejected_via_review', 'completed_non_transaction') : Promise.resolve(),
          incrementMetric(targetUserId, 'review_rejected_count')
        ]);
        await logChangeAudit({
          actor: req.access,
          action: 'review.reject',
          entityType: 'review_queue',
          entityId: req.params.id,
          targetUserId,
          reason: comment,
          metadata: { reviewAction: action, messageId: item.message_id },
        });
        return res.json({ status: 'rejected' });
      }

      const txData = action === 'edit' ? { ...item.suggested_data, ...corrected_data } : item.suggested_data;
      txData.user_id = targetUserId;
      txData.processing_status = 'completed';

      const { data: integration } = await supabaseAdmin.from('user_integrations').select('*').eq('user_id', targetUserId).single();
      await saveTransactionToOutputs(txData, { userId: targetUserId, sheetId: integration?.sheet_id, tokens: integration?.google_tokens } as any);
      await upsertDailyMetrics(targetUserId, new Date().toISOString().split('T')[0], txData);

      await Promise.all([
        supabaseAdmin.from('review_queue').update({ review_status: 'approved' }).eq('id', req.params.id),
        incomingRow?.id ? advanceStage(incomingRow.id, 'completed_via_review', 'completed_transaction', { isFinancial: true }) : Promise.resolve(),
        incrementMetric(targetUserId, 'successful_extractions')
      ]);
      await logChangeAudit({
        actor: req.access,
        action: action === 'edit' ? 'review.edit' : 'review.approve',
        entityType: 'review_queue',
        entityId: req.params.id,
        targetUserId,
        reason: comment,
        metadata: {
          reviewAction: action,
          correctedData: corrected_data || null,
          messageId: item.message_id,
        },
      });
      return res.json({ status: 'approved' });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to process review action' });
    }
  });
}

startServer().catch(console.error);
