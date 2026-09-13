const path = require("path");
require("dotenv").config();

const required = ["PORT", "JWT_SECRET"];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(
    `🚨 Fatal: missing required env vars: ${missing.join(", ")}. See .env.example.`,
  );
  process.exit(1);
}

const hasDbConfig =
  process.env.DATABASE_URL ||
  (process.env.DB_HOST &&
    process.env.DB_USER &&
    process.env.DB_PASSWORD &&
    process.env.DB_NAME);
if (!hasDbConfig) {
  // eslint-disable-next-line no-console
  console.error(
    "🚨 Fatal: set either DATABASE_URL, or all of DB_HOST/DB_USER/DB_PASSWORD/DB_NAME. See .env.example.",
  );
  process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
  // eslint-disable-next-line no-console
  console.error("🚨 Fatal: JWT_SECRET must be at least 32 characters long.");
  process.exit(1);
}

const isProd = (process.env.NODE_ENV || "development") === "production";

// bootstrap-admin.js auto-creates an admin account on first boot from these
// two vars if no admin exists yet. In production that must never fall back
// to the well-known default in .env.example — forgetting to set
// ADMIN_PASSWORD would otherwise silently hand out a full-privilege admin
// account with a password anyone can find in this repo.
const DEFAULT_ADMIN_PASSWORD = "admin123";
if (
  isProd &&
  (!process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD.length < 12)
) {
  // eslint-disable-next-line no-console
  console.error(
    "🚨 Fatal: set a strong ADMIN_PASSWORD (>=12 chars, not the default) before running in production.",
  );
  process.exit(1);
}

if (
  isProd &&
  !process.env.STRIPE_SECRET_KEY &&
  process.env.ALLOW_MOCK_PAYMENTS !== "true"
) {
  // eslint-disable-next-line no-console
  console.error(
    "🚨 Fatal: running in production without STRIPE_SECRET_KEY. " +
      "Set STRIPE_SECRET_KEY, or set ALLOW_MOCK_PAYMENTS=true to override.",
  );
  process.exit(1);
}

// Mock-payment mode (no real STRIPE_SECRET_KEY, running only because
// ALLOW_MOCK_PAYMENTS=true) accepts webhook calls with no real Stripe
// signature to check — that's fine for local dev, but catastrophic in
// production: anyone could POST a fake "payment succeeded" event and mark
// any order/rental paid without paying. If this mode is ever active in
// production, require a second, explicitly-configured shared secret before
// the webhook accepts anything — MOCK_WEBHOOK_SECRET is deliberately NOT
// given a production default, so leaving ALLOW_MOCK_PAYMENTS=true on by
// mistake fails loudly at boot instead of quietly opening this hole.
const mockPaymentsActive = isProd && !process.env.STRIPE_SECRET_KEY && process.env.ALLOW_MOCK_PAYMENTS === "true";
if (mockPaymentsActive && (!process.env.MOCK_WEBHOOK_SECRET || process.env.MOCK_WEBHOOK_SECRET.length < 20)) {
  // eslint-disable-next-line no-console
  console.error(
    "🚨 Fatal: ALLOW_MOCK_PAYMENTS=true in production requires MOCK_WEBHOOK_SECRET " +
      "(>=20 chars) to be set — this is the only thing standing between the payment " +
      "webhook and anyone on the internet who can guess it's open.",
  );
  process.exit(1);
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: parseInt(process.env.PORT, 10) || 3000,

  DB_HOST: process.env.DB_HOST,
  DB_PORT: parseInt(process.env.DB_PORT, 10) || 5432,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME,
  DATABASE_URL: process.env.DATABASE_URL,

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "7d",

  BCRYPT_ROUNDS: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,

  UPLOAD_DIR: process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.resolve(__dirname, "../../uploads"),
  UPLOAD_MAX_BYTES:
    parseInt(process.env.UPLOAD_MAX_BYTES, 10) || 5 * 1024 * 1024,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",

  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "admin@harth.com",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123",

  // Stripe (Phase 2)
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  STRIPE_CURRENCY: process.env.STRIPE_CURRENCY || "omr",
  // Required to actually use mock-payment mode in production (see the fatal
  // check above). In development, falls back to a fixed, publicly-known
  // value purely so local testing keeps working out of the box — never
  // relied on for anything security-relevant outside production.
  MOCK_WEBHOOK_SECRET:
    process.env.MOCK_WEBHOOK_SECRET || (isProd ? "" : "dev-only-mock-webhook-secret"),

  // Email / SMTP (Phase 4). All optional — missing vars silently disable email.
  // Also the delivery channel for registration OTP codes (Phase 5).
  SMTP_HOST: process.env.SMTP_HOST || "",
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASS: process.env.SMTP_PASS || "",
  SMTP_FROM: process.env.SMTP_FROM || "",

  // Twilio / WhatsApp (Phase 4). Used only for order/rental WhatsApp
  // notifications (notification.service.js) — NOT for account verification,
  // which uses email OTP (registrationOtp.service.js). All optional.
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM || "",

  // Registration email OTP (Phase 5).
  REGISTRATION_OTP_EXPIRY_MINUTES:
    parseInt(process.env.REGISTRATION_OTP_EXPIRY_MINUTES, 10) || 5,
  REGISTRATION_OTP_MAX_ATTEMPTS:
    parseInt(process.env.REGISTRATION_OTP_MAX_ATTEMPTS, 10) || 5,
  PENDING_REGISTRATION_TTL_MINUTES:
    parseInt(process.env.PENDING_REGISTRATION_TTL_MINUTES, 10) || 30,

  // Cloudinary (persistent file storage). Optional in development — if any
  // of the three is missing, uploads fall back to local disk storage
  // (server/uploads/), which is fine locally but is NOT persistent on
  // Render's free plan (the filesystem resets on every deploy/restart).
  // Set all three in production to keep uploaded images/PDFs across deploys.
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",

  // Google OAuth ("Sign in with Google"). Optional — if left blank, the
  // /auth/google routes respond with a clear 503 instead of crashing.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
  GOOGLE_CALLBACK_URL:
    process.env.GOOGLE_CALLBACK_URL ||
    `http://localhost:${parseInt(process.env.PORT, 10) || 3000}/api/v1/auth/google/callback`,

  // Frontend origin, used only to build absolute redirect URLs after Google
  // OAuth (see auth.controller.js's googleAuthCallback). Left blank in dev,
  // where the frontend is served from this same origin — required in
  // production once the frontend lives on a different domain (Vercel).
  FRONTEND_URL: process.env.FRONTEND_URL || "",
};

module.exports = Object.freeze(env);
