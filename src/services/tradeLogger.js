const fs = require('fs');

class TradeLogger {
  constructor({ journalPath, sessionLogPath, pointValue }) {
    this.journalPath = journalPath;
    this.sessionLogPath = sessionLogPath;
    this.pointValue = Number(pointValue || 2);
  }

  logTrade(entry, exit, reason) {
    const pnlPoints =
      entry.side === 'LONG'
        ? exit.price - entry.entryPrice
        : entry.entryPrice - exit.price;

    const tradeQty = exit.qty || entry.qty || 1;
    const dollarPnL = pnlPoints * tradeQty * this.pointValue;

    const row = `${new Date().toISOString()},${entry.side},${entry.entryPrice},${exit.price},${reason},${tradeQty},${pnlPoints},${dollarPnL}\n`;

    if (!fs.existsSync(this.journalPath)) {
      fs.writeFileSync(
        this.journalPath,
        'timestamp,side,entry,exit,reason,qty,pnlPoints,pnlDollars\n'
      );
    }

    fs.appendFileSync(this.journalPath, row);

    console.log(
      `📒 Trade Logged | ${reason} | Qty=${tradeQty} | Points=${pnlPoints.toFixed(2)} | PnL=$${dollarPnL.toFixed(2)}`
    );

    return {
      pnlPoints,
      dollarPnL,
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