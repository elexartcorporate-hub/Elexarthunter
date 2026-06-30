import express from "express";
import { MongoClient } from "mongodb";
import {
  startSession,
  stopSession,
  getSessionState,
  sendText,
  sendMedia,
  markChatRead,
  listGroups,
  normJid,
  normJidWithLid,
  getSock,
} from "./sessionManager.js";

const PORT = parseInt(process.env.WA_SERVICE_PORT || "3002", 10);
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017";
const DB_NAME = process.env.DB_NAME || "lead_hunter_db";

const client = new MongoClient(MONGO_URL);
await client.connect();
const db = client.db(DB_NAME);

// Indexes
await db.collection("wa_accounts").createIndex({ session_id: 1 }, { unique: true });
await db.collection("wa_accounts").createIndex({ tenant_id: 1, user_id: 1 });
await db.collection("wa_chats").createIndex({ session_id: 1, jid: 1 }, { unique: true });
await db.collection("wa_chats").createIndex({ session_id: 1, updated_at: -1 });
await db.collection("wa_messages").createIndex(
  { session_id: 1, message_id: 1, jid: 1 },
  { unique: true }
);
await db.collection("wa_messages").createIndex({ session_id: 1, jid: 1, timestamp: -1 });

console.log(`[wa-service] connected to MongoDB db=${DB_NAME}`);

// Auto-resume all accounts that were 'connected' before shutdown
const existing = await db.collection("wa_accounts").find({
  status: { $in: ["connected", "qr", "reconnecting"] },
}).toArray();
console.log(`[wa-service] resuming ${existing.length} session(s)`);
for (const acc of existing) {
  startSession(db, acc.session_id).catch((e) =>
    console.error("resume failed", acc.session_id, e.message)
  );
}

const app = express();
app.use(express.json({ limit: "5mb" }));

// Simple shared-secret auth between FastAPI and this sidecar
const SHARED_SECRET = process.env.WA_SERVICE_SECRET || "dev-secret";
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const provided = req.header("X-WA-Secret");
  if (provided !== SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

// Create new account (FastAPI calls this)
app.post("/sessions", async (req, res) => {
  try {
    const { session_id, tenant_id, user_id, label } = req.body || {};
    if (!session_id || !tenant_id || !user_id) {
      return res.status(400).json({ error: "Missing session_id/tenant_id/user_id" });
    }
    await db.collection("wa_accounts").updateOne(
      { session_id },
      {
        $set: { session_id, tenant_id, user_id, label: label || null, status: "init" },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true }
    );
    await startSession(db, session_id);
    const state = getSessionState(session_id) || { status: "init" };
    res.json({ session_id, ...state });
  } catch (e) {
    console.error("POST /sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Get current status (frontend polls this every 2s while in QR/connecting state)
app.get("/sessions/:sid", async (req, res) => {
  const state = getSessionState(req.params.sid);
  if (!state) {
    // try to resume from DB if account exists
    const acc = await db.collection("wa_accounts").findOne({ session_id: req.params.sid });
    if (!acc) return res.status(404).json({ error: "Not found" });
    await startSession(db, req.params.sid);
    return res.json({ session_id: req.params.sid, ...getSessionState(req.params.sid) });
  }
  res.json({ session_id: req.params.sid, ...state });
});

// Delete / logout
app.delete("/sessions/:sid", async (req, res) => {
  try {
    await stopSession(db, req.params.sid, true);
    // Comprehensive cleanup: remove all session traces (defensive against
    // auto-resume coming back to life after a delete).
    await db.collection("wa_accounts").deleteOne({ session_id: req.params.sid });
    await db.collection("wa_chats").deleteMany({ session_id: req.params.sid });
    await db.collection("wa_messages").deleteMany({ session_id: req.params.sid });
    await db.collection("wa_contacts").deleteMany({ session_id: req.params.sid });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /sessions error:", e);
    res.status(500).json({ error: e.message });
  }
});

// List chats for a session — supports ?since_ts for delta polling
app.get("/sessions/:sid/chats", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const q = { session_id: req.params.sid };
  if (req.query.since_ts) {
    const since = new Date(req.query.since_ts);
    if (!isNaN(since.getTime())) q.updated_at = { $gt: since };
  }
  const chats = await db
    .collection("wa_chats")
    .find(q)
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray();
  res.json(chats.map(({ _id, ...c }) => c));
});

// Messages for a chat
app.get("/sessions/:sid/chats/:jid/messages", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  const sinceTs = req.query.since_ts ? new Date(req.query.since_ts) : null;
  // LID-aware: if jid is @lid, try resolve to real PN via Baileys mapping for queryability
  const sock = getSock(req.params.sid);
  const canonicalJid = sock ? await normJidWithLid(req.params.jid, sock) : normJid(req.params.jid);
  // Look up canonical + raw + simple-normalized (handle legacy rows + LID/PN duality)
  const jidsToCheck = new Set([canonicalJid, req.params.jid, normJid(req.params.jid)]);
  const q = { session_id: req.params.sid, jid: { $in: [...jidsToCheck] } };
  if (sinceTs && !isNaN(sinceTs.getTime())) {
    q.timestamp = { $gt: sinceTs };
  }
  const msgs = await db
    .collection("wa_messages")
    .find(q)
    .sort({ timestamp: -1 })
    .limit(limit)
    .toArray();
  res.json(msgs.map(({ _id, ...m }) => m).reverse());
});

// Send text
app.post("/sessions/:sid/chats/:jid/messages", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "text required" });
    await sendText(req.params.sid, req.params.jid, text);
    res.json({ ok: true });
  } catch (e) {
    console.error("send error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Send media (image / video / document / audio) — body: { kind, base64, mimetype, fileName, caption }
app.post("/sessions/:sid/chats/:jid/media", async (req, res) => {
  try {
    const { kind, base64, mimetype, fileName, caption } = req.body || {};
    if (!kind || !base64) return res.status(400).json({ error: "kind & base64 required" });
    const allowed = ["image", "video", "document", "audio"];
    if (!allowed.includes(kind)) return res.status(400).json({ error: `kind must be ${allowed.join("|")}` });
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) return res.status(400).json({ error: "empty buffer" });
    if (buffer.length > 50 * 1024 * 1024) return res.status(400).json({ error: "file too large (max 50MB)" });
    await sendMedia(req.params.sid, req.params.jid, { buffer, mimetype, fileName, caption, kind });
    res.json({ ok: true, size: buffer.length });
  } catch (e) {
    console.error("send media error:", e);
    res.status(500).json({ error: e.message });
  }
});

// List groups (fresh fetch from WA — useful when groups change)
app.get("/sessions/:sid/groups", async (req, res) => {
  try {
    const groups = await listGroups(req.params.sid);
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark chat read
app.post("/sessions/:sid/chats/:jid/read", async (req, res) => {
  try {
    await markChatRead(db, req.params.sid, req.params.jid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wa-service] listening on 0.0.0.0:${PORT}`);
});
