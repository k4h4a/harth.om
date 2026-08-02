const knex = require("../db");
const invoiceService = require("../services/invoice.service");
const { AppError, asyncHandler } = require("../middleware/errorHandler");

/**
 * GET /orders/:id/invoice.pdf
 *
 * Streams a PDF invoice. Visible to the order's buyer or an admin.
 * Returns 503 if pdfkit/qrcode aren't installed (operators can npm-install
 * to unblock without a code change).
 */
const orderInvoice = asyncHandler(async (req, res) => {
  if (!invoiceService.isAvailable) {
    throw new AppError(
      "Invoice generation not available — install pdfkit and qrcode",
      503,
    );
  }

  const order = await knex("orders").where({ id: req.params.id }).first();
  if (!order) throw new AppError("Order not found", 404);

  // Authorization: buyer or admin.
  if (order.user_id !== req.user.id && !req.user.is_admin) {
    throw new AppError("Not permitted", 403);
  }

  const [items, user] = await Promise.all([
    knex("order_items")
      .where({ order_id: order.id })
      .orderBy("created_at", "asc"),
    knex("users").where({ id: order.user_id }).first("name", "email"),
  ]);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="invoice-${order.tracking_number}.pdf"`,
  );

  // invoiceService pipes directly to the response. Once we start streaming
  // we can't change status codes, so any error mid-stream just aborts.
  await invoiceService.streamInvoice({
    order,
    items,
    user: user || { name: "", email: "" },
    stream: res,
  });
});

module.exports = { orderInvoice };
