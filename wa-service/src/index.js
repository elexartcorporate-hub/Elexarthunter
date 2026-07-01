import express from "express";
import { MongoClient, GridFSBucket } from "mongodb";
import baileysPkg from "@whiskeysockets/baileys";
const { downloadMediaMessage } = baileysPkg;
import fs from "fs";
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
  diskPathFor,
  findDiskFile,
  WA_MEDIA_DIR,
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
// Bump payload limit so users can send large images/videos/documents (up to ~100MB).
// Base64 overhead is ~37%, so 100MB JSON = ~75MB raw file (well within WhatsApp's
// own document limit of 100MB).
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ extended: true, limit: "150mb" }));

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

app.get("/health", (req, res) => res.json({
  ok: true,
  media_dir: WA_MEDIA_DIR,
  // Feature markers — backend probes these to detect outdated wa-service:
  features: {
    disk_media_storage: true,
    rename_endpoint: true,
    pipeline_no_auto_recycle: true, // fix: cold/lost stay after customer reply
    pipeline_cold_lock_new_leads: true,
  },
  // Build marker so we know exactly which code is running
  build_marker: "2026-02-lid-pipeline-lock-cold",
}));

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

  // Backfill pipeline_status = "cold" for chats that don't have one yet (legacy chats
  // created via chats.upsert before pipeline was introduced). Ensures every chat has
  // a status "locked" at Cold by default — matches spec: new leads always start Cold.
  const missingPipelineIds = chats.filter((c) => !c.pipeline_status).map((c) => c._id);
  if (missingPipelineIds.length > 0) {
    await db.collection("wa_chats").updateMany(
      { _id: { $in: missingPipelineIds } },
      { $set: { pipeline_status: "cold", pipeline_stage: 0, pipeline_updated_at: new Date() } }
    );
    // Reflect in the response array so client sees it immediately
    for (const c of chats) {
      if (!c.pipeline_status) {
        c.pipeline_status = "cold";
        c.pipeline_stage = 0;
      }
    }
  }

  // Backfill name from latest push_name for chats that don't have one yet.
  // Aggressive: normalize JID via Baileys sock + also match by LID id (last part before @lid)
  // so we catch messages stored under any variant.
  const missingNameChats = chats.filter((c) => !c.custom_name && !c.name && (c.jid || "").includes("@lid"));
  if (missingNameChats.length > 0) {
    const sock = getSock(req.params.sid);
    for (const c of missingNameChats) {
      try {
        // Build broad list of jid variants: canonical + raw + normJid + LID-id-only match
        const jidCandidates = new Set();
        jidCandidates.add(c.jid);
        if (c.raw_jid) jidCandidates.add(c.raw_jid);
        try { jidCandidates.add(normJid(c.jid)); } catch (_) {}
        if (sock) {
          try {
            const canonical = await normJidWithLid(c.jid, sock);
            if (canonical) jidCandidates.add(canonical);
          } catch (_) {}
        }
        const jidsArr = [...jidCandidates];
        // Also extract LID id (before @lid) to do a regex/prefix match on any jid variant
        const lidId = (c.jid || "").split("@")[0].split(":")[0];
        const jidRegex = lidId ? new RegExp(`^${lidId}(:|@)`) : null;

        // Broad query: match jid OR raw_jid via $in OR regex (LID id prefix), from anyone (not just from_me:false)
        // We prefer non-from_me push_names first, then fallback to any push_name.
        const orClauses = [
          { jid: { $in: jidsArr } },
          { raw_jid: { $in: jidsArr } },
        ];
        if (jidRegex) {
          orClauses.push({ jid: jidRegex });
          orClauses.push({ raw_jid: jidRegex });
        }
        const query = {
          session_id: req.params.sid,
          $or: orClauses,
          push_name: { $nin: [null, ""] },
        };
        // Prefer messages NOT from-me (that's the contact's push_name, not our own).
        const preferred = await db.collection("wa_messages").findOne(
          { ...query, from_me: false },
          { sort: { timestamp: -1 }, projection: { push_name: 1 } }
        );
        const recent = preferred || await db.collection("wa_messages").findOne(
          query,
          { sort: { timestamp: -1 }, projection: { push_name: 1 } }
        );
        if (recent && recent.push_name) {
          c.name = recent.push_name;
          await db.collection("wa_chats").updateOne(
            { session_id: req.params.sid, jid: c.jid },
            { $set: { name: recent.push_name } }
          );
        }
      } catch (_) { /* ignore — backfill is best-effort */ }
    }
  }

  // Apply custom_name override on serialized output (user's manual rename wins)
  res.json(chats.map(({ _id, ...c }) => {
    if (c.custom_name && c.custom_name.trim()) {
      return { ...c, name: c.custom_name.trim(), _has_custom_name: true };
    }
    return c;
  }));
});

// Rename a chat (manual label — great for LID chats with no push_name resolved)
app.patch("/sessions/:sid/chats/:jid/rename", async (req, res) => {
  try {
    const { custom_name } = req.body || {};
    const upd = custom_name && String(custom_name).trim()
      ? { $set: { custom_name: String(custom_name).trim() } }
      : { $unset: { custom_name: "" } };
    await db.collection("wa_chats").updateOne(
      { session_id: req.params.sid, jid: req.params.jid },
      upd
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    await sendText(db, req.params.sid, req.params.jid, text);
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
    if (buffer.length > 100 * 1024 * 1024) return res.status(400).json({ error: "file too large (max 100MB)" });
    await sendMedia(db, req.params.sid, req.params.jid, { buffer, mimetype, fileName, caption, kind });
    res.json({ ok: true, size: buffer.length });
  } catch (e) {
    console.error("send media error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Download persisted media. Priority: DISK → GridFS → on-demand fetch via Baileys.
// Streams large files efficiently.
app.get("/sessions/:sid/messages/:msgid/media", async (req, res) => {
  try {
    const { sid, msgid } = req.params;
    const msg = await db.collection("wa_messages").findOne({
      session_id: sid,
      message_id: msgid,
    });
    if (!msg || !msg.media) return res.status(404).json({ error: "Message or media not found" });

    const mimetype = msg.media.mimetype || "application/octet-stream";
    const downloadAs = msg.media.file_name || `${msg.media.media_type}-${msgid}`;

    // ─── STEP 1: Serve from DISK (fastest, most reliable) ───
    const diskFile = msg.media.disk_path && fs.existsSync(msg.media.disk_path)
      ? msg.media.disk_path
      : findDiskFile(sid, msgid);
    if (diskFile) {
      const stat = fs.statSync(diskFile);
      res.setHeader("Content-Type", mimetype);
      res.setHeader("Content-Length", stat.size);
      if (req.query.download === "1") {
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadAs)}"`);
      } else {
        res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(downloadAs)}"`);
      }
      res.setHeader("Cache-Control", "private, max-age=86400");
      // Persist disk_path if it was found via scan (backfill)
      if (!msg.media.disk_path) {
        await db.collection("wa_messages").updateOne(
          { session_id: sid, message_id: msgid },
          { $set: { "media.disk_path": diskFile } }
        );
      }
      const stream = fs.createReadStream(diskFile);
      stream.on("error", (e) => {
        console.error("disk stream err:", e);
        if (!res.headersSent) res.status(500).json({ error: e.message });
      });
      stream.pipe(res);
      return;
    }

    // ─── STEP 2: GridFS (backup, older files) ───
    const bucket = new GridFSBucket(db, { bucketName: "wa_media" });
    const filename = `${sid}/${msgid}`;
    let file = await db.collection("wa_media.files").findOne({ filename });

    // ─── STEP 3: ON-DEMAND DOWNLOAD (decrypt via Baileys) ───
    if (!file && msg.raw_msg_message && msg.raw_msg_key) {
      const sock = getSock(sid);
      if (!sock) {
        return res.status(503).json({ error: "Session WA tidak aktif. Scan QR ulang lalu coba lagi." });
      }
      try {
        const fullMsg = { key: msg.raw_msg_key, message: msg.raw_msg_message };
        const buffer = await downloadMediaMessage(
          fullMsg,
          "buffer",
          {},
          { reuploadRequest: sock.updateMediaMessage }
        );
        if (buffer && buffer.length > 0) {
          // Save to DISK for future requests
          let savedDisk = null;
          try {
            savedDisk = diskPathFor(sid, msgid, msg.media.mimetype, msg.media.file_name);
            fs.writeFileSync(savedDisk, buffer);
          } catch (e) { console.error("[on-demand] disk save fail:", e.message); }
          // Also save to GridFS
          await new Promise((resolve, reject) => {
            const upload = bucket.openUploadStream(filename, {
              metadata: {
                session_id: sid, message_id: msgid, jid: msg.jid,
                media_type: msg.media.media_type, mimetype: msg.media.mimetype,
                file_name: msg.media.file_name,
              },
            });
            upload.on("error", reject);
            upload.on("finish", resolve);
            upload.end(buffer);
          });
          await db.collection("wa_messages").updateOne(
            { session_id: sid, message_id: msgid },
            { $set: { "media.downloaded": true, "media.file_size": buffer.length, "media.disk_path": savedDisk } }
          );
          // Serve directly from buffer (no need to re-read)
          res.setHeader("Content-Type", mimetype);
          res.setHeader("Content-Length", buffer.length);
          if (req.query.download === "1") {
            res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadAs)}"`);
          } else {
            res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(downloadAs)}"`);
          }
          res.setHeader("Cache-Control", "private, max-age=86400");
          res.end(buffer);
          return;
        }
      } catch (e) {
        console.error("[on-demand media] download failed:", e.message);
        return res.status(502).json({ error: `Gagal download dari WhatsApp: ${e.message}` });
      }
    }
    if (!file) {
      return res.status(404).json({ error: "Media tidak tersedia (chat lama sebelum fitur ini ada — tidak punya encryption key)" });
    }

    // ─── Fallback: stream from GridFS ───
    res.setHeader("Content-Type", mimetype);
    res.setHeader("Content-Length", file.length);
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadAs)}"`);
    } else {
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(downloadAs)}"`);
    }
    res.setHeader("Cache-Control", "private, max-age=86400");
    const stream = bucket.openDownloadStreamByName(filename);
    stream.on("error", (e) => {
      console.error("media stream err:", e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    });
    stream.pipe(res);
  } catch (e) {
    console.error("get media error:", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
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
