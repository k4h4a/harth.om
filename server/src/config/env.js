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
  SMTP_HOST: process.env.SMTP_HOST || "",
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_USER: process.env.SMTP_USER || "",
  SMTP_PASSWORD: process.env.SMTP_PASSWORD || "",
  SMTP_FROM: process.env.SMTP_FROM || "",

  // Twilio / WhatsApp / SMS (Phase 4). Also all optional.
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || "",
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || "",
  TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM || "",
  TWILIO_SMS_FROM: process.env.TWILIO_SMS_FROM || "",

  // Phone OTP verification (Phase 5). Length must be 4 or 6; anything else
  // silently falls back to 6 rather than failing boot (matches the SMTP/
  // Twilio vars above — not critical enough to be fail-fast like JWT_SECRET).
  PHONE_OTP_LENGTH: [4, 6].includes(parseInt(process.env.PHONE_OTP_LENGTH, 10))
    ? parseInt(process.env.PHONE_OTP_LENGTH, 10)
    : 6,
  PHONE_OTP_EXPIRY_MINUTES: parseInt(process.env.PHONE_OTP_EXPIRY_MINUTES, 10) || 5,
  PHONE_OTP_MAX_ATTEMPTS: parseInt(process.env.PHONE_OTP_MAX_ATTEMPTS, 10) || 5,
  PENDING_REGISTRATION_TTL_MINUTES:
    parseInt(process.env.PENDING_REGISTRATION_TTL_MINUTES, 10) || 30,
};

module.exports = Object.freeze(env);
