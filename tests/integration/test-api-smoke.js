import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const bearerToken = process.env.TEST_BEARER_TOKEN || '';
const testUserId = process.env.TEST_USER_ID || '';

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { response, text, json };
}

async function run() {
  console.log(`[Smoke] Checking health at ${baseUrl}/api/health`);
  const health = await request('/api/health');

  assert.equal(health.response.status, 200, `Expected /api/health to return 200, got ${health.response.status}`);
  assert.ok(health.json && health.json.status, 'Expected /api/health JSON to include a status field');
  console.log(`[Smoke] Health OK: ${health.json.status}`);

  if (!bearerToken || !testUserId) {
    console.log('[Smoke] Skipping authenticated ingest check. Set TEST_BEARER_TOKEN and TEST_USER_ID to enable it.');
    return;
  }

  console.log('[Smoke] Running authenticated ingest check');
  const ingest = await request('/api/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      userId: testUserId,
      message_text: `Smoke test payment INR 500 ref ${Date.now()}`,
    }),
  });

  assert.equal(ingest.response.status, 200, `Expected /api/ingest to return 200, got ${ingest.response.status}: ${ingest.text}`);
  assert.equal(ingest.json && ingest.json.status, 'queued', `Expected ingest status=queued, got ${JSON.stringify(ingest.json)}`);
  assert.ok(ingest.json && ingest.json.id, 'Expected ingest response to include an id');
  console.log(`[Smoke] Ingest queued: ${ingest.json.id}`);
}

run().catch((error) => {
  console.error('[Smoke] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
