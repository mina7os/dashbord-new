async function run() {
  const userId = 'test-id';
  
  console.log('1. Testing /api/integrations/setup-database');
  try {
    const resSetup = await fetch('http://localhost:3000/api/integrations/setup-database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake' },
      body: JSON.stringify({ userId, google_tokens: {} })
    });
    console.log('Setup response status:', resSetup.status);
    console.log('Setup response body:', await resSetup.text());
  } catch (e) {
    console.error('Setup failed:', e);
  }

  console.log('\n2. Testing /api/whatsapp/connect');
  try {
    const resConnect = await fetch('http://localhost:3000/api/whatsapp/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake' },
      body: JSON.stringify({ userId })
    });
    console.log('Connect response status:', resConnect.status);
    console.log('Connect response body:', await resConnect.text());

    // Wait 10 seconds to let WhatsApp event logs show up in the server output
    console.log('Waiting 10s for events...');
    await new Promise(r => setTimeout(r, 10000));
    
  } catch (e) {
    console.error('Connect failed:', e);
  }
}
run();
