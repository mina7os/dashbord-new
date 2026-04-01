
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { supabaseAdmin } from '../../src/lib/supabase-server.ts';
import { extractMessage } from '../../src/services/extraction.ts';
import { saveTransactionToOutputs, upsertDailyMetrics } from '../../src/services/transactionService.ts';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const USER_ID = 'bdc564f5-5952-42aa-b14c-4321e284af3c';
const CHAT_ID = '31687986439@c.us'; // Uva
const LOOKBACK_MINUTES = 1440; // 24 hours

async function runTrial() {
  console.log('🚀 Starting Manual 24h Extraction Trial...');
  console.log(`User: ${USER_ID}`);
  console.log(`Chat: ${CHAT_ID}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `user-${USER_ID}` }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      protocolTimeout: 180000,
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/wppconnect-wa.js'
    }
  });

  client.on('qr', () => console.log('❌ Error: Session lost. Please reconnect in dashboard.'));
  client.on('authenticated', () => console.log('✅ Authenticated!'));
  client.on('ready', async () => {
    console.log('✅ WhatsApp Ready!');
    
    try {
      const chat = await client.getChatById(CHAT_ID);
      console.log(`📡 Fetching messages from ${chat.name}...`);
      
      const messages = await chat.fetchMessages({ limit: 500 });
      const cutoffTs = (Date.now() / 1000) - (LOOKBACK_MINUTES * 60);
      const recentMsgs = messages.filter((m: any) => Number(m.timestamp) >= cutoffTs && !m.fromMe);

      console.log(`📊 Found ${recentMsgs.length} messages in the last 24 hours.`);

      for (const msg of recentMsgs) {
        console.log(`\n--- Processing Message ${msg.id.id} ---`);
        console.log(`Time: ${new Date(msg.timestamp * 1000).toLocaleString()}`);
        console.log(`Text: ${msg.body || '[Media]'}`);

        let imageBuffer: Buffer | undefined;
        if (msg.hasMedia) {
          console.log('🖼️  Downloading media...');
          const media = await msg.downloadMedia();
          if (media) {
            imageBuffer = Buffer.from(media.data, 'base64');
            console.log(`✅ Media downloaded (${media.mimetype})`);

            // Upload to storage for permanent record
            const fileName = `trial/${USER_ID}/${msg.id.id}-${Date.now()}.jpg`;
            await supabaseAdmin.storage.from('receipts').upload(fileName, imageBuffer, { contentType: media.mimetype });
          }
        }

        // Context for extraction
        const { data: integration } = await supabaseAdmin.from('user_integrations').select('*').eq('user_id', USER_ID).single();
        const context = {
          userId: USER_ID,
          sheetId: integration?.sheet_id,
          tokens: integration?.google_tokens
        };

        console.log('🤖 Running AI Extraction...');
        const result = await extractMessage(
          msg.body || '',
          context as any,
          imageBuffer,
          msg.hasMedia ? 'image' : 'text',
          msg.hasMedia ? 'image/jpeg' : undefined
        );

        console.log(`🤖 AI Result: ${result.status} (Confidence: ${result.confidence})`);
        
        if (result.status === 'SUCCESS' || result.status === 'LOW_CONFIDENCE') {
          console.log(`✅ Found ${result.transactions.length} transactions.`);
          for (const tx of result.transactions) {
            tx.user_id = USER_ID;
            tx.message_id = msg.id.id;
            tx.raw_text = msg.body || result.ocr_text;

            if (result.status === 'SUCCESS' && result.confidence >= 0.7) {
              console.log(`💾 Saving Transaction: ${tx.amount} ${tx.currency}`);
              await saveTransactionToOutputs(tx, context as any).catch(e => console.error('Save Error:', e.message));
              await upsertDailyMetrics(USER_ID, new Date().toISOString().split('T')[0], tx).catch(e => console.error('Metric Error:', e.message));
            } else {
              console.log(`📝 Review Required: ${result.review_reason}`);
              await supabaseAdmin.from('review_queue').insert([{
                user_id: USER_ID,
                message_id: msg.id.id,
                raw_text: tx.raw_text,
                suggested_data: tx,
                reason: result.review_reason || 'Low confidence trial',
                confidence: result.confidence,
                review_status: 'pending'
              }]);
            }
          }
        } else {
          console.log(`ℹ️  No financial data found: ${result.status}`);
        }
        
        // Respect rate limits
        await new Promise(r => setTimeout(r, 6000));
      }

      console.log('\n🏁 Trial Complete!');
      await client.destroy();
      process.exit(0);
    } catch (err: any) {
      console.error('❌ Trial Error:', err.message);
      process.exit(1);
    }
  });

  await client.initialize();
}

runTrial().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
