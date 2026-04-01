import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';

console.log('1. Constructing client...');
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'test-session' }),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
    ],
  },
});

console.log('2. Binding events...');
client.on('qr', (qr) => {
  console.log('3. QR received!');
  qrcode.generate(qr, { small: true });
  process.exit(0);
});

client.on('ready', () => {
  console.log('3. Client ready!');
  process.exit(0);
});

client.on('loading_screen', (percent, msg) => {
  console.log('Loading screen:', percent, msg);
});

console.log('4. Calling initialize()...');
client.initialize().catch((err) => {
  console.error('Initialize failed:', err);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timeout after 30 seconds wait.');
  process.exit(1);
}, 30000);
