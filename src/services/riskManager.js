class RiskManager {
  constructor({ maxDailyLoss }) {
    this.maxDailyLoss = Number(maxDailyLoss || 0);
    this.dailyPnL = 0;
    this.brokerUnrealizedPnL = 0;
    this.consecutiveLosses = 0;
    this.tradingDisabled = false;
    this.currentTradeDate = null;
  }

  resetIfNewDay(date) {
    const tradeDate = date.toISOString().split('T')[0];

    if (this.currentTradeDate !== tradeDate) {
      this.currentTradeDate = tradeDate;
      this.dailyPnL = 0;
      this.brokerUnrealizedPnL = 0;
      this.consecutiveLosses = 0;
      this.tradingDisabled = false;

      console.log(`📅 New Trading Day: ${tradeDate} | Reset Daily PnL`);
      console.log('🔄 Daily PnL reset | Trading re-enabled | Consecutive losses reset');
    }
  }

  recordTradePnL(dollarPnL) {
    this.dailyPnL += dollarPnL;

    if (dollarPnL < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0;
    }

    if (this.consecutiveLosses >= 3) {
      this.tradingDisabled = true;
      console.log('🛑 3 CONSECUTIVE LOSSES — TRADING DISABLED');
    }

    if (this.maxDailyLoss > 0 && this.dailyPnL <= -this.maxDailyLoss) {
      this.tradingDisabled = true;
      console.log(
        `🚨 LOCAL DAILY LOSS LIMIT HIT | DailyPnL=$${this.dailyPnL.toFixed(2)} | Limit=$${this.maxDailyLoss}`
      );
    }

    return this.tradingDisabled;
  }

  updateBrokerPnL({ dailyPnL, unrealizedPnL }) {
    const brokerRealizedPnL = Number.isFinite(dailyPnL) ? dailyPnL : 0;
    const brokerOpenPnL = Number.isFinite(unrealizedPnL) ? unrealizedPnL : 0;

    // Keep local dailyPnL as the bot's source of truth for realized exits.
    // Broker values are used only as an additional safety check so stale/zero
    // broker fields cannot accidentally reset local loss tracking.
    this.brokerUnrealizedPnL = brokerOpenPnL;

    const localExposure = this.dailyPnL + this.brokerUnrealizedPnL;
    const brokerExposure = brokerRealizedPnL + brokerOpenPnL;
    const worstExposure = Math.min(localExposure, brokerExposure);

    if (this.maxDailyLoss > 0 && worstExposure <= -this.maxDailyLoss) {
      this.tradingDisabled = true;
      console.log(
        `🚨 DAILY LOSS BREACH | LocalExposure=$${localExposure.toFixed(2)} | BrokerExposure=$${brokerExposure.toFixed(2)} | Limit=$${this.maxDailyLoss}`
      );
    }

    return this.tradingDisabled;
  }

  canTrade() {
    return !this.tradingDisabled;
  }

  disable(reason = 'UNKNOWN') {
    this.tradingDisabled = true;
    console.log(`🛑 Trading disabled | Reason=${reason}`);
  }

  getState() {
    return {
      dailyPnL: this.dailyPnL,
      brokerUnrealizedPnL: this.brokerUnrealizedPnL,
      consecutiveLosses: this.consecutiveLosses,
      tradingDisabled: this.tradingDisabled,
      currentTradeDate: this.currentTradeDate
    };
  }
}

module.exports = RiskManager;