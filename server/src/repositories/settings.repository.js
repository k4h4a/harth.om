const knex = require("../db");
const { AppError } = require("../middleware/errorHandler");

/**
 * Singleton platform settings (today: just the commission percentage).
 * Row id is always 1, enforced by a DB check constraint.
 */

async function getCommissionPercentage() {
  const row = await knex("commission_settings").where({ id: 1 }).first("percentage");
  if (!row) throw new AppError("Commission settings not configured", 500);
  return Number(row.percentage);
}

async function getCommissionSettings() {
  const row = await knex("commission_settings as cs")
    .leftJoin("users as u", "u.id", "cs.updated_by")
    .where("cs.id", 1)
    .first("cs.percentage", "cs.updated_at", "cs.updated_by", "u.name as updated_by_name");
  if (!row) throw new AppError("Commission settings not configured", 500);
  return {
    percentage: Number(row.percentage),
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    updated_by_name: row.updated_by_name,
  };
}

async function setCommissionPercentage(percentage, adminId) {
  const [row] = await knex("commission_settings")
    .where({ id: 1 })
    .update({
      percentage,
      updated_by: adminId,
      updated_at: knex.fn.now(),
    })
    .returning(["percentage", "updated_at", "updated_by"]);
  if (!row) throw new AppError("Commission settings not configured", 500);
  return row;
}

module.exports = {
  getCommissionPercentage,
  getCommissionSettings,
  setCommissionPercentage,
};
