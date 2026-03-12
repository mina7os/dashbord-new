import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import db from "./src/lib/db.ts";
import { extractTransactionData } from "./src/services/extraction.ts";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // --- API Routes ---

  // Ingestion Endpoint (Simulated Webhook)
  app.post("/api/ingest", async (req, res) => {
    const { 
      message_id, 
      message_text, 
      sender_name, 
      sender_phone, 
      group_name, 
      attachment_url,
      attachment_type,
      image_base64 
    } = req.body;

    try {
      // 1. Save Raw Message
      const stmt = db.prepare(`
        INSERT INTO raw_messages (message_id, message_text, sender_name, sender_phone, group_name, attachment_url, attachment_type, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(message_id, message_text, sender_name, sender_phone, group_name, attachment_url, attachment_type, 'processing');

      // 2. Classification (Simple keyword check for MVP, could be LLM)
      const financialKeywords = ['transfer', 'remittance', 'instapay', 'deposit', 'bank', 'تحويل', 'حوالة', 'ايداع'];
      const isCandidate = financialKeywords.some(kw => message_text?.toLowerCase().includes(kw)) || attachment_url;

      if (!isCandidate) {
        db.prepare("UPDATE raw_messages SET status = 'ignored' WHERE message_id = ?").run(message_id);
        return res.json({ status: "ignored" });
      }

      // 3. Extraction
      let imageBuffer;
      if (image_base64) {
        imageBuffer = Buffer.from(image_base64, 'base64');
      }

      const extracted = await extractTransactionData(message_text || "", imageBuffer, attachment_type);
      extracted.message_id = message_id;
      extracted.attachment_url = attachment_url;
      extracted.raw_text = message_text;

      // 4. Duplicate Detection
      const existing = db.prepare("SELECT record_id FROM transactions WHERE reference_number = ? AND reference_number IS NOT NULL").get(extracted.reference_number);
      if (existing) {
        extracted.duplicate = true;
        extracted.processing_status = 'duplicate';
      }

      // 6. Auto-Reply Decision
      let reply_text = "";
      if (extracted.duplicate) {
        reply_text = "Thank you. This transaction appears to have been submitted before and is under review.";
      } else if (extracted.review_required) {
        reply_text = "Thank you. We received your message, but we need additional transaction details to complete the verification process.";
      } else if (extracted.transaction_type === 'transfer') {
        reply_text = `Thank you. Your transfer notification has been received successfully.\nReference number: ${extracted.reference_number}\nAmount: ${extracted.amount} ${extracted.currency}\nYour transaction will be reviewed and confirmed within 1–2 business days.`;
      } else if (extracted.transaction_type === 'deposit') {
        reply_text = "Thank you. Your deposit notification has been received and will be reviewed shortly.";
      }

      // 7. Save Transaction
      const transStmt = db.prepare(`
        INSERT INTO transactions (
          message_id, transaction_date, transaction_type, channel, bank_name, 
          sender_name, client_name, beneficiary_name, beneficiary_account, 
          amount, currency, reference_number, application_number, purpose, 
          source_document_type, confidence, review_required, duplicate, 
          processing_status, raw_text, attachment_url, reply_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      transStmt.run(
        extracted.message_id, extracted.transaction_date, extracted.transaction_type, extracted.channel, extracted.bank_name,
        extracted.sender_name, extracted.client_name, extracted.beneficiary_name, extracted.beneficiary_account,
        extracted.amount, extracted.currency, extracted.reference_number, extracted.application_number, extracted.purpose,
        extracted.source_document_type, extracted.confidence, extracted.review_required ? 1 : 0, extracted.duplicate ? 1 : 0,
        extracted.processing_status, extracted.raw_text, extracted.attachment_url, reply_text
      );

      // 6. Review Queue
      if (extracted.review_required || extracted.duplicate) {
        db.prepare(`
          INSERT INTO review_queue (message_id, reason, confidence, attachment_url, raw_text)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          message_id, 
          extracted.duplicate ? 'Duplicate suspected' : 'Missing critical fields',
          extracted.confidence,
          attachment_url,
          message_text
        );
      }

      // 7. Update Metrics (Simple increment for today)
      const today = new Date().toISOString().split('T')[0];
      db.prepare(`
        INSERT INTO dashboard_metrics (date, total_messages, financial_candidates, successful_extractions, pending_review, duplicates)
        VALUES (?, 1, 1, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          total_messages = total_messages + 1,
          financial_candidates = financial_candidates + 1,
          successful_extractions = successful_extractions + (CASE WHEN ? = 'completed' THEN 1 ELSE 0 END),
          pending_review = pending_review + (CASE WHEN ? = 'pending_review' THEN 1 ELSE 0 END),
          duplicates = duplicates + (CASE WHEN ? = 'duplicate' THEN 1 ELSE 0 END)
      `).run(
        today, 
        extracted.processing_status === 'completed' ? 1 : 0,
        extracted.processing_status === 'pending_review' ? 1 : 0,
        extracted.processing_status === 'duplicate' ? 1 : 0,
        extracted.processing_status,
        extracted.processing_status,
        extracted.processing_status
      );

      db.prepare("UPDATE raw_messages SET status = 'processed' WHERE message_id = ?").run(message_id);

      res.json({ status: "success", data: extracted });
    } catch (error) {
      console.error("Ingestion error:", error);
      res.status(500).json({ error: "Internal processing error" });
    }
  });

  // Dashboard Data Endpoints
  app.get("/api/dashboard/stats", (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const stats = db.prepare("SELECT * FROM dashboard_metrics WHERE date = ?").get(today) || {
      total_messages: 0, financial_candidates: 0, successful_extractions: 0, pending_review: 0, duplicates: 0
    };
    
    const totals = db.prepare(`
      SELECT 
        SUM(CASE WHEN currency = 'EGP' THEN amount ELSE 0 END) as egp_total,
        SUM(CASE WHEN currency = 'USD' THEN amount ELSE 0 END) as usd_total
      FROM transactions
    `).get();

    res.json({ stats, totals });
  });

  app.get("/api/dashboard/transactions", (req, res) => {
    const transactions = db.prepare("SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50").all();
    res.json(transactions);
  });

  app.get("/api/dashboard/review-queue", (req, res) => {
    const queue = db.prepare("SELECT * FROM review_queue WHERE review_status = 'pending' ORDER BY created_at DESC").all();
    res.json(queue);
  });

  // --- Vite / Static Handling ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
