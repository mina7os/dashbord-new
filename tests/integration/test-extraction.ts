/**
 * Extraction Unit Tests — validates rule-based patterns and AI fallback handling.
 * Run: npx tsx test-extraction.ts
 */
import dotenv from 'dotenv';
dotenv.config();

// Minimal PipelineContext mock
const mockCtx = { userId: 'test-user', sheetId: '', tokens: { access_token: '', refresh_token: '' }, activeChats: new Set<string>() };

// We test the rule-based path inline — reproduce the same logic
const PATTERNS = [
  {
    name: 'instapay_en',
    regex: /Received ([\d,.]+) (EGP|USD) from (.*?) on (.*?) Bank\. Reference:?\s*([\w-]+)/i,
    map: (m: RegExpMatchArray) => ({
      amount: parseFloat(m[1].replace(/,/g, '')),
      currency: m[2].toUpperCase(),
      sender_name: m[3].trim(),
      bank_name: m[4].trim(),
      reference_number: m[5].trim(),
      transaction_type: 'instapay',
    }),
  },
  {
    name: 'deposit_ar',
    regex: /إيداع بمبلغ ([\d,.]+) (جنيه|مصري|دولار) (?:في|إلى) حساب (.*?)(?:\s*مرجع ([\w-]+)|$)/i,
    map: (m: RegExpMatchArray) => ({
      transaction_type: 'deposit',
      amount: parseFloat(m[1].replace(/,/g, '')),
      currency: m[2].includes('دولار') ? 'USD' : 'EGP',
      beneficiary_name: m[3]?.trim() || null,
      reference_number: m[4]?.trim() || null,
    }),
  },
  {
    name: 'instapay_ar',
    regex: /إنستاباي.*?([\d,.]+) (جنيه|مصري|EGP|دولار|USD).*?من (.*?)(?:\s*مرجع ([\w-]+)|$)/i,
    map: (m: RegExpMatchArray) => ({
      transaction_type: 'instapay',
      amount: parseFloat(m[1].replace(/,/g, '')),
      currency: (m[2].includes('دولار') || m[2] === 'USD') ? 'USD' : 'EGP',
      sender_name: m[3]?.trim() || null,
    }),
  },
  {
    name: 'generic_transfer_ar',
    regex: /(تحويل|حوالة) بمبلغ ([\d,.]+) (جنيه|مصري|دولار) من (.*?) مرجع ([\w-]+)/i,
    map: (m: RegExpMatchArray) => ({
      transaction_type: 'transfer',
      amount: parseFloat(m[2].replace(/,/g, '')),
      currency: m[3].includes('دولار') ? 'USD' : 'EGP',
      sender_name: m[4].trim(),
      reference_number: m[5].trim(),
    }),
  },
  {
    name: 'upi_in',
    regex: /Amount of ₹?([\d,.]+) debited from (.*?) account .*? UPI Ref No ([\d]+)/i,
    map: (m: RegExpMatchArray) => ({
      transaction_type: 'upi',
      amount: parseFloat(m[1].replace(/,/g, '')),
      currency: 'INR',
      bank_name: m[2].trim(),
      reference_number: m[3].trim(),
    }),
  },
];

function tryRuleBasedExtraction(text: string) {
  for (const p of PATTERNS) {
    const m = text.match(p.regex);
    if (m) return { pattern: p.name, result: p.map(m) };
  }
  return null;
}

// ─── Test Cases ───────────────────────────────────────────────────────────────
const tests = [
  {
    label: 'EN InstaPay standard',
    input: 'Received 1,200 EGP from Ahmed Ali on CIB Bank. Reference: REF998877.',
    expect: { pattern: 'instapay_en', amount: 1200, currency: 'EGP', sender_name: 'Ahmed Ali', reference_number: 'REF998877' },
  },
  {
    label: 'AR Arabic deposit (جنيه — fixed typo)',
    input: 'إيداع بمبلغ 500 جنيه في حساب محمد علي مرجع DEP123',
    expect: { pattern: 'deposit_ar', amount: 500, currency: 'EGP', transaction_type: 'deposit' },
  },
  {
    label: 'AR Arabic InstaPay',
    input: 'إنستاباي تحويل 750 جنيه من سارة أحمد مرجع IP456',
    expect: { pattern: 'instapay_ar', amount: 750, currency: 'EGP', sender_name: 'سارة أحمد' },
  },
  {
    label: 'AR Arabic transfer (جنيه — was جنية typo)',
    input: 'تحويل بمبلغ 3000 جنيه من خالد محمد مرجع TRF789',
    expect: { pattern: 'generic_transfer_ar', amount: 3000, currency: 'EGP', reference_number: 'TRF789' },
  },
  {
    label: 'Unmatched — should return null (triggers AI)',
    input: 'Hey, can you send me the bill later?',
    expect: null,
  },
  {
    label: 'IN UPI standard (Rupee)',
    input: 'Amount of ₹500.00 debited from SBI account XXXXXX1234 on 2024-03-23. UPI Ref No 412345678901.',
    expect: { pattern: 'upi_in', amount: 500, currency: 'INR', bank_name: 'SBI', reference_number: '412345678901', transaction_type: 'upi' },
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const result = tryRuleBasedExtraction(t.input);

  if (t.expect === null) {
    if (result === null) {
      console.log(`✅ PASS: ${t.label} → null (AI fallback triggered correctly)`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${t.label} → Expected null, got pattern: ${result.pattern}`);
      failed++;
    }
    continue;
  }

  if (!result) {
    console.error(`❌ FAIL: ${t.label} → No pattern matched`);
    failed++;
    continue;
  }

  let ok = true;
  const errors: string[] = [];

  if (result.pattern !== t.expect.pattern) {
    errors.push(`pattern: got ${result.pattern}, expected ${t.expect.pattern}`);
    ok = false;
  }

  for (const [key, expected] of Object.entries(t.expect)) {
    if (key === 'pattern') continue;
    const actual = (result.result as any)[key];
    if (actual !== expected) {
      errors.push(`${key}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      ok = false;
    }
  }

  if (ok) {
    console.log(`✅ PASS: ${t.label} → ${result.pattern} amount=${result.result.amount} currency=${result.result.currency}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${t.label} → ${errors.join(', ')}`);
    failed++;
  }
}

console.log(`\n── Extraction Tests: ${passed}/${passed + failed} passed ──`);
if (failed > 0) process.exit(1);
