/**
 * WhatsApp via Twilio — used by notification.service.js for order/rental
 * WhatsApp notifications (unrelated to account verification, which uses
 * email OTP — see registrationOtp.service.js).
 *
 * Follows the same contract as email.service: never throws, returns
 * { sent, reason, ... } so notification flow is uniform across channels.
 *
 * Twilio's WhatsApp API requires the 'whatsapp:' prefix on both from/to
 * numbers. We normalize here so callers just pass E.164 numbers.
 */
const env = require("../config/env");

const hasTwilio = !!(
  env.TWILIO_ACCOUNT_SID &&
  env.TWILIO_AUTH_TOKEN &&
  env.TWILIO_WHATSAPP_FROM
);

let client = null;
if (hasTwilio) {
  const twilio = require("twilio");
  client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
}

function normalizeWhatsapp(number) {
  if (!number) return null;
  const trimmed = String(number).trim();
  if (trimmed.startsWith("whatsapp:")) return trimmed;
  return `whatsapp:${trimmed.startsWith("+") ? trimmed : "+" + trimmed}`;
}

/**
 * Send a WhatsApp message.
 * @param {{ to: string, body: string }} args
 */
async function sendWhatsApp({ to, body }) {
  if (!hasTwilio) return { sent: false, reason: "not_configured" };
  if (!to) return { sent: false, reason: "no_recipient" };

  try {
    const msg = await client.messages.create({
      from: normalizeWhatsapp(env.TWILIO_WHATSAPP_FROM),
      to: normalizeWhatsapp(to),
      body,
    });
    return { sent: true, messageId: msg.sid };
  } catch (err) {
    return { sent: false, reason: "error", error: err.message };
  }
}

module.exports = {
  sendWhatsApp,
  isConfigured: hasTwilio,
};
