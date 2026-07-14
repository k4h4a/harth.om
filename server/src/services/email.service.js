/**
 * Email service via nodemailer.
 *
 * If SMTP env vars are not set, send() returns { sent: false, reason: 'not_configured' }
 * instead of throwing — the caller records this in notifications_log and moves on.
 * That way, missing SMTP never blocks an order from being created.
 *
 * Production should always configure SMTP and monitor sent=false in the logs.
 */
const nodemailer = require("nodemailer");
const env = require("../config/env");

const hasSmtp = !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);

let transporter = null;
if (hasSmtp) {
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465, // implicit TLS on 465, STARTTLS elsewhere
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });
}

/**
 * Send an email. Resolves to:
 *   { sent: true, messageId }                    on success
 *   { sent: false, reason: 'not_configured' }    when SMTP vars are missing
 *   { sent: false, reason: 'error', error }      on SMTP failure
 *
 * Never throws — callers treat the result as informational only.
 */
async function send({ to, subject, text, html = null }) {
  if (!hasSmtp) {
    return { sent: false, reason: "not_configured" };
  }
  try {
    const info = await transporter.sendMail({
      from: env.SMTP_FROM || env.SMTP_USER,
      to,
      subject,
      text,
      html: html || undefined,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    return { sent: false, reason: "error", error: err.message };
  }
}

module.exports = { send, isConfigured: hasSmtp };
