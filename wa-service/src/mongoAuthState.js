// MongoDB-backed auth state for Baileys
// Replaces useMultiFileAuthState — auth state persisted in MongoDB so sessions
// survive sidecar restarts.

import baileysPkg from "@whiskeysockets/baileys";
const { initAuthCreds, BufferJSON, proto } = baileysPkg;

export async function useMongoAuthState(db, sessionId) {
  const credsColl = db.collection("wa_auth_creds");
  const keysColl = db.collection("wa_auth_keys");

  // Ensure indexes (idempotent)
  await keysColl.createIndex({ session_id: 1, type: 1, id: 1 }, { unique: true });

  // Load creds
  const credsDoc = await credsColl.findOne({ session_id: sessionId });
  let creds;
  if (credsDoc && credsDoc.creds) {
    creds = JSON.parse(credsDoc.creds, BufferJSON.reviver);
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    const serialized = JSON.stringify(creds, BufferJSON.replacer);
    await credsColl.updateOne(
      { session_id: sessionId },
      { $set: { session_id: sessionId, creds: serialized, updated_at: new Date() } },
      { upsert: true }
    );
  };

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const docs = await keysColl
          .find({ session_id: sessionId, type, id: { $in: ids } })
          .toArray();
        const out = {};
        for (const d of docs) {
          let value = JSON.parse(d.value, BufferJSON.reviver);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          out[d.id] = value;
        }
        return out;
      },
      set: async (data) => {
        const ops = [];
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            if (value) {
              ops.push({
                updateOne: {
                  filter: { session_id: sessionId, type: category, id },
                  update: {
                    $set: {
                      session_id: sessionId,
                      type: category,
                      id,
                      value: JSON.stringify(value, BufferJSON.replacer),
                      updated_at: new Date(),
                    },
                  },
                  upsert: true,
                },
              });
            } else {
              ops.push({
                deleteOne: {
                  filter: { session_id: sessionId, type: category, id },
                },
              });
            }
          }
        }
        if (ops.length > 0) {
          await keysColl.bulkWrite(ops, { ordered: false });
        }
      },
    },
  };

  return { state, saveCreds };
}

export async function deleteMongoAuthState(db, sessionId) {
  await db.collection("wa_auth_creds").deleteMany({ session_id: sessionId });
  await db.collection("wa_auth_keys").deleteMany({ session_id: sessionId });
}
