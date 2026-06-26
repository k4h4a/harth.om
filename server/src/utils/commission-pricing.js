/**
 * Pure math for marking up a farmer's price by the platform commission.
 * No DB, no I/O — easy to unit test.
 */

function money(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Given the farmer's typed price(s) and the commission percentage to apply,
 * compute the commission amount and the final (buyer-facing) price for each.
 * Null-safe: a null farmer price yields null commission/final values.
 */
function computeEquipmentPricing({ farmerDailyPrice, farmerSalePrice, percentage }) {
  const pct = Number(percentage);

  const forPrice = (farmerPrice) => {
    if (farmerPrice == null) {
      // commission_amount columns are NOT NULL (default 0); only the farmer
      // price and final price are nullable (a listing might be rent-only or
      // sale-only).
      return { farmer: null, commission: 0, final: null };
    }
    const farmer = money(farmerPrice);
    const commission = money((farmer * pct) / 100);
    const final = money(farmer + commission);
    return { farmer, commission, final };
  };

  const daily = forPrice(farmerDailyPrice);
  const sale = forPrice(farmerSalePrice);

  return {
    farmer_daily_price: daily.farmer,
    farmer_sale_price: sale.farmer,
    commission_percentage: pct,
    daily_commission_amount: daily.commission,
    sale_commission_amount: sale.commission,
    daily_price: daily.final,
    sale_price: sale.final,
  };
}

module.exports = { money, computeEquipmentPricing };
