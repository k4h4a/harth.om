const knex = require("../db");

// Ensure profile row exists (upsert pattern)
async function ensureProfile(userId) {
  const exists = await knex("user_profiles").where({ user_id: userId }).first("user_id");
  if (!exists) {
    await knex("user_profiles").insert({ user_id: userId }).onConflict("user_id").ignore();
  }
}

async function getProfile(userId) {
  await ensureProfile(userId);
  const user = await knex("users")
    .where({ id: userId })
    .first("id", "name", "email", "role", "is_pro", "account_status", "created_at");
  const profile = await knex("user_profiles").where({ user_id: userId }).first();
  return { ...user, profile: profile || {} };
}

async function updateProfile(userId, { name, username, bio, birth_date, gender, country, city, phone }) {
  // Update users table
  await knex("users").where({ id: userId }).update({
    ...(name !== undefined && { name }),
    updated_at: knex.fn.now(),
  });

  // Upsert profile
  await knex("user_profiles")
    .insert({ user_id: userId, username, bio, birth_date, gender, country, city, phone })
    .onConflict("user_id")
    .merge({ username, bio, birth_date: birth_date || null, gender, country, city, phone });

  return getProfile(userId);
}

async function updateAvatar(userId, avatarUrl) {
  await knex("user_profiles")
    .insert({ user_id: userId, avatar_url: avatarUrl })
    .onConflict("user_id")
    .merge({ avatar_url: avatarUrl });
}

async function removeAvatar(userId) {
  await knex("user_profiles")
    .where({ user_id: userId })
    .update({ avatar_url: null });
}

async function updatePreferences(userId, prefs) {
  const allowed = ["language","theme","notif_orders","notif_messages","notif_promos",
                   "notif_security","notif_email","notif_whatsapp","login_alerts"];
  const clean = {};
  allowed.forEach(k => { if (prefs[k] !== undefined) clean[k] = prefs[k]; });
  if (!Object.keys(clean).length) return;

  await knex("user_profiles")
    .insert({ user_id: userId, ...clean })
    .onConflict("user_id")
    .merge(clean);
}

async function getSessions(userId) {
  return knex("user_sessions")
    .where({ user_id: userId })
    .orderBy("last_active", "desc")
    .limit(20);
}

async function revokeSession(sessionId, userId) {
  return knex("user_sessions").where({ id: sessionId, user_id: userId }).delete();
}

async function revokeAllSessions(userId, exceptHash = null) {
  const q = knex("user_sessions").where({ user_id: userId });
  if (exceptHash) q.whereNot({ token_hash: exceptHash });
  return q.delete();
}

async function logActivity(userId, { action, description, ip, device, risk = "low" }) {
  return knex("user_activity_log").insert({
    user_id: userId,
    action,
    description,
    ip_address: ip || null,
    device_info: device || null,
    risk_level: risk,
  });
}

async function getActivityLog(userId, { limit = 20, offset = 0 } = {}) {
  return knex("user_activity_log")
    .where({ user_id: userId })
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset);
}

async function toggle2FA(userId, { enabled, secret = null, backupCodes = [] }) {
  await knex("user_profiles")
    .insert({ user_id: userId, two_fa_enabled: enabled, two_fa_secret: secret, backup_codes: JSON.stringify(backupCodes) })
    .onConflict("user_id")
    .merge({ two_fa_enabled: enabled, two_fa_secret: secret, backup_codes: JSON.stringify(backupCodes) });
}

async function markDataExport(userId) {
  await knex("user_profiles")
    .insert({ user_id: userId, data_export_at: knex.fn.now() })
    .onConflict("user_id")
    .merge({ data_export_at: knex.fn.now() });
}

module.exports = {
  getProfile, updateProfile, updateAvatar, removeAvatar,
  updatePreferences, getSessions, revokeSession, revokeAllSessions,
  logActivity, getActivityLog, toggle2FA, markDataExport,
};
