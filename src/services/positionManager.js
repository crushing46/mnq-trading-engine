class PositionManager {
  constructor({ config, tsApi, riskManager, tradeLogger }) {
    this.config = config;
    this.tsApi = tsApi;
    this.riskManager = riskManager;
    this.tradeLogger = tradeLogger;
    this.position = null;
    this.lastKnownPrice = null;
  }

  hasPosition() {
    return !!this.position;
  }

  getPosition() {
    return this.position;
  }

  clearPosition(reason = 'UNKNOWN') {
    if (this.position) {
      console.log(`📦 Clearing internal position | Reason=${reason}`);
    }

    this.position = null;
  }

  createPosition({ side, entryPrice, entryTime, qty }) {
    const fixedQty = Math.min(1, qty);
    const runnerQty = Math.max(qty - fixedQty, 0);

    this.position = {
      side,
      entryPrice,
      entryTime,
      qty,
      expectedQty: qty,
      legs: [
        {
          id: 'fixed',
          qty: fixedQty,
          takeProfit:
            side === 'LONG'
              ? entryPrice + this.config.tp
              : entryPrice - this.config.tp,
          stopLoss:
            side === 'LONG'
              ? entryPrice - this.config.sl
              : entryPrice + this.config.sl,
          active: fixedQty > 0
        },
        {
          id: 'runner',
          qty: runnerQty,
          takeProfit: null,
          stopLoss:
            side === 'LONG'
              ? entryPrice - this.config.sl
              : entryPrice + this.config.sl,
          trailing: false,
          active: runnerQty > 0
        }
      ],
      beAdjusted: false,
      maxFavorable: 0,
      maxAdverse: 0
    };

    console.log(
      `📌 POSITION CREATED | Side=${side} | Entry=${entryPrice} | FixedTP=${
        side === 'LONG' ? entryPrice + this.config.tp : entryPrice - this.config.tp
      } | SL=${
        side === 'LONG' ? entryPrice - this.config.sl : entryPrice + this.config.sl
      } | Qty=${qty}`
    );

    return this.position;
  }

  syncFromBrokerPosition(brokerPosition) {
    if (!brokerPosition) {
      this.clearPosition('BROKER_FLAT');
      return;
    }

    const qty = Number(brokerPosition.Quantity);
    const side = qty > 0 ? 'LONG' : 'SHORT';
    const absQty = Math.abs(qty);
    const entryPrice = Number(brokerPosition.AveragePrice);

    if (!Number.isFinite(entryPrice) || absQty <= 0) {
      this.clearPosition('INVALID_BROKER_POSITION');
      return;
    }

    if (!this.position || this.position.side !== side || this.position.qty !== absQty) {
      console.log(`🔄 Synced broker position: ${side} ${absQty} @ ${entryPrice}`);

      this.createPosition({
        side,
        entryPrice,
        entryTime: new Date(),
        qty: absQty
      });

      return;
    }

    if (Math.abs(entryPrice - this.position.entryPrice) > 0.01) {
      console.log(
        `🔄 Syncing entry price | Old=${this.position.entryPrice} New=${entryPrice}`
      );

      this.position.entryPrice = entryPrice;
      this.rebuildLevelsFromEntry(entryPrice);

      console.log(
        `📌 Updated levels | TP=${
          side === 'LONG'
            ? entryPrice + this.config.tp
            : entryPrice - this.config.tp
        } | SL=${
          side === 'LONG'
            ? entryPrice - this.config.sl
            : entryPrice + this.config.sl
        }`
      );
    }
  }

  rebuildLevelsFromEntry(entryPrice) {
    if (!this.position) return;

    for (const leg of this.position.legs) {
      if (this.position.side === 'LONG') {
        if (leg.id === 'fixed') {
          leg.takeProfit = entryPrice + this.config.tp;
        }

        leg.stopLoss = entryPrice - this.config.sl;
      } else {
        if (leg.id === 'fixed') {
          leg.takeProfit = entryPrice - this.config.tp;
        }

        leg.stopLoss = entryPrice + this.config.sl;
      }
    }
  }

  async flattenBrokerPosition(reason = 'FLATTEN', exitPriceOverride = null) {
    const brokerData = await this.tsApi.getOpenPositions(this.config.accountId);
    const positions = brokerData?.Positions || brokerData || [];

    const livePos = positions.find(
      (p) =>
        p.Symbol === this.config.symbol &&
        Number(p.Quantity) !== 0
    );

    const liveQty = livePos ? Number(livePos.Quantity) : 0;

    if (liveQty === 0) {
      this.clearPosition(`${reason}_BROKER_ALREADY_FLAT`);
      return false;
    }

    const flattenSide = liveQty > 0 ? 'SHORT' : 'LONG';

    if (this.config.enableTrading) {
      await this.tsApi.placeMarketOrder(
        this.config.accountId,
        this.config.symbol,
        Math.abs(liveQty),
        flattenSide
      );

      console.log(`🚨 Flatten order sent | Reason=${reason} | Qty=${Math.abs(liveQty)}`);
    }

    if (this.position) {
      const exitPrice = Number.isFinite(exitPriceOverride)
        ? exitPriceOverride
        : Number.isFinite(this.lastKnownPrice)
          ? this.lastKnownPrice
          : this.position.entryPrice;

      const result = this.tradeLogger.logTrade(
        this.position,
        { price: exitPrice, qty: Math.abs(liveQty) },
        reason
      );

      this.riskManager.recordTradePnL(result.dollarPnL);
    }

    this.clearPosition(reason);
    return true;
  }

  async enterTargetPosition({ side, entryPrice, entryTime }) {
    if (!this.riskManager.canTrade()) {
      console.log('🛑 Entry blocked — trading disabled');
      return;
    }

    const desiredQty = side === 'LONG' ? this.config.qty : -this.config.qty;

    const brokerData = await this.tsApi.getOpenPositions(this.config.accountId);
    const positions = brokerData?.Positions || brokerData || [];

    const currentPos = positions.find(
      (p) => p.Symbol === this.config.symbol
    );

    const currentQty = currentPos ? Number(currentPos.Quantity) : 0;
    const orderSize = desiredQty - currentQty;

    console.log(`🔍 TARGET ENTRY | DesiredQty=${desiredQty} | BrokerQty=${currentQty} | OrderSize=${orderSize}`);

    if (orderSize !== 0 && this.config.enableTrading) {
      await this.tsApi.placeMarketOrder(
        this.config.accountId,
        this.config.symbol,
        Math.abs(orderSize),
        orderSize > 0 ? 'LONG' : 'SHORT'
      );
    }

    this.lastKnownPrice = entryPrice;

    this.createPosition({
      side,
      entryPrice,
      entryTime,
      qty: this.config.qty
    });
  }

  async flipPosition({ newSide, price, time }) {
    this.lastKnownPrice = price;

    if (!this.position) {
      await this.enterTargetPosition({
        side: newSide,
        entryPrice: price,
        entryTime: time
      });
      return;
    }

    const oldPosition = {
      ...this.position,
      legs: this.position.legs.map((leg) => ({ ...leg }))
    };

    console.log(`🔁 FLIP SIGNAL | ${oldPosition.side} → ${newSide} (TARGET MODE)`);

    const result = this.tradeLogger.logTrade(
      oldPosition,
      { price, qty: oldPosition.qty },
      'FLIP_EXIT'
    );

    const stopped = this.riskManager.recordTradePnL(result.dollarPnL);

    if (stopped) {
      await this.flattenBrokerPosition('DAILY_LOSS_AFTER_FLIP', price);
      return;
    }

    const desiredQty = newSide === 'LONG' ? this.config.qty : -this.config.qty;

    const brokerData = await this.tsApi.getOpenPositions(this.config.accountId);
    const positions = brokerData?.Positions || brokerData || [];

    const currentPos = positions.find(
      (p) => p.Symbol === this.config.symbol
    );

    const currentQty = currentPos ? Number(currentPos.Quantity) : 0;
    const orderSize = desiredQty - currentQty;

    console.log(`🔍 FLIP ORDER | BrokerQty=${currentQty} | DesiredQty=${desiredQty} | OrderSize=${orderSize}`);

    if (orderSize !== 0 && this.config.enableTrading) {
      await this.tsApi.placeMarketOrder(
        this.config.accountId,
        this.config.symbol,
        Math.abs(orderSize),
        orderSize > 0 ? 'LONG' : 'SHORT'
      );
    }

    this.createPosition({
      side: newSide,
      entryPrice: price,
      entryTime: time,
      qty: this.config.qty
    });

    console.log(
      `📈 FLIP ENTRY EXECUTED | Side=${newSide} | Entry=${price} | TargetQty=${this.config.qty}`
    );
  }

  async checkExitsByPrice({ price, time, source = 'PRICE' }) {
    if (!this.position) return;

    this.lastKnownPrice = price;

    if (time && this.position.entryTime && time <= this.position.entryTime) return;

    const move =
      this.position.side === 'LONG'
        ? price - this.position.entryPrice
        : this.position.entryPrice - price;

    this.position.maxFavorable = Math.max(this.position.maxFavorable, move);
    this.position.maxAdverse = Math.min(this.position.maxAdverse, move);

    if (!this.position.beAdjusted && move >= 25) {
      for (const leg of this.position.legs) {
        leg.stopLoss =
          this.position.side === 'LONG'
            ? this.position.entryPrice + 2
            : this.position.entryPrice - 2;
      }

      this.position.beAdjusted = true;
      console.log(`🔒 MOVE SL TO BE+2`);
    }

    for (const leg of this.position.legs) {
      if (!leg.active) continue;

      const hitTP =
        leg.takeProfit &&
        (
          (this.position.side === 'LONG' && price >= leg.takeProfit) ||
          (this.position.side === 'SHORT' && price <= leg.takeProfit)
        );

      const hitSL =
        (this.position.side === 'LONG' && price <= leg.stopLoss) ||
        (this.position.side === 'SHORT' && price >= leg.stopLoss);

      if (hitTP) {
        await this.exitLeg({
          leg,
          exitPrice: leg.takeProfit,
          reason: `${leg.id}_TP_${source}`
        });

        continue;
      }

      if (hitSL) {
        await this.exitLeg({
          leg,
          exitPrice: leg.stopLoss,
          reason: `${leg.id}_SL_${source}`
        });

        continue;
      }

      if (leg.id === 'runner' && leg.trailing && leg.active) {
        const newStop =
          this.position.side === 'LONG'
            ? price - this.config.trailDistance
            : price + this.config.trailDistance;

        if (
          (this.position.side === 'LONG' && newStop > leg.stopLoss) ||
          (this.position.side === 'SHORT' && newStop < leg.stopLoss)
        ) {
          leg.stopLoss = newStop;
          console.log(`📈 RUNNER TRAIL UPDATE | Source=${source} | NewSL=${newStop}`);
        }
      }
    }

    this.clearIfAllLegsClosed();
  }

  async checkExitsByBar(closedBar) {
    if (!this.position) return;

    this.lastKnownPrice = closedBar.close;

    for (const leg of this.position.legs) {
      if (!leg.active) continue;

      const hitTP =
        leg.takeProfit &&
        (
          (this.position.side === 'LONG' && closedBar.high >= leg.takeProfit) ||
          (this.position.side === 'SHORT' && closedBar.low <= leg.takeProfit)
        );

      const hitSL =
        (this.position.side === 'LONG' && closedBar.low <= leg.stopLoss) ||
        (this.position.side === 'SHORT' && closedBar.high >= leg.stopLoss);

      if (hitTP) {
        await this.exitLeg({
          leg,
          exitPrice: leg.takeProfit,
          reason: `${leg.id}_TP_BAR`
        });

        continue;
      }

      if (hitSL) {
        await this.exitLeg({
          leg,
          exitPrice: leg.stopLoss,
          reason: `${leg.id}_SL_BAR`
        });

        continue;
      }

      if (leg.id === 'runner' && leg.trailing && leg.active) {
        const newStop =
          this.position.side === 'LONG'
            ? closedBar.close - this.config.trailDistance
            : closedBar.close + this.config.trailDistance;

        if (
          (this.position.side === 'LONG' && newStop > leg.stopLoss) ||
          (this.position.side === 'SHORT' && newStop < leg.stopLoss)
        ) {
          leg.stopLoss = newStop;
          console.log(`📈 RUNNER TRAIL UPDATE | Source=BAR | NewSL=${newStop}`);
        }
      }
    }

    this.clearIfAllLegsClosed();
  }

  async exitLeg({ leg, exitPrice, reason }) {
    if (!this.position || !leg.active) return;

    // Mark inactive immediately to prevent duplicate exits from tick/bar overlap.
    leg.active = false;
    this.lastKnownPrice = exitPrice;

    console.log(`🚪 EXIT LEG | ${reason} | Qty=${leg.qty} | Price=${exitPrice}`);

    if (this.config.enableTrading) {
      await this.tsApi.placeMarketOrder(
        this.config.accountId,
        this.config.symbol,
        leg.qty,
        this.position.side === 'LONG' ? 'SHORT' : 'LONG'
      );
    }

    const result = this.tradeLogger.logTrade(
      this.position,
      { price: exitPrice, qty: leg.qty },
      reason
    );

    this.riskManager.recordTradePnL(result.dollarPnL);

    if (leg.id === 'fixed' && reason.includes('_TP_')) {
      const runner = this.position.legs.find((l) => l.id === 'runner');

      if (runner && runner.active && this.config.trailRunner) {
        runner.trailing = true;
        console.log('🏃 Runner trailing activated after fixed TP');
      }
    }

    if (!this.riskManager.canTrade()) {
      await this.flattenBrokerPosition(`RISK_STOP_AFTER_${reason}`, exitPrice);
    }
  }

  clearIfAllLegsClosed() {
    if (!this.position) return;

    const stillActive = this.position.legs.some((leg) => leg.active);

    if (!stillActive) {
      this.clearPosition('ALL_LEGS_CLOSED');
    }
  }
}

module.exports = PositionManager;