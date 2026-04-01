import { google } from 'googleapis';
import { getAuthenticatedClient, GoogleTokens } from '../lib/google-auth';
import { supabaseAdmin } from '../lib/supabase-server';

const SHEET_HEADERS = ['Date', 'Time', 'Type', 'Bank', 'Location', 'Sender', 'Sender Code', 'Beneficiary', 'Beneficiary Account', 'Amount', 'Currency', 'Status', 'Reference'];

/**
 * Automatically creates the 'Dashboard Data' folder and spreadsheet for a user.
 * Uses shared auth helper for automatic token refresh.
 */
export async function setupUserDatabase(userId: string, tokens: GoogleTokens) {
  const oauth2Client = await getAuthenticatedClient(userId, tokens);

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

  // 0. Check existing status from Supabase
  const { data: existing } = await supabaseAdmin
    .from('user_integrations')
    .select('folder_id, sheet_id')
    .eq('user_id', userId)
    .single();

  let folderId = existing?.folder_id;
  let sheetId = existing?.sheet_id;

  try {
    // 1. Create Folder if missing
    if (!folderId) {
      console.log('[Setup] Creating "Dashboard Data" folder...');
      const folder = await drive.files.create({
        requestBody: {
          name: 'Dashboard Data',
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id',
      });
      folderId = folder.data.id!;
    }

    // 2. Create Spreadsheet if missing or if it's a mock
    if (!sheetId || sheetId === '1mock_sheet_id') {
      console.log('[Setup] Creating "Automated Transactions" sheet...');
      const spreadsheet = await drive.files.create({
        requestBody: {
          name: 'Automated Transactions',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: [folderId],
        },
        fields: 'id',
      });
      sheetId = spreadsheet.data.id!;

      // 3. Initialize Headers in the new sheet (use the actual new sheetId)
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:M1',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [SHEET_HEADERS],
        },
      });
      console.log('[Setup] Headers initialized in sheet:', sheetId);
    }
  } catch (err: any) {
    console.error('[Setup] Google API call failed. Possibly missing Drive/Sheets scopes:', err);
    throw new Error(`Google API permissions error: please make sure to check the boxes for Drive and Spreadsheets access during Google Sign-In! (${err.message})`);
  }

  // 4. Store in Supabase
  await supabaseAdmin
    .from('user_integrations')
    .update({ folder_id: folderId, sheet_id: sheetId, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  return { folderId, sheetId };
}
