/**
 * EMA Crossover Strategy with Trend Filter
 * PURE STRATEGY:
 * - Generates ENTRY signals
 * - Evaluates TP / SL using bar high/low
 * - NO order placement
 * - NO position ownership
 */

class TradingStrategy {
  constructor(config = {}) {
    this.emaFastPeriod = config.emaFast;
    this.emaSlowPeriod = config.emaSlow;
    this.emaTrendPeriod = config.emaTrend;

    this.tpPoints = config.tpPoints;
    this.slPoints = config.slPoints;

    if (
      !Number.isFinite(this.emaFastPeriod) ||
      !Number.isFinite(this.emaSlowPeriod) ||
      !Number.isFinite(this.emaTrendPeriod) ||
      !Number.isFinite(this.tpPoints) ||
      !Number.isFinite(this.slPoints)
    ) {
      throw new Error('TradingStrategy requires EMA lengths and TP/SL values');
    }

    this.emaFast = null;
    this.emaSlow = null;
    this.emaTrend = null;
    this.prevEmaFast = null;
    this.prevEmaSlow = null;

    this.pendingSignal = null;
    this.maxConfirmationBars = config.maxConfirmationBars ?? 5;

    this.bars = [];
    this.maxBars = 1000;
  }

  // =========================
  // BAR HANDLING
  // =========================
  addBar(bar) {
    this.bars.push(bar);
    if (this.bars.length > this.maxBars) this.bars.shift();
    this.calculateIndicators();
  }

  // =========================
  // EMA CALCULATION
  // =========================
  calculateEMA(period) {
    if (this.bars.length < period) return null;

    const closes = this.bars.map(b => b.close);
    const multiplier = 2 / (period + 1);

    let ema =
      closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  calculateIndicators() {
    if (this.bars.length < this.emaTrendPeriod) return;

    this.emaFast = this.calculateEMA(this.emaFastPeriod);
    this.emaSlow = this.calculateEMA(this.emaSlowPeriod);
    this.emaTrend = this.calculateEMA(this.emaTrendPeriod);

    if (this.bars.length >= 2) {
      const prevBars = this.bars.slice(0, -1);
      const prevCloses = prevBars.map(b => b.close);

      const calcPrevEMA = (period) => {
        const mult = 2 / (period + 1);
        let ema =
          prevCloses.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < prevCloses.length; i++) {
          ema = (prevCloses[i] - ema) * mult + ema;
        }
        return ema;
      };

      this.prevEmaFast = calcPrevEMA(this.emaFastPeriod);
      this.prevEmaSlow = calcPrevEMA(this.emaSlowPeriod);
    }
  }

  // =========================
  // ENTRY SIGNAL
  // =========================
  checkEntrySignal() {
    if (
      !this.emaFast ||
      !this.emaSlow ||
      !this.emaTrend ||
      !this.prevEmaFast ||
      !this.prevEmaSlow
    ) return null;

    const bar = this.bars[this.bars.length - 1];
    const close = bar.close;
    const barIndex = this.bars.length - 1;

    const bullishCross =
      this.emaFast > this.emaSlow &&
      this.prevEmaFast <= this.prevEmaSlow;

    const bearishCross =
      this.emaFast < this.emaSlow &&
      this.prevEmaFast >= this.prevEmaSlow;

    if (bullishCross) {
      this.pendingSignal = { type: 'LONG', startBar: barIndex };
    }

    if (bearishCross) {
      this.pendingSignal = { type: 'SHORT', startBar: barIndex };
    }

    if (!this.pendingSignal) return null;

    const barsSince = barIndex - this.pendingSignal.startBar;
    if (barsSince > this.maxConfirmationBars) {
      this.pendingSignal = null;
      return null;
    }

    const aboveTrend = close > this.emaTrend;
    const belowTrend = close < this.emaTrend;

    if (this.pendingSignal.type === 'LONG' && aboveTrend) {
      this.pendingSignal = null;
      return {
        type: 'LONG',
        time: bar.time,
        entryPrice: close,
        stopLoss: close - this.slPoints,
        takeProfit: close + this.tpPoints,
        emaFast: this.emaFast,
        emaSlow: this.emaSlow,
        emaTrend: this.emaTrend
      };
    }

    if (this.pendingSignal.type === 'SHORT' && belowTrend) {
      this.pendingSignal = null;
      return {
        type: 'SHORT',
        time: bar.time,
        entryPrice: close,
        stopLoss: close + this.slPoints,
        takeProfit: close - this.tpPoints,
        emaFast: this.emaFast,
        emaSlow: this.emaSlow,
        emaTrend: this.emaTrend
      };
    }

    return null;
  }

  // =========================
  // EXIT SIGNAL (HIGH / LOW BASED)
  // =========================
  checkExitSignal(currentPrice, position) {
    if (!position) return null;

    if (position.side === 'LONG') {
      if (currentPrice <= position.stopLoss) {
        return { reason: 'SL', price: currentPrice };
      }
      if (currentPrice >= position.takeProfit) {
        return { reason: 'TP', price: currentPrice };
      }
    }

    if (position.side === 'SHORT') {
      if (currentPrice >= position.stopLoss) {
        return { reason: 'SL', price: currentPrice };
      }
      if (currentPrice <= position.takeProfit) {
        return { reason: 'TP', price: currentPrice };
      }
    }

    return null;
  }

  // =========================
  // STATE
  // =========================
  getState() {
    return {
      indicators: {
        emaFast: this.emaFast,
        emaSlow: this.emaSlow,
        emaTrend: this.emaTrend
      },
      bars: this.bars.length
    };
  }

  reset() {
    this.bars = [];
    this.emaFast = null;
    this.emaSlow = null;
    this.emaTrend = null;
    this.prevEmaFast = null;
    this.prevEmaSlow = null;
    this.pendingSignal = null;
  }
}

module.exports = TradingStrategy;