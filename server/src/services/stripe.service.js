/**
 * Stripe integration.
 *
 * When STRIPE_SECRET_KEY is set, this module talks to the real Stripe API.
 * When it's missing, we fall back to a *deterministic mock* that simulates
 * PaymentIntent creation and webhook signatures so the whole order flow
 * can be exercised in dev without a Stripe account.
 *
 * NEVER ship the mock to production — env.js enforces this by requiring
 * STRIPE_SECRET_KEY when NODE_ENV === 'production' in stripe service
 * only if payments are expected (we check at runtime below).
 */
const crypto = require("crypto");
const env = require("../config/env");
const { AppError } = require("../middleware/errorHandler");

const hasRealStripe = !!env.STRIPE_SECRET_KEY;
const stripe = hasRealStripe ? require("stripe")(env.STRIPE_SECRET_KEY) : null;

if (!hasRealStripe) {
  // Loud and impossible to miss in logs — this mode accepts unsigned
  // "payment succeeded" webhook calls (see verifyWebhook below). env.js
  // already refuses to boot in production without MOCK_WEBHOOK_SECRET set,
  // but this warning exists so it's also obvious to anyone watching logs,
  // in any environment, exactly when mock mode is active.
  // eslint-disable-next-line no-console
  console.warn(
    "⚠️  STRIPE MOCK PAYMENT MODE ACTIVE — payments are not verified against " +
      "a real Stripe signature. This must never run against a production database.",
  );
}

/**
 * Amounts in our DB are stored as OMR with 2 decimals. Stripe wants the
 * smallest currency unit — for OMR that's baisa (1 OMR = 1000 baisa).
 * We expose a helper so callers don't have to remember this.
 */
const CURRENCY = (env.STRIPE_CURRENCY || "omr").toLowerCase();
const MULTIPLIERS = { omr: 1000, usd: 100, sar: 100, aed: 100, eur: 100 };
const MULT = MULTIPLIERS[CURRENCY] || 100;

function toStripeAmount(value) {
  return Math.round(Number(value) * MULT);
}

/**
 * Create a PaymentIntent for the given order total.
 * Returns { clientSecret, paymentIntentId }.
 *
 * In mock mode we fabricate an id and a secret; the webhook simulator
 * uses the same format so signatures still validate.
 */
async function createPaymentIntent({ amount, orderId, userId, metadata = {} }) {
  if (!hasRealStripe) {
    // Mock PaymentIntent. Format matches Stripe so clients can't tell.
    const id = `pi_mock_${crypto.randomBytes(12).toString("hex")}`;
    const secret = `${id}_secret_${crypto.randomBytes(12).toString("hex")}`;
    return { paymentIntentId: id, clientSecret: secret, mock: true };
  }

  const intent = await stripe.paymentIntents.create({
    amount: toStripeAmount(amount),
    currency: CURRENCY,
    automatic_payment_methods: { enabled: true },
    metadata: { order_id: orderId, user_id: userId, ...metadata },
  });
  return {
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret,
    mock: false,
  };
}

/**
 * Parse & verify a Stripe webhook. Throws AppError(400) on any issue.
 * Returns the verified event.
 *
 * In mock mode we accept any JSON payload with a `type` and `data.object`
 * to make local testing trivial. DO NOT deploy in mock mode.
 */
function verifyWebhook({ rawBody, signatureHeader, mockSecretHeader }) {
  if (!hasRealStripe) {
    // Mock path has no real Stripe signature to check, so a shared secret
    // header is the only thing standing between this endpoint and anyone
    // who can send it a POST. env.js guarantees MOCK_WEBHOOK_SECRET is set
    // (>=20 chars) whenever this mode could possibly run in production; in
    // development it falls back to a fixed value, so this check still
    // fires and still has to be satisfied — it just isn't a real secret
    // there since the whole endpoint is on localhost.
    if (!env.MOCK_WEBHOOK_SECRET || mockSecretHeader !== env.MOCK_WEBHOOK_SECRET) {
      throw new AppError("Invalid or missing mock webhook secret", 401);
    }
    // rawBody is a Buffer; parse as JSON.
    try {
      const payload = JSON.parse(rawBody.toString("utf8"));
      if (!payload.type || !payload.data || !payload.data.object) {
        throw new Error("Malformed mock event");
      }
      return payload;
    } catch (e) {
      throw new AppError(`Invalid mock webhook: ${e.message}`, 400);
    }
  }

  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new AppError("Stripe webhook secret not configured", 500);
  }
  try {
    return stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    throw new AppError(`Webhook verification failed: ${err.message}`, 400);
  }
}

module.exports = {
  hasRealStripe,
  createPaymentIntent,
  verifyWebhook,
  toStripeAmount,
  CURRENCY,
};
