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
    this.localDailyPnL = 0;
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
      this.localDailyPnL = 0;
      this.brokerDailyPnL = 0;
      this.brokerRealizedPnL = 0;
      this.brokerUnrealizedPnL = 0;
      this.consecutiveLosses = 0;
      this.tradingDisabled = false;

      console.log(`📅 New Trading Day: ${tradeDate} | Reset Daily PnL`);
      console.log('🔄 Daily PnL reset | Trading re-enabled | Consecutive losses reset');
    }
  }

  recordTradePnL(brokerPnL) {
    const normalizedBrokerPnL = Number.isFinite(brokerPnL)
      ? Number(brokerPnL)
      : 0;

    // Preserve local historical compatibility while
    // transitioning to broker-authoritative accounting.
    this.localDailyPnL = this.dailyPnL;

    // Broker PnL is now authoritative.
    this.dailyPnL = normalizedBrokerPnL;
    this.brokerDailyPnL = normalizedBrokerPnL;

    const pnlDelta = this.dailyPnL - this.localDailyPnL;

    console.log(
      `💰 BROKER PnL UPDATE | BrokerDaily=$${this.dailyPnL.toFixed(2)} | Delta=$${pnlDelta.toFixed(2)}`
    );

    if (pnlDelta < 0) {
      this.consecutiveLosses += 1;
    } else if (pnlDelta > 0) {
      this.consecutiveLosses = 0;
    }

    if (
      this.enableConsecutiveLossLimit &&
      this.maxConsecutiveLosses > 0 &&
      this.consecutiveLosses >= this.maxConsecutiveLosses
    ) {
      this.tradingDisabled = true;

      console.log(
        `🛑 ${this.maxConsecutiveLosses} CONSECUTIVE LOSSES — TRADING DISABLED`
      );
    }

    if (
      this.enableDailyLossLimit &&
      this.maxDailyLoss > 0 &&
      this.dailyPnL <= -this.maxDailyLoss
    ) {
      this.tradingDisabled = true;

      console.log(
        `🚨 BROKER DAILY LOSS LIMIT HIT | BrokerDailyPnL=$${this.dailyPnL.toFixed(2)} | Limit=$${this.maxDailyLoss}`
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

    // Broker is now authoritative for financial exposure.
    this.dailyPnL = brokerDailyPnL;

    const brokerExposure = brokerDailyPnL + brokerOpenPnL;

    if (
      this.enableDailyLossLimit &&
      this.maxDailyLoss > 0 &&
      brokerExposure <= -this.maxDailyLoss
    ) {
      this.tradingDisabled = true;
      console.log(
        `🚨 BROKER DAILY LOSS BREACH | BrokerExposure=$${brokerExposure.toFixed(2)} | Limit=$${this.maxDailyLoss}`
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
      localDailyPnL: this.localDailyPnL,
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