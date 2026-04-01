import { google } from 'googleapis';
import { getAuthenticatedClient } from '../lib/google-auth';
import { supabaseAdmin } from '../lib/supabase-server.ts';

const SYNC_INTERVAL_MS = 10000;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let isSyncing = false;
const SHEET_HEADERS = ['Date', 'Time', 'Type', 'Bank', 'Location', 'Sender', 'Sender Code', 'Beneficiary', 'Beneficiary Account', 'Amount', 'Currency', 'Status', 'Reference'];

async function ensureSheetHeaders(sheetsApi: any, spreadsheetId: string) {
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: 'Sheet1!A1:M1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [SHEET_HEADERS] },
  });
}

export async function processSheetSyncQueue() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    // 1. Fetch pending rows (limit 20 per cycle)
    const { data: pendingRows, error } = await supabaseAdmin
      .from('sheet_sync_queue')
      .select('*')
      .in('status', ['pending', 'failed_retriable'])
      .lt('attempt_count', 5)
      .order('created_at', { ascending: true })
      .limit(20);

    if (error) throw error;
    if (!pendingRows || pendingRows.length === 0) {
      isSyncing = false;
      return;
    }

    // 2. Group by sheet interaction needs (UserId -> SheetId)
    const groups = new Map<string, { userId: string, sheetId: string, rows: any[] }>();

    for (const row of pendingRows) {
      const key = `${row.user_id}::${row.sheet_id}`;
      if (!groups.has(key)) {
        groups.set(key, { userId: row.user_id, sheetId: row.sheet_id, rows: [] });
      }
      groups.get(key)!.rows.push(row);
    }

    // 3. Process batches
    for (const [key, group] of groups) {
      const { data: authData } = await supabaseAdmin
        .from('user_integrations')
        .select('google_tokens')
        .eq('user_id', group.userId)
        .maybeSingle();
      
      const tokens = authData?.google_tokens;
      if (!tokens) {
        await markFailed(group.rows, 'Missing Google integration tokens.');
        continue;
      }

      try {
        const oauth2Client = await getAuthenticatedClient(group.userId, tokens);
        const sheetsApi = google.sheets({ version: 'v4', auth: oauth2Client });

        await ensureSheetHeaders(sheetsApi, group.sheetId);
        await sheetsApi.spreadsheets.values.append({
          spreadsheetId: group.sheetId,
          range: 'Sheet1!A:M',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: group.rows.map(r => r.row_data) },
        });

        // Mark as completed
        for (const r of group.rows) {
          await supabaseAdmin.from('sheet_sync_queue').delete().eq('id', r.id);
        }
        
        console.log(`[Sheets] Synced ${group.rows.length} rows to sheet ${group.sheetId} for user ${group.userId}`);
      } catch (insertErr: any) {
        console.error(`[Sheets] Failed syncing batch for user ${group.userId}:`, insertErr.message);
        await markFailed(group.rows, insertErr.message);
      }
    }
  } catch (err: any) {
    console.error(`[SheetsWorker] Tick error:`, err.message);
  } finally {
    isSyncing = false;
  }
}

async function markFailed(rows: any[], errorMessage: string) {
  for (const row of rows) {
    const nextCount = row.attempt_count + 1;
    const nextStatus = nextCount >= 5 ? 'failed_permanent' : 'failed_retriable';
    await supabaseAdmin
      .from('sheet_sync_queue')
      .update({
        status: nextStatus,
        attempt_count: nextCount,
        last_error: errorMessage,
        updated_at: new Date().toISOString()
      })
      .eq('id', row.id);
  }
}

export function startSheetSyncPoller() {
  if (syncTimer) return;
  console.log('[SheetsWorker] Starting background sync poller...');
  
  const tick = async () => {
    await processSheetSyncQueue();
    syncTimer = setTimeout(tick, SYNC_INTERVAL_MS);
  };
  
  syncTimer = setTimeout(tick, 5000); // Startup delay
}

export function stopSheetSyncPoller() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
    console.log('[SheetsWorker] Stopped background sync poller.');
  }
}
