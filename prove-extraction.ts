
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { extractMessage } from './src/services/extraction.ts';
import dotenv from 'dotenv';
dotenv.config();

async function prove() {
  console.log('--- PHASE 1: Proving AI Extraction (Gemini) ---');
  const mockContext = { userId: 'proof-user', sheetId: undefined, tokens: undefined, activeChats: new Set() };
  const mockText = "Received 1,200 EGP from Ahmed Ali on CIB Bank. Reference: REF998877.";
  
  try {
    const aiResult = await extractMessage(mockText, mockContext as any, undefined, 'text');
    console.log('✅ AI extraction successful!');
    console.log('Result:', JSON.stringify(aiResult.transactions[0], null, 2));
  } catch (e: any) {
    console.error('❌ AI Extraction failed:', e.message);
  }

  console.log('\n--- PHASE 2: Proving WhatsApp Connection ---');
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'user-bdc564f5-5952-42aa-b14c-4321e284af3c' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      protocolTimeout: 60000,
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/wppconnect-wa.js'
    }
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp Ready!');
    const chats = await client.getChats();
    const uva = chats.find((c: any) => c.name === 'Uva' || c.id._serialized === '31687986439@c.us');
    
    if (uva) {
      console.log(`✅ Found chat: ${uva.name}`);
      const messages = await uva.fetchMessages({ limit: 5 });
      console.log(`✅ Retrieved ${messages.length} recent messages.`);
      messages.forEach((m: any, i: number) => {
        console.log(`   [${i+1}] ${m.body || '[Media]'}`);
      });
    } else {
      console.log('❌ Could not find Uva chat.');
    }
    
    await client.destroy();
    process.exit(0);
  });

  client.on('auth_failure', () => { console.error('❌ Auth Failure'); process.exit(1); });
  client.on('qr', () => { console.error('❌ Session Lost'); process.exit(1); });

  console.log('Initializing WhatsApp (please wait)...');
  await client.initialize().catch(e => {
    console.error('❌ Initialize Error:', e.message);
    process.exit(1);
  });
}

prove();
