// Session Manager — handles many concurrent Baileys connections
import baileysPkg from "@whiskeysockets/baileys";
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
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

  const entry = { sock: null, state: getEmptySessionState(), lastQrAt: 0, onMessage };
  sessions.set(sessionId, entry);

  await connectSession(db, sessionId);
  return entry.state;
}

async function connectSession(db, sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  const { state: authState, saveCreds } = await useMongoAuthState(db, sessionId);
  const { version } = await fetchLatestBaileysVersion();

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
          },
        }
      );
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
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
        entry.state.status = "reconnecting";
        // auto-reconnect after delay
        setTimeout(() => connectSession(db, sessionId).catch(console.error), 3000);
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
      await db.collection("wa_chats").updateOne(
        { session_id: sessionId, jid: c.id },
        {
          $set: {
            session_id: sessionId,
            jid: c.id,
            name: c.name || c.subject || null,
            unread_count: c.unreadCount || 0,
            updated_at: new Date(),
          },
        },
        { upsert: true }
      );
    }
  });
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

async function persistMessage(db, sessionId, sock, msg) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return;
  const text = getMsgText(msg.message);
  const fromMe = !!msg.key.fromMe;
  const ts = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000)
    : new Date();
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
        timestamp: ts,
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
  if (!sock) throw new Error("Session not connected");
  const res = await sock.sendMessage(jid, { text });
  return res;
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
