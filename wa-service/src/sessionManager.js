// Session Manager — handles many concurrent Baileys connections
import baileysPkg from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
} = baileysPkg;
import pino from "pino";
import qrcode from "qrcode";
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
      const jid = normJid(c.id);
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
      const jid = normJid(u.id);
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
      const jid = normJid(c.id);
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

async function persistMessage(db, sessionId, sock, msg) {
  if (!msg.message) return;
  const rawJid = msg.key.remoteJid;
  if (!rawJid || rawJid === "status@broadcast") return;
  const jid = normJid(rawJid);  // canonical JID — same for outgoing & incoming
  const text = getMsgText(msg.message);
  const fromMe = !!msg.key.fromMe;
  const ts = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000)
    : new Date();
  const media = getMediaInfo(msg.message);
  // Sender JID (for group chats — who in group sent it). Normalize too.
  const senderJid = msg.key.participant ? normJid(msg.key.participant) : (fromMe ? null : jid);
  await db.collection("wa_messages").updateOne(
    { session_id: sessionId, message_id: msg.key.id, jid },
    {
      $set: {
        session_id: sessionId,
        message_id: msg.key.id,
        jid,
        from_me: fromMe,
        text,
        push_name: msg.pushName || null,
        sender_jid: senderJid,
        timestamp: ts,
        ...(media ? { media } : {}),
      },
    },
    { upsert: true }
  );
  // upsert chat last message
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

export async function sendText(sessionId, jid, text) {
  const sock = getSock(sessionId);
  if (!sock) throw new Error("Session not started");
  if (!sock.user) throw new Error("Session not connected yet (scan QR first)");
  const targetJid = normJid(jid); // ensure canonical so outgoing matches future incoming
  const res = await sock.sendMessage(targetJid, { text });
  return res;
}

export async function sendMedia(sessionId, jid, { buffer, mimetype, fileName, caption, kind }) {
  const sock = getSock(sessionId);
  if (!sock) throw new Error("Session not started");
  if (!sock.user) throw new Error("Session not connected yet (scan QR first)");
  const targetJid = normJid(jid);
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
