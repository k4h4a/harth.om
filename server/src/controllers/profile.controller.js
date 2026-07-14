const knex = require("../db");
const bcrypt = require("bcrypt");
const repo = require("../repositories/profile.repository");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

// GET /profile/me
const getMe = asyncHandler(async (req, res) => {
  const data = await repo.getProfile(req.user.id);
  res.json({ success: true, ...data });
});

// PUT /profile/me
const updateMe = asyncHandler(async (req, res) => {
  const { name, username, bio, birth_date, gender, country, city, phone } = req.body;

  if (username) {
    const taken = await knex("user_profiles")
      .where({ username })
      .whereNot({ user_id: req.user.id })
      .first("user_id");
    if (taken) throw new AppError("اسم المستخدم مأخوذ بالفعل", 409);
  }

  const data = await repo.updateProfile(req.user.id, { name, username, bio, birth_date, gender, country, city, phone });
  await repo.logActivity(req.user.id, { action: "profile_update", description: "تم تحديث معلومات الملف الشخصي", ip: req.ip });
  res.json({ success: true, ...data });
});

// POST /profile/avatar
const uploadAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("No file uploaded", 400);
  const url = `/uploads/${req.file.filename}`;
  await repo.updateAvatar(req.user.id, url);
  res.json({ success: true, avatar_url: url });
});

// DELETE /profile/avatar
const removeAvatar = asyncHandler(async (req, res) => {
  await repo.removeAvatar(req.user.id);
  res.json({ success: true });
});

// POST /profile/change-password
const changePassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) throw new AppError("Both passwords required", 400);
  if (new_password.length < 8) throw new AppError("كلمة المرور يجب أن تكون 8 أحرف على الأقل", 400);

  const user = await knex("users").where({ id: req.user.id }).first("password_hash");
  if (!user) throw new AppError("User not found", 404);

  const ok = await bcrypt.compare(current_password, user.password_hash);
  if (!ok) throw new AppError("كلمة المرور الحالية غير صحيحة", 401);

  const hash = await bcrypt.hash(new_password, 12);
  await knex("users").where({ id: req.user.id }).update({ password_hash: hash });
  await repo.logActivity(req.user.id, { action: "password_change", description: "تم تغيير كلمة المرور", ip: req.ip, risk: "medium" });
  res.json({ success: true });
});

// PUT /profile/preferences
const updatePreferences = asyncHandler(async (req, res) => {
  await repo.updatePreferences(req.user.id, req.body);
  res.json({ success: true });
});

// GET /profile/sessions
const getSessions = asyncHandler(async (req, res) => {
  const sessions = await repo.getSessions(req.user.id);
  res.json({ success: true, sessions });
});

// DELETE /profile/sessions/:id
const revokeSession = asyncHandler(async (req, res) => {
  await repo.revokeSession(req.params.id, req.user.id);
  res.json({ success: true });
});

// DELETE /profile/sessions
const revokeAllSessions = asyncHandler(async (req, res) => {
  await repo.revokeAllSessions(req.user.id);
  await repo.logActivity(req.user.id, { action: "revoke_all_sessions", description: "تم تسجيل الخروج من جميع الأجهزة", ip: req.ip, risk: "medium" });
  res.json({ success: true });
});

// GET /profile/activity
const getActivity = asyncHandler(async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const log = await repo.getActivityLog(req.user.id, { limit: Number(limit), offset: Number(offset) });
  res.json({ success: true, log });
});

// POST /profile/2fa/toggle
const toggle2FA = asyncHandler(async (req, res) => {
  const { enabled } = req.body;
  await repo.toggle2FA(req.user.id, { enabled: !!enabled });
  await repo.logActivity(req.user.id, {
    action: enabled ? "2fa_enabled" : "2fa_disabled",
    description: enabled ? "تم تفعيل المصادقة الثنائية" : "تم تعطيل المصادقة الثنائية",
    ip: req.ip, risk: "high",
  });
  res.json({ success: true });
});

// POST /profile/export-data
const exportData = asyncHandler(async (req, res) => {
  const [user, profile, activity] = await Promise.all([
    knex("users").where({ id: req.user.id }).first("id","name","email","role","created_at"),
    knex("user_profiles").where({ user_id: req.user.id }).first(),
    repo.getActivityLog(req.user.id, { limit: 100 }),
  ]);
  await repo.markDataExport(req.user.id);
  res.json({ success: true, data: { user, profile, activity } });
});

// POST /profile/deactivate
const deactivate = asyncHandler(async (req, res) => {
  await knex("users").where({ id: req.user.id }).update({ account_status: "pending" });
  await repo.logActivity(req.user.id, { action: "deactivate", description: "تم تعطيل الحساب مؤقتاً", ip: req.ip, risk: "high" });
  res.json({ success: true });
});

// DELETE /profile
const deleteAccount = asyncHandler(async (req, res) => {
  const { confirm_text, password } = req.body;
  if (confirm_text !== "DELETE") throw new AppError("يجب كتابة DELETE للتأكيد", 400);

  const user = await knex("users").where({ id: req.user.id }).first("password_hash");
  const ok = await bcrypt.compare(password || "", user.password_hash);
  if (!ok) throw new AppError("كلمة المرور غير صحيحة", 401);

  await knex("users").where({ id: req.user.id }).update({ is_active: false, account_status: "deleted" });
  await repo.logActivity(req.user.id, { action: "account_deleted", description: "تم حذف الحساب نهائياً", ip: req.ip, risk: "high" });
  res.json({ success: true });
});

module.exports = {
  getMe, updateMe, uploadAvatar, removeAvatar, changePassword,
  updatePreferences, getSessions, revokeSession, revokeAllSessions,
  getActivity, toggle2FA, exportData, deactivate, deleteAccount,
};
