class RiskManager {
  constructor({
    maxDailyLoss,
    enableDailyLossLimit = true,
    enableConsecutiveLossLimit = true,
    maxConsecutiveLosses = 5
  }) {
    this.maxDailyLoss = Number(maxDailyLoss || 0);
    this.enableDailyLossLimit = enableDailyLossLimit !== false;
    this.enableConsecutiveLossLimit = enableConsecutiveLossLimit !== false;
    this.maxConsecutiveLosses = Number(maxConsecutiveLosses || 5);

    this.dailyPnL = 0;
    this.brokerDailyPnL = 0;
    this.brokerRealizedPnL = 0;
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
      this.brokerDailyPnL = 0;
      this.brokerRealizedPnL = 0;
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

    if (
      this.enableConsecutiveLossLimit &&
      this.maxConsecutiveLosses > 0 &&
      this.consecutiveLosses >= this.maxConsecutiveLosses
    ) {
      this.tradingDisabled = true;
      console.log(`🛑 ${this.maxConsecutiveLosses} CONSECUTIVE LOSSES — TRADING DISABLED`);
    }

    if (
      this.enableDailyLossLimit &&
      this.maxDailyLoss > 0 &&
      this.dailyPnL <= -this.maxDailyLoss
    ) {
      this.tradingDisabled = true;
      console.log(
        `🚨 LOCAL DAILY LOSS LIMIT HIT | DailyPnL=$${this.dailyPnL.toFixed(2)} | Limit=$${this.maxDailyLoss}`
      );
    }

    return this.tradingDisabled;
  }

  updateBrokerPnL({ dailyPnL, realizedPnL, unrealizedPnL }) {
    const brokerDailyPnL = Number.isFinite(dailyPnL) ? dailyPnL : 0;
    const brokerRealizedPnL = Number.isFinite(realizedPnL) ? realizedPnL : 0;
    const brokerOpenPnL = Number.isFinite(unrealizedPnL) ? unrealizedPnL : 0;

    this.brokerDailyPnL = brokerDailyPnL;
    this.brokerRealizedPnL = brokerRealizedPnL;
    this.brokerUnrealizedPnL = brokerOpenPnL;

    // Keep local dailyPnL as the bot's source of truth for strategy/session exits.
    // Broker values are used as additional visibility and safety checks.
    const localExposure = this.dailyPnL + this.brokerUnrealizedPnL;
    const brokerExposure = brokerDailyPnL + brokerOpenPnL;
    const worstExposure = Math.min(localExposure, brokerExposure);

    if (
      this.enableDailyLossLimit &&
      this.maxDailyLoss > 0 &&
      worstExposure <= -this.maxDailyLoss
    ) {
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

  enable(reason = 'UNKNOWN') {
    this.tradingDisabled = false;
    console.log(`✅ Trading enabled | Reason=${reason}`);
  }

  setRiskLimitsEnabled({ dailyLossLimit, consecutiveLossLimit }) {
    if (typeof dailyLossLimit === 'boolean') {
      this.enableDailyLossLimit = dailyLossLimit;
    }

    if (typeof consecutiveLossLimit === 'boolean') {
      this.enableConsecutiveLossLimit = consecutiveLossLimit;
    }

    console.log(
      `🧯 Risk limits updated | DailyLoss=${this.enableDailyLossLimit ? 'ON' : 'OFF'} | ConsecutiveLoss=${this.enableConsecutiveLossLimit ? 'ON' : 'OFF'}`
    );

    return this.getState();
  }

  getState() {
    return {
      dailyPnL: this.dailyPnL,
      brokerDailyPnL: this.brokerDailyPnL,
      brokerRealizedPnL: this.brokerRealizedPnL,
      brokerUnrealizedPnL: this.brokerUnrealizedPnL,
      consecutiveLosses: this.consecutiveLosses,
      maxDailyLoss: this.maxDailyLoss,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      enableDailyLossLimit: this.enableDailyLossLimit,
      enableConsecutiveLossLimit: this.enableConsecutiveLossLimit,
      tradingDisabled: this.tradingDisabled,
      currentTradeDate: this.currentTradeDate
    };
  }
}

module.exports = RiskManager;