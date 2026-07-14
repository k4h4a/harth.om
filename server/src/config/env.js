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
};

module.exports = Object.freeze(env);
