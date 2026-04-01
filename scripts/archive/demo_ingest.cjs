
const payload = {
  sender_phone: "20123456789",
  message_text: "Received 1,200 EGP from Ahmed Ali on CIB Bank. Reference: REF998877.",
  attachments: []
};

async function runDemo() {
  console.log("🚀 Sending test transaction to API...");
  try {
    const response = await fetch('http://localhost:3000/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    console.log("✅ Success! Server Response:");
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("❌ Failed to send transaction:");
    console.error(error.message);
  }
}

runDemo();
