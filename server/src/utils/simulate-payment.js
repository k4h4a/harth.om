/**
 * Dev-only helper to simulate a Stripe payment_intent.succeeded/failed
 * webhook when running in mock-payment mode (no STRIPE_SECRET_KEY set).
 *
 * This replaces the old pattern of the checkout page itself calling
 * /payments/webhook from the browser to "confirm" its own payment — that
 * was indistinguishable from an attacker forging a fake payment (see the
 * C-07/C-10 fixes). This script requires MOCK_WEBHOOK_SECRET, which a
 * browser never has access to, so it can only be run by someone with
 * access to the server's own environment.
 *
 * Usage (from server/):
 *   node src/utils/simulate-payment.js <payment_intent_id> [--fail]
 *   npm run simulate:payment -- <payment_intent_id> [--fail]
 *
 * <payment_intent_id> is the `payment.payment_intent_id` returned by
 * POST /orders or POST /rentals when payment_method is "card" and mock
 * mode is active (it looks like pi_mock_...).
 */

require("dotenv").config();
const env = require("../config/env");

async function main() {
  const [paymentIntentId, flag] = process.argv.slice(2);
  if (!paymentIntentId) {
    console.error("Usage: node src/utils/simulate-payment.js <payment_intent_id> [--fail]");
    process.exit(1);
  }
  if (!env.MOCK_WEBHOOK_SECRET) {
    console.error(
      "MOCK_WEBHOOK_SECRET is not set — nothing to authenticate this request with. " +
        "Set it in your .env (see .env.example).",
    );
    process.exit(1);
  }

  const type = flag === "--fail" ? "payment_intent.payment_failed" : "payment_intent.succeeded";
  const url =
    process.env.SIMULATE_PAYMENT_URL || `http://localhost:${env.PORT}/api/v1/payments/webhook`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mock-Webhook-Secret": env.MOCK_WEBHOOK_SECRET,
    },
    body: JSON.stringify({ type, data: { object: { id: paymentIntentId } } }),
  });

  const body = await res.json().catch(() => ({}));
  console.log(`${type} -> HTTP ${res.status}`, body);
  // exitCode (not exit()) lets fetch's keep-alive socket close on its own —
  // forcing an immediate exit here races with it and can crash the process
  // with a spurious libuv assertion, even though the request already succeeded.
  process.exitCode = res.ok ? 0 : 1;
}

main().catch((err) => {
  console.error("simulate-payment failed:", err.message);
  process.exitCode = 1;
});
