// Rentals had a payment_method column (card | cash_on_delivery) but never
// gained a Stripe PaymentIntent link or a paid_at timestamp — mirroring
// what orders already have — so payment_status could never actually
// transition away from 'pending' for a card rental. See rental.repository.js
// markPaid()/markFailed()/setPaymentIntent()/findByPaymentIntent().

exports.up = async function (knex) {
  await knex.schema.alterTable("rentals", (t) => {
    t.string("payment_intent_id", 128);
    t.timestamp("paid_at", { useTz: true });
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable("rentals", (t) => {
    t.dropColumn("payment_intent_id");
    t.dropColumn("paid_at");
  });
};
