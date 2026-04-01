import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import sharp from "sharp";
import { PipelineContext } from "../types/pipeline";
import { MediaSourceType, deriveMediaSourceTypeFromMime, normalizeMediaSourceType } from "../types/media.ts";

dotenv.config();

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface ExtractedTransaction {
  user_id?: string;
  message_id?: string;
  transaction_date?: string | null;
  transaction_time?: string | null;
  transaction_type?: string | null;
  bank_name?: string | null;
  sender_name?: string | null;
  sender_code?: string | null;
  beneficiary_name?: string | null;
  beneficiary_account?: string | null;
  amount?: number | null;
  amount_in_words_text?: string | null;
  currency?: string | null;
  reference_number?: string | null;
  transaction_location?: string | null;
  confidence?: number;
  review_required?: boolean;
  review_reason?: string;
  duplicate?: boolean;
  processing_status?: string;
  raw_text?: string;
}

export interface ExtractionResult {
  status: 'SUCCESS' | 'NO_FINANCIAL' | 'LOW_CONFIDENCE' | 'ERROR';
  is_quota_exceeded?: boolean;
  error_type?: 'quota_failure' | 'malformed_ai_response' | 'extraction_failure';
  source_type: MediaSourceType;
  confidence: number;
  ocr_text?: string;
  review_reason?: string;
  transactions: ExtractedTransaction[];
  is_financial: boolean;
}

type RuleMatchResult = {
  confidence: number;
  transaction: ExtractedTransaction;
};

const EXTRACTION_PROMPT = `
You are a precision financial extraction engine. Categorize the input and extract transaction data.

MODALITY IDENTIFICATION:
- Choose exactly one canonical modality: "text", "image", "pdf", "handwriting", or "unknown".

FINANCIAL CLASSIFICATION:
- Is this content a financial transaction (receipt, transfer, deposit, bill payment)?

REGIONAL FOCUS (INDIA):
- Support for Indian formats: INR, ₹.
- Recognize UPI transaction IDs (12 digits, e.g., 412345678901).
- Recognize Indian banks: SBI, HDFC, ICICI, Axis, PNB, Kotak, etc.
- Standard labels: "UPI Ref No", "UTR", "Transaction ID".

EXTRACTION RULES:
- Extract sender_name, sender_code, beneficiary_name, beneficiary_account, amount, currency, bank_name, reference_number, date (YYYY-MM-DD), time (HH:MM AM/PM).
- Also extract "amount_in_words_text" when the document contains the amount written in words.
- Also extract "transaction_location" from branch/city/governorate/location fields such as Aswan / Aswan.
- Handle WhatsApp/SMS bank alerts for EGP, USD, and INR, including UPI, IMPS, NEFT, and RTGS references.
- Standardize transaction_type: "transfer", "deposit", "instapay", "payment", "upi".
- SENDER_CODE: Extract digits like (***1234) into "sender_code".
- SENDER_NAME: Strip trailing digits.
- CONFIDENCE: 1.0 for perfect clarity, 0.7 for handwriting/blurry.
- If both numeric amount and amount written in words are present, compare them carefully and prefer the value written in words when it is clearly more reliable.

RETURN FORMAT (JSON ONLY):
{
  "modality": "text" | "image" | "pdf" | "handwriting" | "unknown",
  "is_financial": boolean,
  "confidence": number,
  "transactions": [ { ...tx_data } ]
}

CRITICAL: If the input looks like a bank alert, SMS transfer, or payment receipt (even if partial), set "is_financial": true.
`;

function parseAmount(raw?: string): number | null {
  if (!raw) return null;
  const normalized = raw.replace(/,/g, '').trim();
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function detectCurrency(raw?: string | null): string | null {
  if (!raw) return null;
  const value = raw.toUpperCase();
  if (value.includes('USD') || value.includes('DOLLAR')) return 'USD';
  if (value.includes('INR') || value.includes('RS') || value.includes('RUPEE')) return 'INR';
  if (value.includes('EGP')) return 'EGP';
  if (/[جج]نيه|مصري/u.test(raw)) return 'EGP';
  return null;
}

function extractReferenceNumber(text: string): string | null {
  const match = text.match(/(?:UPI\s*REF(?:\s*NO)?|UTR|REF(?:ERENCE)?(?:\s*NO)?|RRN)[\s:.-]*([A-Z0-9-]+)/i);
  return match?.[1]?.trim() || null;
}

function trimCapturedName(value?: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/\s+(?:a\/c|acct|account|upi|ref|utr)\b.*$/i, '')
    .replace(/[.,;:]+$/, '')
    .trim() || null;
}

function tryRuleBasedExtraction(messageText: string): RuleMatchResult | null {
  const text = messageText.trim();
  if (!text) return null;

  const patterns: Array<{
    regex: RegExp;
    map: (match: RegExpMatchArray) => ExtractedTransaction | null;
    confidence?: number;
  }> = [
    {
      regex: /(?:Amount|Rs\.?|₹)\s*(?:of\s*)?₹?\s*([\d,]+\.?\d*)\s*(?:debited|credited|paid)\s*(?:from|to|via)\s*([A-Za-z\s]+)\s*(?:account|UPI|VPA)?.*?(?:UPI Ref No|UTR|Ref No)\s*(\d+)/i,
      map: (m) => ({
        amount: parseAmount(m[1]),
        currency: 'INR',
        bank_name: trimCapturedName(m[2]),
        reference_number: m[3],
        transaction_type: 'upi'
      }),
      confidence: 0.98,
    },
    {
      regex: /received\s+([\d,.]+)\s*(EGP|USD)\s+from\s+(.*?)\s+on\s+(.*?)\s+bank\b.*?(?:reference|ref)[:\s-]*([A-Z0-9-]+)/i,
      map: (m) => ({
        amount: parseAmount(m[1]),
        currency: detectCurrency(m[2]),
        sender_name: trimCapturedName(m[3]),
        bank_name: trimCapturedName(m[4]),
        reference_number: m[5]?.trim() || null,
        transaction_type: 'instapay',
      }),
      confidence: 0.97,
    },
    {
      regex: /(credited|received|deposited)\b.*?(?:INR|RS\.?)\s*([\d,.]+).*?(?:from|by)\s+([A-Z0-9 .&-]{2,})/i,
      map: (m) => ({
        amount: parseAmount(m[2]),
        currency: 'INR',
        sender_name: trimCapturedName(m[3]),
        reference_number: extractReferenceNumber(text),
        transaction_type: 'deposit',
      }),
      confidence: 0.92,
    },
    {
      regex: /(?:INR|RS\.?)\s*([\d,.]+)\s+(?:credited|received|deposited)\b.*?(?:from|by)\s+([A-Z0-9 .&-]{2,})/i,
      map: (m) => ({
        amount: parseAmount(m[1]),
        currency: 'INR',
        sender_name: trimCapturedName(m[2]),
        reference_number: extractReferenceNumber(text),
        transaction_type: 'deposit',
      }),
      confidence: 0.92,
    },
    {
      regex: /(debited|paid|sent|transferred)\b.*?(?:INR|RS\.?)\s*([\d,.]+).*?\b(?:to)\s+([A-Z0-9 .&-]{2,})/i,
      map: (m) => ({
        amount: parseAmount(m[2]),
        currency: 'INR',
        beneficiary_name: trimCapturedName(m[3]),
        reference_number: extractReferenceNumber(text),
        transaction_type: m[1].toLowerCase() === 'paid' ? 'payment' : 'transfer',
      }),
      confidence: 0.91,
    },
    {
      regex: /(?:UPI|IMPS|NEFT|RTGS)\b.*?(?:INR|RS\.?)\s*([\d,.]+).*?(?:from)\s+([A-Z0-9 .&-]{2,})/i,
      map: (m) => ({
        amount: parseAmount(m[1]),
        currency: 'INR',
        sender_name: trimCapturedName(m[2]),
        reference_number: extractReferenceNumber(text),
        transaction_type: 'transfer',
      }),
      confidence: 0.9,
    },
    {
      regex: /(?:UPI|IMPS|NEFT|RTGS)\b.*?(?:INR|RS\.?)\s*([\d,.]+).*?(?:to)\s+([A-Z0-9 .&-]{2,})/i,
      map: (m) => ({
        amount: parseAmount(m[1]),
        currency: 'INR',
        beneficiary_name: trimCapturedName(m[2]),
        reference_number: extractReferenceNumber(text),
        transaction_type: 'payment',
      }),
      confidence: 0.9,
    },
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    const transaction = pattern.map(match);
    if (!transaction?.amount) continue;

    if (!transaction.currency) {
      transaction.currency = detectCurrency(text) || 'INR';
    }

    return {
      confidence: pattern.confidence ?? 0.9,
      transaction,
    };
  }

  return null;
}

function looksClearlyNonFinancialText(messageText: string): boolean {
  const text = messageText.trim().toLowerCase();
  if (!text) return true;

  const normalized = text.replace(/\s+/g, ' ');
  const financialSignals = /(bank|transfer|deposit|credited|debited|receipt|payment|instapay|upi|imps|neft|rtgs|utr|reference|amount|usd|egp|inr|rs\.?|₹|\$|€|\d{4,})/i;
  if (financialSignals.test(normalized)) return false;

  const chattySignals = [
    'hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'done',
    'هاي', 'هلا', 'مرحبا', 'تمام', 'شكرا',
    'extract the last two transaction', 'extract the last two transactions'
  ];

  if (chattySignals.includes(normalized)) return true;
  if (normalized.length <= 24) return true;
  return false;
}

const GEMINI_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['modality', 'is_financial', 'confidence', 'transactions'],
  properties: {
    modality: {
      type: 'string',
      enum: ['text', 'image', 'pdf', 'handwriting', 'unknown']
    },
    is_financial: { type: 'boolean' },
    confidence: { type: 'number' },
    review_reason: { type: ['string', 'null'] },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'transaction_date', 'transaction_time', 'transaction_type', 
          'bank_name', 'sender_name', 'sender_code', 'beneficiary_name', 
          'beneficiary_account', 'amount', 'amount_in_words_text', 'currency', 'reference_number', 'transaction_location',
          'confidence', 'review_required', 'review_reason'
        ],
        properties: {
          transaction_date: { type: ['string', 'null'] },
          transaction_time: { type: ['string', 'null'] },
          transaction_type: { type: ['string', 'null'] },
          bank_name: { type: ['string', 'null'] },
          sender_name: { type: ['string', 'null'] },
          sender_code: { type: ['string', 'null'] },
          beneficiary_name: { type: ['string', 'null'] },
          beneficiary_account: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] },
          amount_in_words_text: { type: ['string', 'null'] },
          currency: { type: ['string', 'null'] },
          reference_number: { type: ['string', 'null'] },
          transaction_location: { type: ['string', 'null'] },
          confidence: { type: ['number', 'null'] },
          review_required: { type: ['boolean', 'null'] },
          review_reason: { type: ['string', 'null'] }
        }
      }
    }
  }
};

function getGeminiText(result: any): string {
  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.text === 'function') return result.text();
  if (typeof result?.candidates?.[0]?.content?.parts?.[0]?.text === 'string') {
    return result.candidates[0].content.parts[0].text;
  }
  return '';
}

function buildInlineMediaPart(imageBuffer: Buffer, mimeType: string) {
  return {
    inlineData: {
      mimeType,
      data: imageBuffer.toString('base64')
    }
  };
}

async function prepareMediaBuffer(imageBuffer: Buffer, actualMimeType?: string, attachmentType?: string) {
  const mimeType = String(actualMimeType || '').toLowerCase() || (attachmentType === 'pdf' ? 'application/pdf' : 'image/jpeg');

  if (mimeType === 'application/pdf') {
    return { buffer: imageBuffer, mimeType, transformed: false };
  }

  if (mimeType.startsWith('image/')) {
    if (imageBuffer.length <= 500 * 1024) {
      return { buffer: imageBuffer, mimeType, transformed: false };
    }

    console.log(`[Extraction] Optimizing image buffer mime=${mimeType} size_bytes=${imageBuffer.length}`);
    try {
      const optimized = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      return { buffer: optimized, mimeType: 'image/jpeg', transformed: true };
    } catch (optErr: any) {
      console.warn(`[Extraction] Sharp optimization failed (${optErr.message}). Falling back to raw buffer.`);
      return { buffer: imageBuffer, mimeType, transformed: false };
    }
  }

  return { buffer: imageBuffer, mimeType, transformed: false };
}

function parseStructuredGeminiResponse(raw: string) {
  if (!raw?.trim()) {
    throw new Error('Gemini returned empty structured JSON response');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`Gemini returned invalid JSON: ${error.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Gemini returned malformed JSON payload');
  }

  if (typeof parsed.is_financial !== 'boolean') {
    throw new Error('Gemini JSON missing boolean is_financial');
  }
  if (typeof parsed.confidence !== 'number' || Number.isNaN(parsed.confidence)) {
    throw new Error('Gemini JSON missing numeric confidence');
  }
  if (!Array.isArray(parsed.transactions)) {
    throw new Error('Gemini JSON missing transactions array');
  }

  parsed.modality = normalizeMediaSourceType(parsed.modality);
  if (!parsed.modality) {
    throw new Error('Gemini JSON missing modality');
  }

  return parsed;
}

function normalizeArabicWordToken(token: string): string {
  return token
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .trim();
}

function parseArabicNumberWords(raw?: string | null): number | null {
  if (!raw) return null;

  const normalized = raw
    .replace(/[(),.:؛،/-]/g, ' ')
    .replace(/\b(?:جنيه|جنيها|جنيهاً|مصري|فقط|فحسب|لاغير|لا غير|only)\b/gi, ' ')
    .replace(/(^|\s)و(?=\S)/g, '$1و ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  const simpleMap: Record<string, number> = {
    'صفر': 0,
    'واحد': 1, 'واحده': 1, 'احد': 1, 'احدى': 1, 'إحدى': 1,
    'اثنان': 2, 'اثنين': 2, 'اثنتان': 2, 'اثنتين': 2, 'اتنين': 2,
    'ثلاث': 3, 'ثلاثه': 3,
    'اربع': 4, 'اربعه': 4,
    'خمس': 5, 'خمسه': 5,
    'ست': 6, 'سته': 6,
    'سبع': 7, 'سبعه': 7,
    'ثمان': 8, 'ثمانيه': 8,
    'تسع': 9, 'تسعه': 9,
    'عشر': 10, 'عشره': 10,
    'احدعشر': 11, 'احدىعشر': 11,
    'اثناعشر': 12, 'اثنيعشر': 12,
    'ثلاثهعشر': 13,
    'اربعهعشر': 14,
    'خمسهعشر': 15,
    'ستهعشر': 16,
    'سبعهعشر': 17,
    'ثمانيهعشر': 18,
    'تسعهعشر': 19,
    'عشرون': 20, 'عشرين': 20,
    'ثلاثون': 30, 'ثلاثين': 30,
    'اربعون': 40, 'اربعين': 40,
    'خمسون': 50, 'خمسين': 50,
    'ستون': 60, 'ستين': 60,
    'سبعون': 70, 'سبعين': 70,
    'ثمانون': 80, 'ثمانين': 80,
    'تسعون': 90, 'تسعين': 90,
    'مائه': 100, 'مئة': 100, 'مائهً': 100,
    'مائتان': 200, 'مئتان': 200, 'مائتين': 200, 'مئتين': 200,
    'ثلاثمائه': 300, 'ثلاثمئة': 300,
    'اربعمائه': 400, 'اربعمئة': 400,
    'خمسمائه': 500, 'خمسمئة': 500,
    'ستمائه': 600, 'ستمئة': 600,
    'سبعمائه': 700, 'سبعمئة': 700,
    'ثمانمائه': 800, 'ثمانمئة': 800,
    'تسعمائه': 900, 'تسعمئة': 900,
  };

  const multiplierMap: Record<string, number> = {
    'الف': 1000, 'الاف': 1000, 'الفا': 1000, 'الفين': 2000, 'الفان': 2000,
    'مليون': 1000000, 'ملايين': 1000000,
  };

  const tokens = normalized
    .split(' ')
    .map(normalizeArabicWordToken)
    .filter(Boolean)
    .filter(token => token !== 'و');

  let total = 0;
  let current = 0;
  let sawNumber = false;

  for (const token of tokens) {
    if (multiplierMap[token]) {
      sawNumber = true;
      const multiplier = multiplierMap[token];
      if (multiplier === 2000) {
        total += 2000;
      } else {
        total += (current || 1) * multiplier;
      }
      current = 0;
      continue;
    }

    if (simpleMap[token] !== undefined) {
      current += simpleMap[token];
      sawNumber = true;
      continue;
    }

    if (/^\d+$/.test(token)) {
      current += Number(token);
      sawNumber = true;
    }
  }

  if (!sawNumber) return null;
  return total + current;
}

function reconcileAmounts(tx: ExtractedTransaction): ExtractedTransaction {
  const wordsAmount = parseArabicNumberWords(tx.amount_in_words_text);
  if (wordsAmount == null) return tx;

  if (tx.amount == null) {
    tx.amount = wordsAmount;
    return tx;
  }

  if (tx.amount === wordsAmount) return tx;

  const diff = Math.abs(tx.amount - wordsAmount);
  const likelyOcrSuffixError =
    wordsAmount >= 10000 &&
    diff < 1000 &&
    Math.floor(tx.amount / 1000) === Math.floor(wordsAmount / 1000);

  tx.amount = wordsAmount;
  tx.confidence = Math.min(tx.confidence ?? 1, likelyOcrSuffixError ? 0.95 : 0.75);

  if (!likelyOcrSuffixError) {
    tx.review_required = true;
    tx.review_reason = tx.review_reason || 'Numeric amount disagrees with amount written in words';
  }

  return tx;
}

export async function extractMessage(
  messageText: string,
  context: PipelineContext,
  imageBuffer?: Buffer,
  attachmentType?: string,
  actualMimeType?: string
): Promise<ExtractionResult> {
  const ocr_text = messageText || '(binary media)';
  const inferredSourceType = deriveMediaSourceTypeFromMime(actualMimeType, Boolean(imageBuffer));
  
  try {
    if (!imageBuffer) {
      const ruleResult = tryRuleBasedExtraction(ocr_text);
      if (ruleResult) {
        const tx = {
          ...ruleResult.transaction,
          confidence: ruleResult.confidence,
          processing_status: ruleResult.confidence < 0.7 ? 'pending_review' : 'completed'
        };

        return {
          status: ruleResult.confidence < 0.7 ? 'LOW_CONFIDENCE' : 'SUCCESS',
          source_type: 'text',
          confidence: ruleResult.confidence,
          is_financial: true,
          ocr_text,
          transactions: [tx],
        };
      }

      if (looksClearlyNonFinancialText(ocr_text)) {
        return {
          status: 'NO_FINANCIAL',
          source_type: 'text',
          confidence: 0.99,
          is_financial: false,
          ocr_text,
          transactions: [],
        };
      }
    }

    const parts: any[] = [{ text: EXTRACTION_PROMPT + '\n\nInput Content:\n' + ocr_text }];

    if (imageBuffer) {
      const prepared = await prepareMediaBuffer(imageBuffer, actualMimeType, attachmentType);
      console.log(`[Extraction] Media prepared modality=${inferredSourceType} mime=${prepared.mimeType} original_bytes=${imageBuffer.length} prepared_bytes=${prepared.buffer.length} transformed=${prepared.transformed}`);
      parts.push(buildInlineMediaPart(prepared.buffer, prepared.mimeType));
    }

    const FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'];
    let result: any = null;
    let fallbackError: any = null;

    for (const model of FALLBACK_MODELS) {
      try {
        result = await client.models.generateContent({
          model,
          contents: [{ role: 'user', parts }],
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema: GEMINI_RESPONSE_JSON_SCHEMA
          }
        });
        break; // Success
      } catch (err: any) {
        fallbackError = err;
        const isQuota = err.message?.includes('429') || err.status === 429 || err.code === 429;
        if (isQuota) {
          console.warn(`[Extraction] Model ${model} Quota Exceeded (429). Falling back to next...`);
          continue; // Try next available model
        } else {
          throw err; // Non-quota error, throw immediately
        }
      }
    }

    if (!result) {
      throw fallbackError || new Error("All fallback models failed.");
    }

    const rawText = getGeminiText(result);
    console.log(`[Extraction] Gemini raw response preview=${JSON.stringify(rawText.slice(0, 500))}`);
    const parsed = parseStructuredGeminiResponse(rawText);

    const transactions = (parsed.transactions || [])
      .map((t: any) => ({
        ...t,
        amount_in_words_text: typeof t.amount_in_words_text === 'string' ? t.amount_in_words_text.trim() : null,
        transaction_location: typeof t.transaction_location === 'string' ? t.transaction_location.trim() : null,
        currency: t.currency || 'EGP',
        confidence: t.confidence ?? parsed.confidence ?? 0.5,
        processing_status: ((t.confidence ?? parsed.confidence ?? 0.5) < 0.7) ? 'pending_review' : 'completed'
      }))
      .map(reconcileAmounts);

    const confidence = parsed.confidence || 0.5;
    const sourceType = normalizeMediaSourceType(parsed.modality || inferredSourceType);
    const reviewReason = parsed.review_reason || (confidence < 0.7 ? 'Low overall confidence from Gemini extraction' : undefined);

    return {
      status: parsed.is_financial ? (confidence < 0.7 ? 'LOW_CONFIDENCE' : 'SUCCESS') : 'NO_FINANCIAL',
      source_type: sourceType,
      confidence,
      is_financial: Boolean(parsed.is_financial),
      ocr_text: ocr_text,
      review_reason: reviewReason,
      transactions
    };

  } catch (error: any) {
    const isQuotaError = error.message?.includes('429') || error.status === 429 || error.code === 429;
    const isMalformedResponse = /empty structured json|invalid json|malformed json|missing .*?(modality|is_financial|confidence|transactions)/i.test(error.message || '');
    const errorMessage = isQuotaError 
      ? 'GLOBAL_QUOTA_EXHAUSTED'
      : (error.message || 'AI Extraction failed');

    if (isQuotaError) {
      console.warn('[Extraction] ALL Models Exhausted (429). Emitting GLOBAL_QUOTA_EXHAUSTED.');
    } else {
      console.error('[Extraction] Fatal error:', error);
    }

    return {
      status: 'ERROR',
      is_quota_exceeded: isQuotaError,
      error_type: isQuotaError ? 'quota_failure' : (isMalformedResponse ? 'malformed_ai_response' : 'extraction_failure'),
      source_type: 'unknown',
      confidence: 0,
      is_financial: false,
      ocr_text,
      review_reason: errorMessage,
      transactions: []
    };
  }
}

/**
 * Legacy wrapper for backward compatibility.
 */
export async function extractTransactionData(
  messageText: string,
  context: PipelineContext,
  imageBuffer?: Buffer,
  attachmentType?: string,
  actualMimeType?: string
): Promise<ExtractedTransaction[]> {
  const res = await extractMessage(messageText, context, imageBuffer, attachmentType, actualMimeType);
  return res.transactions;
}
