const fs = require('fs');

class TradeLogger {
  constructor({ journalPath, sessionLogPath, pointValue }) {
    this.journalPath = journalPath;
    this.sessionLogPath = sessionLogPath;
    this.pointValue = Number(pointValue || 2);
  }

  logTrade(entry, exit, reason) {
    const estimatedPnLPoints =
      entry.side === 'LONG'
        ? exit.price - entry.entryPrice
        : entry.entryPrice - exit.price;

    const tradeQty = exit.qty || entry.qty || 1;

    // Local math retained only for diagnostics/backtesting visibility.
    const estimatedDollarPnL =
      estimatedPnLPoints * tradeQty * this.pointValue;

    const brokerSnapshot = exit.brokerSnapshot || {};

    const brokerRealizedPnL =
      brokerSnapshot.realizedPnL != null
        ? Number(brokerSnapshot.realizedPnL)
        : null;

    const brokerTodaysPnL =
      brokerSnapshot.todaysPnL != null
        ? Number(brokerSnapshot.todaysPnL)
        : null;

    const brokerUnrealizedPnL =
      brokerSnapshot.unrealizedPnL != null
        ? Number(brokerSnapshot.unrealizedPnL)
        : null;

    const brokerQty =
      brokerSnapshot.qty != null
        ? Number(brokerSnapshot.qty)
        : null;

    const brokerAvgPrice =
      brokerSnapshot.avgPrice != null
        ? Number(brokerSnapshot.avgPrice)
        : null;

    const row = [
      new Date().toISOString(),
      entry.side,
      entry.entryPrice,
      exit.price,
      reason,
      tradeQty,
      estimatedPnLPoints,
      estimatedDollarPnL,
      brokerRealizedPnL,
      brokerTodaysPnL,
      brokerUnrealizedPnL,
      brokerQty,
      brokerAvgPrice
    ].join(',') + '\n';

    if (!fs.existsSync(this.journalPath)) {
      fs.writeFileSync(
        this.journalPath,
        'timestamp,side,entry,exit,reason,qty,estimatedPnLPoints,estimatedPnLDollars,brokerRealizedPnL,brokerTodaysPnL,brokerUnrealizedPnL,brokerQty,brokerAvgPrice\n'
      );
    }

    fs.appendFileSync(this.journalPath, row);

    console.log(
      `📒 Trade Logged | ${reason} | Qty=${tradeQty} | EstPoints=${estimatedPnLPoints.toFixed(2)} | EstPnL=$${estimatedDollarPnL.toFixed(2)} | BrokerDaily=$${brokerTodaysPnL != null ? brokerTodaysPnL.toFixed(2) : 'N/A'}`
    );

    return {
      estimatedPnLPoints,
      estimatedDollarPnL,
      brokerRealizedPnL,
      brokerTodaysPnL,
      brokerUnrealizedPnL,
      brokerQty,
      brokerAvgPrice,
      qty: tradeQty
    };
  }

  logSessionSummary({ date, dailyPnL, consecutiveLosses }) {
    const summary = `${date},${dailyPnL},${consecutiveLosses}\n`;

    if (!fs.existsSync(this.sessionLogPath)) {
      fs.writeFileSync(
        this.sessionLogPath,
        'date,totalPnL,consecutiveLossesAtClose\n'
      );
    }

    fs.appendFileSync(this.sessionLogPath, summary);
    console.log('📊 Session summary logged');
  }
}

module.exports = TradeLogger;