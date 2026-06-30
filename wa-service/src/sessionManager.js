// Session Manager — handles many concurrent Baileys connections
import baileysPkg from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  downloadMediaMessage,
} = baileysPkg;
import pino from "pino";
import qrcode from "qrcode";
import { GridFSBucket, ObjectId } from "mongodb";
import { useMongoAuthState, deleteMongoAuthState } from "./mongoAuthState.js";

const logger = pino({ level: "warn" });

const sessions = new Map(); // sessionId -> { sock, state: {status, qr, phone, name, error}, lastQrAt }

function getEmptySessionState() {
  return { status: "init", qr: null, phone: null, name: null, error: null };
}

export function listSessionIds() {
  return [...sessions.keys()];
}

export function getSessionState(sessionId) {
  const s = sessions.get(sessionId);
  return s ? s.state : null;
}

export function getSock(sessionId) {
  const s = sessions.get(sessionId);
  return s?.sock || null;
}

export async function startSession(db, sessionId, onMessage) {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId).state;
  }

  const entry = {
    sock: null,
    state: getEmptySessionState(),
    lastQrAt: 0,
    onMessage,
    retryCount: 0,
    keepAliveTimer: null,
  };
  sessions.set(sessionId, entry);

  await connectSession(db, sessionId);
  return entry.state;
}

// Exponential backoff with jitter — max 60s between retries
function nextBackoff(retryCount) {
  const base = Math.min(60_000, 3_000 * Math.pow(1.6, retryCount));
  const jitter = Math.random() * 1500;
  return Math.floor(base + jitter);
}

async function connectSession(db, sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  // Clear any prior keep-alive
  if (entry.keepAliveTimer) {
    clearInterval(entry.keepAliveTimer);
    entry.keepAliveTimer = null;
  }

  let authBundle;
  try {
    authBundle = await useMongoAuthState(db, sessionId);
  } catch (e) {
    console.error(`[${sessionId}] auth state load failed:`, e.message);
    entry.state.status = "reconnecting";
    entry.retryCount += 1;
    setTimeout(() => connectSession(db, sessionId).catch(console.error), nextBackoff(entry.retryCount));
    return;
  }
  const { state: authState, saveCreds } = authBundle;

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined; // baileys will use default
  }

  const sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    printQRInTerminal: false,
    browser: Browsers.macOS("Desktop"),
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 2_000,
  });

  entry.sock = sock;
  entry.state.status = "connecting";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        const dataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 2 });
        entry.state.qr = dataUrl;
        entry.state.status = "qr";
        entry.lastQrAt = Date.now();
      } catch (e) {
        console.error("qrcode generation failed:", e);
      }
    }
    if (connection === "open") {
      entry.state.status = "connected";
      entry.state.qr = null;
      entry.state.error = null;
      entry.retryCount = 0; // reset on successful connect
      entry.state.phone = sock.user?.id?.split(":")[0]?.split("@")[0] || null;
      entry.state.name = sock.user?.name || sock.user?.verifiedName || null;
      // persist account info
      await db.collection("wa_accounts").updateOne(
        { session_id: sessionId },
        {
          $set: {
            phone: entry.state.phone,
            name: entry.state.name,
            status: "connected",
            connected_at: new Date(),
            last_seen_at: new Date(),
          },
        }
      );
      // Defensive keep-alive: every 60s, send presence + update last_seen_at
      if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
      entry.keepAliveTimer = setInterval(async () => {
        try {
          if (sock.user) {
            await sock.sendPresenceUpdate("available").catch(() => {});
            await db.collection("wa_accounts").updateOne(
              { session_id: sessionId },
              { $set: { last_seen_at: new Date() } }
            );
          }
        } catch {}
      }, 60_000);
    } else if (connection === "close") {
      // Clear keep-alive immediately
      if (entry.keepAliveTimer) {
        clearInterval(entry.keepAliveTimer);
        entry.keepAliveTimer = null;
      }
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const errMsg = lastDisconnect?.error?.message || String(code || "unknown");
      console.log(`[${sessionId}] connection close code=${code} msg=${errMsg} loggedOut=${loggedOut}`);
      if (loggedOut) {
        entry.state.status = "logged_out";
        entry.state.error = "Logged out from phone";
        await deleteMongoAuthState(db, sessionId);
        await db.collection("wa_accounts").updateOne(
          { session_id: sessionId },
          { $set: { status: "logged_out" } }
        );
        sessions.delete(sessionId);
      } else {
        // Resilient reconnect with exponential backoff (3s → 5s → 8s → 13s → 21s → ... → cap 60s)
        entry.state.status = "reconnecting";
        entry.state.error = `Reconnecting (${errMsg})`;
        entry.retryCount += 1;
        const delay = nextBackoff(entry.retryCount);
        console.log(`[${sessionId}] reconnect attempt ${entry.retryCount} in ${delay}ms`);
        setTimeout(() => connectSession(db, sessionId).catch(console.error), delay);
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;
    for (const msg of m.messages) {
      try {
        await persistMessage(db, sessionId, sock, msg);
      } catch (e) {
        console.error("persistMessage err:", e);
      }
    }
  });

  sock.ev.on("chats.upsert", async (chats) => {
    for (const c of chats) {
      const jid = await normJidWithLid(c.id, sock);
      const isGroup = jid?.endsWith("@g.us");
      await db.collection("wa_chats").updateOne(
        { session_id: sessionId, jid },
        {
          $set: {
            session_id: sessionId,
            jid,
            name: c.name || c.subject || null,
            is_group: isGroup,
            unread_count: c.unreadCount || 0,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );
      if (isGroup) {
        fetchGroupMetadata(db, sessionId, sock, jid).catch(() => {});
      }
    }
  });

  sock.ev.on("chats.update", async (updates) => {
    for (const u of updates) {
      if (!u.id) continue;
      const jid = await normJidWithLid(u.id, sock);
      const set = { updated_at: new Date() };
      if (u.name !== undefined) set.name = u.name;
      if (u.unreadCount !== undefined) set.unread_count = u.unreadCount;
      await db.collection("wa_chats").updateOne(
        { session_id: sessionId, jid },
        { $set: set, $setOnInsert: { session_id: sessionId, jid } },
        { upsert: true }
      );
    }
  });

  sock.ev.on("contacts.upsert", async (contacts) => {
    for (const c of contacts) {
      if (!c.id) continue;
      const jid = await normJidWithLid(c.id, sock);
      // Distinguish: saved name (from user's contact list) vs push name (alias set by other user)
      // Address-book/saved name is what user explicitly saved → reliable.
      // Push name (`notify`) is what the OTHER person set as their own display → unreliable/alias.
      const savedName = c.name || c.verifiedName || null;       // reliable
      const pushName  = c.notify || null;                        // alias — keep separate
      const displayName = savedName || pushName || null;         // best-effort for legacy field
      await db.collection("wa_contacts").updateOne(
        { session_id: sessionId, jid },
        {
          $set: {
            session_id: sessionId,
            jid,
            name: displayName,
            saved_name: savedName,
            push_name: pushName,
            verified_name: c.verifiedName || null,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );
    }
  });
}

async function fetchGroupMetadata(db, sessionId, sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    await db.collection("wa_chats").updateOne(
      { session_id: sessionId, jid },
      {
        $set: {
          name: meta.subject || null,
          group_subject: meta.subject || null,
          group_owner: meta.owner || null,
          group_size: (meta.participants || []).length,
          group_desc: meta.desc || null,
          group_meta_fetched_at: new Date(),
        },
      }
    );
  } catch {}
}

function getMsgText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    (message.audioMessage ? "[audio]" : "") ||
    (message.imageMessage ? "[image]" : "") ||
    (message.videoMessage ? "[video]" : "") ||
    (message.documentMessage ? "[document]" : "") ||
    (message.stickerMessage ? "[sticker]" : "") ||
    ""
  );
}

function getMediaInfo(message) {
  if (!message) return null;
  if (message.imageMessage) {
    return {
      media_type: "image",
      mimetype: message.imageMessage.mimetype || "image/jpeg",
      caption: message.imageMessage.caption || "",
      file_name: null,
      file_length: Number(message.imageMessage.fileLength || 0),
    };
  }
  if (message.videoMessage) {
    return {
      media_type: "video",
      mimetype: message.videoMessage.mimetype || "video/mp4",
      caption: message.videoMessage.caption || "",
      file_name: null,
      file_length: Number(message.videoMessage.fileLength || 0),
    };
  }
  if (message.documentMessage) {
    return {
      media_type: "document",
      mimetype: message.documentMessage.mimetype || "application/octet-stream",
      caption: message.documentMessage.caption || "",
      file_name: message.documentMessage.fileName || "document",
      file_length: Number(message.documentMessage.fileLength || 0),
    };
  }
  if (message.audioMessage) {
    return {
      media_type: "audio",
      mimetype: message.audioMessage.mimetype || "audio/ogg",
      caption: "",
      file_name: null,
      file_length: Number(message.audioMessage.fileLength || 0),
    };
  }
  if (message.stickerMessage) {
    return {
      media_type: "sticker",
      mimetype: message.stickerMessage.mimetype || "image/webp",
      caption: "",
      file_name: null,
      file_length: Number(message.stickerMessage.fileLength || 0),
    };
  }
  return null;
}

// Helper: normalize JID to canonical form (strips device suffix, handles LID/PN mapping).
// Falls back to raw if normalization throws (e.g. for status@broadcast etc).
export function normJid(jid) {
  if (!jid || typeof jid !== "string") return jid;
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) return jid;
  try { return jidNormalizedUser(jid) || jid; }
  catch { return jid.split(":")[0].includes("@") ? jid.split(":")[0] : jid; }
}

// LID-aware normalization: if JID is @lid, try resolve to real PN via Baileys mapping.
// LID = "Local ID" — WhatsApp's anonymous privacy feature. Different from phone number.
// Without resolution, outgoing to @lid and incoming from @s.whatsapp.net create DUPLICATE chats.
export async function normJidWithLid(jid, sock) {
  if (!jid || typeof jid !== "string") return jid;
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) return jid;
  // Try LID → PN resolution if Baileys exposes the mapping
  if (jid.includes("@lid") && sock?.signalRepository?.lidMapping?.getPNForLID) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn && typeof pn === "string" && pn.includes("@")) return normJid(pn);
    } catch { /* mapping not available, fall through */ }
  }
  // Also try the synchronous variant in some Baileys versions
  if (jid.includes("@lid") && sock?.signalRepository?.lidMapping?.getPNForLIDSync) {
    try {
      const pn = sock.signalRepository.lidMapping.getPNForLIDSync(jid);
      if (pn && typeof pn === "string" && pn.includes("@")) return normJid(pn);
    } catch { /* ignore */ }
  }
  return normJid(jid);
}

async function persistMessage(db, sessionId, sock, msg) {
  if (!msg.message) return;
  const rawJid = msg.key.remoteJid;
  if (!rawJid || rawJid === "status@broadcast") return;
  const jid = await normJidWithLid(rawJid, sock);  // canonical JID (LID→PN resolved if possible)
  const text = getMsgText(msg.message);
  const fromMe = !!msg.key.fromMe;
  const ts = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000)
    : new Date();
  const media = getMediaInfo(msg.message);
  // Sender JID (for group chats — who in group sent it). Normalize too.
  const senderJid = msg.key.participant
    ? await normJidWithLid(msg.key.participant, sock)
    : (fromMe ? null : jid);
  await db.collection("wa_messages").updateOne(
    { session_id: sessionId, message_id: msg.key.id, jid },
    {
      $set: {
        session_id: sessionId,
        message_id: msg.key.id,
        jid,
        raw_jid: rawJid !== jid ? rawJid : undefined,
        from_me: fromMe,
        text,
        push_name: msg.pushName || null,
        sender_jid: senderJid,
        timestamp: ts,
        ...(media ? { media } : {}),
        // Persist the raw Baileys message envelope so we can decrypt & download the
        // media later on-demand (Baileys downloadMediaMessage needs mediaKey + directPath).
        ...(media ? { raw_msg_key: msg.key, raw_msg_message: msg.message } : {}),
      },
    },
    { upsert: true }
  );

  // Auto-download incoming media so client can later open/download it from the inbox.
  // We use GridFS to store binary safely (handles files >16MB MongoDB doc limit).
  if (media && !fromMe) {
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (buffer && buffer.length > 0) {
        const bucket = new GridFSBucket(db, { bucketName: "wa_media" });
        const filename = `${sessionId}/${msg.key.id}`;
        // Remove any existing copy (idempotent)
        const existing = await db.collection("wa_media.files").findOne({ filename });
        if (existing) {
          await bucket.delete(existing._id).catch(() => {});
        }
        const fileId = await new Promise((resolve, reject) => {
          const upload = bucket.openUploadStream(filename, {
            metadata: {
              session_id: sessionId,
              message_id: msg.key.id,
              jid,
              media_type: media.media_type,
              mimetype: media.mimetype,
              file_name: media.file_name,
            },
          });
          upload.on("error", reject);
          upload.on("finish", () => resolve(upload.id));
          upload.end(buffer);
        });
        // Mark message as having downloaded media (file ready to serve)
        await db.collection("wa_messages").updateOne(
          { session_id: sessionId, message_id: msg.key.id, jid },
          {
            $set: {
              "media.downloaded": true,
              "media.file_id": String(fileId),
              "media.file_size": buffer.length,
            },
          }
        );
      }
    } catch (e) {
      console.error(`[persistMessage] media auto-download failed for ${msg.key.id}:`, e.message);
      // Mark as failed so frontend can show a retry button instead of indefinite spinner
      await db.collection("wa_messages").updateOne(
        { session_id: sessionId, message_id: msg.key.id, jid },
        { $set: { "media.download_error": e.message } }
      );
    }
  }
  // upsert chat last message — using CANONICAL jid so outgoing/incoming converge
  await db.collection("wa_chats").updateOne(
    { session_id: sessionId, jid },
    {
      $set: {
        session_id: sessionId,
        jid,
        last_message: text,
        last_message_ts: ts,
        last_from_me: fromMe,
        updated_at: new Date(),
      },
      $inc: !fromMe ? { unread_count: 1 } : {},
    },
    { upsert: true }
  );
}

export async function stopSession(db, sessionId, deleteAuth = true) {
  const entry = sessions.get(sessionId);
  if (entry?.keepAliveTimer) {
    clearInterval(entry.keepAliveTimer);
    entry.keepAliveTimer = null;
  }
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch {}
    try { entry.sock.end(); } catch {}
  }
  sessions.delete(sessionId);
  if (deleteAuth) {
    await deleteMongoAuthState(db, sessionId);
    await db.collection("wa_accounts").updateOne(
      { session_id: sessionId },
      { $set: { status: "deleted" } }
    );
  }
}

export async function sendText(db, sessionId, jid, text) {
  const sock = getSock(sessionId);
  if (!sock) throw new Error("Session not started");
  if (!sock.user) throw new Error("Session not connected yet (scan QR first)");
  const targetJid = await normJidWithLid(jid, sock);
  const res = await sock.sendMessage(targetJid, { text });
  // Persist immediately so the message survives refresh — even if Baileys' messages.upsert
  // event arrives late or never fires for outgoing-from-this-device.
  try {
    const ts = res?.messageTimestamp
      ? new Date(Number(res.messageTimestamp) * 1000)
      : new Date();
    const msgId = res?.key?.id || `local-${Date.now()}`;
    await db.collection("wa_messages").updateOne(
      { session_id: sessionId, message_id: msgId, jid: targetJid },
      {
        $set: {
          session_id: sessionId,
          message_id: msgId,
          jid: targetJid,
          from_me: true,
          text,
          timestamp: ts,
        },
      },
      { upsert: true }
    );
    await db.collection("wa_chats").updateOne(
      { session_id: sessionId, jid: targetJid },
      {
        $set: {
          session_id: sessionId,
          jid: targetJid,
          last_message: text,
          last_message_ts: ts,
          last_from_me: true,
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[sendText] persist failed (non-fatal):", e.message);
  }
  return res;
}

export async function sendMedia(db, sessionId, jid, { buffer, mimetype, fileName, caption, kind }) {
  const sock = getSock(sessionId);
  if (!sock) throw new Error("Session not started");
  if (!sock.user) throw new Error("Session not connected yet (scan QR first)");
  const targetJid = await normJidWithLid(jid, sock);
  let payload;
  if (kind === "image") {
    payload = { image: buffer, caption: caption || "", mimetype };
  } else if (kind === "video") {
    payload = { video: buffer, caption: caption || "", mimetype };
  } else if (kind === "audio") {
    payload = { audio: buffer, mimetype, ptt: false };
  } else {
    payload = {
      document: buffer,
      mimetype: mimetype || "application/octet-stream",
      fileName: fileName || "file",
      caption: caption || undefined,
    };
  }
  const res = await sock.sendMessage(targetJid, payload);
  // Persist immediately for refresh-safety
  try {
    const ts = res?.messageTimestamp
      ? new Date(Number(res.messageTimestamp) * 1000)
      : new Date();
    const msgId = res?.key?.id || `local-${Date.now()}`;
    const previewLabel =
      kind === "image" ? "🖼️ Gambar"
      : kind === "video" ? "🎬 Video"
      : kind === "audio" ? "🎵 Audio"
      : `📎 ${fileName || "Dokumen"}`;
    await db.collection("wa_messages").updateOne(
      { session_id: sessionId, message_id: msgId, jid: targetJid },
      {
        $set: {
          session_id: sessionId,
          message_id: msgId,
          jid: targetJid,
          from_me: true,
          text: caption || "",
          timestamp: ts,
          media: {
            media_type: kind,
            mimetype: mimetype || null,
            file_name: fileName || null,
            caption: caption || null,
            file_length: buffer.length,
          },
        },
      },
      { upsert: true }
    );
    await db.collection("wa_chats").updateOne(
      { session_id: sessionId, jid: targetJid },
      {
        $set: {
          session_id: sessionId,
          jid: targetJid,
          last_message: caption || previewLabel,
          last_message_ts: ts,
          last_from_me: true,
          updated_at: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[sendMedia] persist failed (non-fatal):", e.message);
  }
  return res;
}

export async function listGroups(sessionId) {
  const sock = getSock(sessionId);
  if (!sock) throw new Error("Session not started");
  if (!sock.user) throw new Error("Session not connected yet (scan QR first)");
  try {
    const all = await sock.groupFetchAllParticipating();
    return Object.values(all).map((g) => ({
      jid: g.id,
      subject: g.subject,
      size: (g.participants || []).length,
      owner: g.owner || null,
      desc: g.desc || null,
    }));
  } catch (e) {
    return [];
  }
}

export async function markChatRead(db, sessionId, jid) {
  await db.collection("wa_chats").updateOne(
    { session_id: sessionId, jid },
    { $set: { unread_count: 0 } }
  );
  const sock = getSock(sessionId);
  if (sock) {
    try {
      // get recent unread msg keys
      const msgs = await db
        .collection("wa_messages")
        .find({ session_id: sessionId, jid, from_me: false })
        .sort({ timestamp: -1 })
        .limit(5)
        .toArray();
      const keys = msgs.map((m) => ({ remoteJid: jid, id: m.message_id, fromMe: false }));
      if (keys.length > 0) await sock.readMessages(keys);
    } catch {}
  }
}
