const knex = require("../db");
const notificationRepo = require("../repositories/notification.repository");
const emailService = require("./email.service");
const whatsappService = require("./whatsapp.service");
const realtime = require("./realtime.service");

/**
 * Orchestrates multi-channel notifications.
 *
 * For each notification "event" we:
 *   1. Always insert an in_app row + emit realtime event for instant UI.
 *   2. Optionally dispatch email (fire-and-forget, logged to DB).
 *   3. Optionally dispatch whatsapp (fire-and-forget, logged to DB).
 *
 * The caller awaits only the in_app step. External provider calls are
 * deliberately NOT awaited so slow SMTP doesn't hold up an HTTP request.
 *
 * Returns the in_app notification row.
 */
async function notify({
  userId,
  type,
  title,
  message,
  metadata = {},
  email = false,
  whatsapp = false,
}) {
  // 1. In-app (synchronous)
  const inAppRow = await notificationRepo.create({
    userId,
    type,
    channel: "in_app",
    title,
    message,
    metadata,
    sent: true, // in_app is "sent" the moment it's in the DB
    sentAt: new Date(),
  });

  // Fire realtime push to the recipient's socket(s), if any.
  realtime.emitToUser(userId, "notification:new", inAppRow);
  realtime.emitToUser(userId, "notification:unread_count", {
    unread_count: await notificationRepo.unreadCount(userId),
  });

  // 2. Load user contact info (phone/email) only if we're going to use them.
  let userContact = null;
  if (email || whatsapp) {
    userContact = await knex("users")
      .where({ id: userId })
      .first("email", "phone");
  }

  // 3. Email (async, non-blocking)
  if (email && userContact?.email) {
    dispatchEmail({ userId, type, title, message, metadata, to: userContact.email }).catch(
      (e) => {
        // eslint-disable-next-line no-console
        console.error("[notify] email dispatch failed:", e.message);
      },
    );
  }

  // 4. WhatsApp (async, non-blocking)
  if (whatsapp && userContact?.phone) {
    dispatchWhatsapp({ userId, type, title, message, metadata, to: userContact.phone }).catch(
      (e) => {
        // eslint-disable-next-line no-console
        console.error("[notify] whatsapp dispatch failed:", e.message);
      },
    );
  }

  return inAppRow;
}

async function dispatchEmail({ userId, type, title, message, metadata, to }) {
  // Log intent first so we have a row even if the provider errors
  const logRow = await notificationRepo.create({
    userId,
    type,
    channel: "email",
    title,
    message,
    metadata,
  });

  const result = await emailService.send({
    to,
    subject: title,
    text: message,
    html: `<p>${escapeHtml(message)}</p>`,
  });

  await notificationRepo.markSendResult(logRow.id, {
    sent: result.sent,
    sentAt: result.sent ? new Date() : null,
    sendError: result.sent
      ? null
      : result.reason === "not_configured"
        ? "SMTP not configured"
        : (result.error || result.reason),
  });
}

async function dispatchWhatsapp({ userId, type, title, message, metadata, to }) {
  const logRow = await notificationRepo.create({
    userId,
    type,
    channel: "whatsapp",
    title,
    message,
    metadata,
  });

  const result = await whatsappService.sendWhatsApp({ to, body: `${title}\n\n${message}` });

  await notificationRepo.markSendResult(logRow.id, {
    sent: result.sent,
    sentAt: result.sent ? new Date() : null,
    sendError: result.sent
      ? null
      : result.reason === "not_configured"
        ? "Twilio not configured"
        : (result.error || result.reason),
  });
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// ─────────────────────────────────────────────────────────────────────────
// Event-specific helpers. Each one fires a notification for a business event
// with sensible default channels (email for high-signal events, whatsapp
// only for urgent ones, in_app always).
// ─────────────────────────────────────────────────────────────────────────

const events = {
  registered(userId, name) {
    return notify({
      userId,
      type: "system",
      title: "مرحباً بك في حرث",
      message: `أهلاً ${name}! حسابك جاهز للاستخدام.`,
      email: true,
    });
  },

  orderCreated(userId, order) {
    return notify({
      userId,
      type: "order",
      title: "تم استلام طلبك",
      message: `طلبك رقم ${order.tracking_number} بقيمة ${order.total} ر.ع قيد المعالجة.`,
      metadata: { order_id: order.id, tracking_number: order.tracking_number },
      email: true,
      whatsapp: true,
    });
  },

  orderPaid(userId, order) {
    return notify({
      userId,
      type: "payment",
      title: "تم استلام الدفع",
      message: `تم تأكيد دفع طلبك ${order.tracking_number}.`,
      metadata: { order_id: order.id, tracking_number: order.tracking_number },
      email: true,
      whatsapp: true,
    });
  },

  /**
   * Fan out when a new delivery_request lands on the open job board. This
   * is what makes the "available" tab update without needing a refresh —
   * the in-app notification pushes via Socket.IO and the page can reload
   * its list when it sees the event.
   *
   * There's no more "delivery" role — any authenticated user can accept a
   * job, so we can't filter by role. Notifying every active user would be
   * spam, so instead we notify users who've previously accepted a delivery
   * (an activity-based proxy for "interested in courier work").
   *
   * Returns silently if there are zero such users (which would be a bigger
   * problem worth logging, but not one notify() should crash on).
   */
  async newDeliveryAvailable(delivery, orderTrackingNumber) {
    const knex = require("../db");
    const couriers = await knex("users")
      .whereIn("id", function () {
        this.select("courier_id")
          .from("delivery_requests")
          .whereNotNull("courier_id");
      })
      .where({ is_active: true })
      .select("id");
    if (!couriers.length) return;

    const title = "طلب توصيل جديد";
    const message = orderTrackingNumber
      ? `طلب جديد متاح للتوصيل (${orderTrackingNumber}).`
      : `طلب جديد متاح للتوصيل.`;

    await Promise.all(
      couriers.map((c) =>
        notify({
          userId: c.id,
          type: "delivery",
          title,
          message,
          metadata: {
            delivery_id: delivery.id,
            order_id: delivery.order_id,
            tracking_number: orderTrackingNumber,
          },
        }),
      ),
    );
  },

  orderFailed(userId, order) {
    return notify({
      userId,
      type: "payment",
      title: "فشل الدفع",
      message: `لم يتم تأكيد دفع طلبك ${order.tracking_number}. يرجى المحاولة مرة أخرى.`,
      metadata: { order_id: order.id },
      email: true,
    });
  },

  rentalRequested(ownerId, rental, renterName) {
    return notify({
      userId: ownerId,
      type: "rental",
      title: "طلب إيجار جديد",
      message: `${renterName} يريد استئجار معدتك من ${rental.start_date} إلى ${rental.end_date}.`,
      metadata: { rental_id: rental.id },
      email: true,
    });
  },

  rentalApproved(renterId, rental) {
    return notify({
      userId: renterId,
      type: "rental",
      title: "تمت الموافقة على طلب الإيجار",
      message: `المالك وافق على إيجارك من ${rental.start_date} إلى ${rental.end_date}.`,
      metadata: { rental_id: rental.id },
      email: true,
      whatsapp: true,
    });
  },

  rentalRejected(renterId, rental, note) {
    return notify({
      userId: renterId,
      type: "rental",
      title: "رُفض طلب الإيجار",
      message: note
        ? `تم رفض طلب إيجارك. السبب: ${note}`
        : `تم رفض طلب إيجارك.`,
      metadata: { rental_id: rental.id },
      email: true,
    });
  },

  deliveryAssigned(customerId, delivery) {
    return notify({
      userId: customerId,
      type: "delivery",
      title: "تم تعيين مندوب توصيل",
      message: "مندوب قبل طلبك وسيتواصل معك قريباً.",
      metadata: { delivery_id: delivery.id },
    });
  },

  deliveryDelivered(customerId, delivery) {
    return notify({
      userId: customerId,
      type: "delivery",
      title: "تم التوصيل",
      message: "وصل طلبك بنجاح.",
      metadata: { delivery_id: delivery.id },
      email: true,
    });
  },

  newMessage(recipientId, senderId, senderName, preview) {
    return notify({
      userId: recipientId,
      type: "message",
      title: `رسالة جديدة من ${senderName}`,
      message: preview,
      metadata: { sender_id: senderId },
    });
  },
};

module.exports = { notify, events };
