require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const TradingStrategy = require('./services/strategy');
const TradeStationAPI = require('./api/tradestation');

const app = express();
app.use(express.json());

const PORT = 3001;

// ================= CONFIG =================
const CONFIG = {
  symbol: process.env.SYMBOL,
  qty: Number(process.env.CONTRACT_SIZE),
  tp: Number(process.env.TP_POINTS),
  sl: Number(process.env.SL_POINTS),
  emaFast: Number(process.env.EMA_FAST),
  emaSlow: Number(process.env.EMA_SLOW),
  emaTrend: Number(process.env.EMA_TREND),
  enableTrading: process.env.ENABLE_TRADING === 'true',
  trailRunner: process.env.TRAIL_RUNNER === 'true',
  trailDistance: Number(process.env.TRAIL_DISTANCE || 20),
  accountId: process.env.ACCOUNT_ID,
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 0)
};

console.log('🔧 CONFIG:', CONFIG);
console.log(`📡 Using SYMBOL: "${CONFIG.symbol}"`);

if (!CONFIG.symbol) {
  console.warn('⚠️ SYMBOL is undefined in .env');
} else if (!CONFIG.symbol.startsWith('@')) {
  console.warn('⚠️ Futures symbols typically require "@" prefix (e.g., @MNQM26)');
} else {
  console.log('✅ Symbol format appears correct for futures.');
}

// ================= API =================
const tsApi = new TradeStationAPI({
  apiKey: process.env.TS_API_KEY,
  secretKey: process.env.TS_SECRET_KEY,
  redirectUri: process.env.TS_REDIRECT_URI
});

// ================= STRATEGY =================
const strategy = new TradingStrategy({
  emaFast: CONFIG.emaFast,
  emaSlow: CONFIG.emaSlow,
  emaTrend: CONFIG.emaTrend,
  tpPoints: CONFIG.tp,
  slPoints: CONFIG.sl,
  contractSize: CONFIG.qty
});

// ================= POSITION =================
let position = null;

let dailyPnL = 0;
let consecutiveLosses = 0;
let tradingDisabled = false;
let currentTradeDate = null;

const journalPath = path.join(__dirname, 'trades.csv');
const sessionLogPath = path.join(__dirname, 'session_log.csv');

function logSessionSummary(date) {
  const summary = `${date},${dailyPnL},${consecutiveLosses}\n`;

  if (!fs.existsSync(sessionLogPath)) {
    fs.writeFileSync(
      sessionLogPath,
      'date,totalPnL,consecutiveLossesAtClose\n'
    );
  }

  fs.appendFileSync(sessionLogPath, summary);
  console.log('📊 Session summary logged');
}

function resetDailyPnLIfNewDay(date) {
  const tradeDate = date.toISOString().split('T')[0];

  if (currentTradeDate !== tradeDate) {
    currentTradeDate = tradeDate;
    dailyPnL = 0;
    console.log(`📅 New Trading Day: ${tradeDate} | Reset Daily PnL`);
  }
}

async function logTrade(entry, exit, reason) {
  const pnl =
    entry.side === 'LONG'
      ? exit.price - entry.entryPrice
      : entry.entryPrice - exit.price;

  const tradeQty = exit.qty || entry.qty;
  dailyPnL += pnl * tradeQty;

  if (pnl < 0) {
    consecutiveLosses += 1;
  } else {
    consecutiveLosses = 0;
  }

  // Hard Daily Loss Shutdown (Force Flatten)
  if (
    CONFIG.maxDailyLoss > 0 &&
    dailyPnL <= -CONFIG.maxDailyLoss
  ) {
    console.log(
      `🛑 HARD DAILY LOSS LIMIT HIT ($${CONFIG.maxDailyLoss}) — EMERGENCY FLATTEN`
    );

    tradingDisabled = true;

    if (position && CONFIG.enableTrading) {
      try {
        const brokerData = await tsApi.getOpenPositions(CONFIG.accountId);
        const positions = brokerData?.Positions || brokerData || [];

        const livePos = positions.find(
          (p) => p.Symbol === CONFIG.symbol
        );

        const liveQty = livePos ? Number(livePos.Quantity) : 0;

        if (liveQty !== 0) {
          const flattenSide = liveQty > 0 ? 'SHORT' : 'LONG';

          await tsApi.placeMarketOrder(
            CONFIG.accountId,
            CONFIG.symbol,
            Math.abs(liveQty),
            flattenSide
          );

          console.log('🚨 Emergency flatten order sent');
        }

        position = null;
      } catch (err) {
        console.error('⚠️ Emergency flatten failed:', err.message);
      }
    }
  }

  // 3 consecutive loss shutdown
  if (consecutiveLosses >= 3) {
    tradingDisabled = true;
    console.log('🛑 3 CONSECUTIVE LOSSES — TRADING DISABLED');
  }

  const row = `${new Date().toISOString()},${entry.side},${entry.entryPrice},${exit.price},${reason},${pnl * tradeQty},${dailyPnL}\n`;

  if (!fs.existsSync(journalPath)) {
    fs.writeFileSync(
      journalPath,
      'timestamp,side,entry,exit,reason,pnl,dailyPnL\n'
    );
  }

  fs.appendFileSync(journalPath, row);

  console.log(`📒 Trade Logged | Qty: ${tradeQty} | PnL: ${pnl * tradeQty} | Daily: ${dailyPnL}`);
}

let formingBar = null;
let lastFinalizedMinute = null;

async function onTick(tick) {
  if (!position) return;
  if (!tick || !Number.isFinite(tick.price)) return;
  if (tick.time <= position.entryTime) return;

  const price = tick.price;

  const move =
    position.side === 'LONG'
      ? price - position.entryPrice
      : position.entryPrice - price;

  position.maxFavorable = Math.max(position.maxFavorable, move);
  position.maxAdverse = Math.min(position.maxAdverse, move);

  if (!position.beAdjusted && move >= 25) {
    for (const leg of position.legs) {
      leg.stopLoss =
        position.side === 'LONG'
          ? position.entryPrice + 2
          : position.entryPrice - 2;

      if (leg.id === 'runner') {
        leg.trailing = CONFIG.trailRunner;
      }
    }

    position.beAdjusted = true;
    console.log(`🔒 MOVE SL TO BE+2`);
  }
}

async function handleStreamBar(tick) {
  if (!tick || !(tick.time instanceof Date) || !Number.isFinite(tick.close)) return;

  const minuteTs = Math.floor(tick.time.getTime() / 60000) * 60000;

  if (!formingBar) {
    formingBar = {
      minute: minuteTs,
      open: tick.open,
      high: tick.high,
      low: tick.low,
      close: tick.close,
      volume: tick.volume || 0
    };
    return;
  }

  if (formingBar.minute === minuteTs) {
    formingBar.high = Math.max(formingBar.high, tick.high);
    formingBar.low = Math.min(formingBar.low, tick.low);
    formingBar.close = tick.close;
    formingBar.volume += tick.volume || 0;

    await onTick({
      price: tick.close,
      time: tick.time
    });

    return;
  }

  if (formingBar && formingBar.minute !== lastFinalizedMinute) {
    lastFinalizedMinute = formingBar.minute;

    const closedBar = {
      time: new Date(formingBar.minute),
      open: formingBar.open,
      high: formingBar.high,
      low: formingBar.low,
      close: formingBar.close,
      volume: formingBar.volume
    };

    resetDailyPnLIfNewDay(closedBar.time);

    const hour = closedBar.time.getHours();
    const minute = closedBar.time.getMinutes();

    if (hour === 15 && minute >= 50 && position) {
      console.log('⏰ 3:50 PM CT — AUTO FLATTEN');

      if (CONFIG.enableTrading) {
        // Pre-order verification
        const verifyData = await tsApi.getOpenPositions(CONFIG.accountId);
        const verifyPositions = verifyData?.Positions || verifyData || [];
        const verifyPos = verifyPositions.find(
          (p) => p.Symbol === CONFIG.symbol
        );

        const verifyQty = verifyPos ? Number(verifyPos.Quantity) : 0;

        if (Math.abs(verifyQty) !== Math.abs(position?.qty || 0)) {
          console.log('⚠️ Pre-order verification failed — position changed. Skipping order.');
          return;
        }

        await tsApi.placeMarketOrder(
          CONFIG.accountId,
          CONFIG.symbol,
          position.qty,
          position.side === 'LONG' ? 'SHORT' : 'LONG'
        );
      }

      await logTrade(position, { price: closedBar.close }, 'EOD_FLATTEN');

      logSessionSummary(closedBar.time.toISOString().split('T')[0]);
      tradingDisabled = false;
      consecutiveLosses = 0;

      position = null;
      return;
    }

    const local = closedBar.time.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      hour12: true
    });

    console.log(
      `📊 ${local} | O:${closedBar.open} H:${closedBar.high} L:${closedBar.low} C:${closedBar.close}`
    );

    strategy.addBar(closedBar);

    // ============================================================
    // REAL-TIME DAILY LOSS CHECK (REALIZED + UNREALIZED)
    // ============================================================
    if (position) {
      const unrealizedMove =
        position.side === 'LONG'
          ? closedBar.close - position.entryPrice
          : position.entryPrice - closedBar.close;

      // Calculate unrealized based on ACTIVE LEGS only
      const unrealizedPnL = position.legs
        .filter(l => l.active)
        .reduce((sum, leg) => sum + (unrealizedMove * leg.qty), 0);

      const totalDailyExposure = dailyPnL + unrealizedPnL;

      if (
        CONFIG.maxDailyLoss > 0 &&
        totalDailyExposure <= -CONFIG.maxDailyLoss &&
        !tradingDisabled
      ) {
        console.log(
          `🚨 REAL-TIME DAILY LOSS BREACH ($${CONFIG.maxDailyLoss}) — FORCING FLATTEN`
        );

        tradingDisabled = true;

        if (CONFIG.enableTrading) {
          try {
            const brokerData = await tsApi.getOpenPositions(CONFIG.accountId);
            const positions = brokerData?.Positions || brokerData || [];

            const livePos = positions.find(
              (p) => p.Symbol === CONFIG.symbol
            );

            const liveQty = livePos ? Number(livePos.Quantity) : 0;

            if (liveQty !== 0) {
              const flattenSide = liveQty > 0 ? 'SHORT' : 'LONG';

              await tsApi.placeMarketOrder(
                CONFIG.accountId,
                CONFIG.symbol,
                Math.abs(liveQty),
                flattenSide
              );

              console.log('🚨 Real-time emergency flatten order sent');
            }
          } catch (err) {
            console.error('⚠️ Real-time flatten failed:', err.message);
          }
        }

        position = null;
        return;
      }
    }

    // ============================================================
    // LIVE BROKER RECONCILIATION (Pre-Exit Safety Check)
    // ============================================================
    if (position) {
      try {
        const brokerData = await tsApi.getOpenPositions(CONFIG.accountId);
        const positions = brokerData?.Positions || brokerData || [];

        const livePos = positions.find(
          (p) =>
            p.Symbol === CONFIG.symbol &&
            Number(p.Quantity) !== 0
        );

        if (!livePos) {
          console.log('⚠️ Broker shows FLAT — clearing internal position');
          position = null;
        } else {
          const liveQty = Number(livePos.Quantity);
          const liveSide = liveQty > 0 ? 'LONG' : 'SHORT';

          if (
            liveSide !== position.side ||
            Math.abs(liveQty) !== position.qty
          ) {
            console.log('🔄 Broker position mismatch — resyncing');

            const entryPrice = Number(livePos.AveragePrice);

            position = {
              side: liveSide,
              entryPrice,
              qty: Math.abs(liveQty),
              entryTime: new Date(),
              legs: [
                {
                  id: 'fixed',
                  qty: 1,
                  takeProfit:
                    liveSide === 'LONG'
                      ? entryPrice + CONFIG.tp
                      : entryPrice - CONFIG.tp,
                  stopLoss:
                    liveSide === 'LONG'
                      ? entryPrice - CONFIG.sl
                      : entryPrice + CONFIG.sl,
                  active: true
                },
                {
                  id: 'runner',
                  qty: Math.abs(liveQty) - 1,
                  stopLoss:
                    liveSide === 'LONG'
                      ? entryPrice - CONFIG.sl
                      : entryPrice + CONFIG.sl,
                  trailing: false,
                  active: Math.abs(liveQty) > 1
                }
              ],
              beAdjusted: false,
              maxFavorable: 0,
              maxAdverse: 0
            };
          }
        }
      } catch (err) {
        console.error('⚠️ Broker reconciliation failed:', err.message);
      }
    }

    // ---- PROFESSIONAL LEG-BASED EXIT CHECK ----
    if (position) {

      for (const leg of position.legs) {
        if (!leg.active) continue;

        const hitTP =
          leg.takeProfit &&
          (
            (position.side === 'LONG' && closedBar.high >= leg.takeProfit) ||
            (position.side === 'SHORT' && closedBar.low <= leg.takeProfit)
          );

        const hitSL =
          (position.side === 'LONG' && closedBar.low <= leg.stopLoss) ||
          (position.side === 'SHORT' && closedBar.high >= leg.stopLoss);

        // === TAKE PROFIT ===
        if (hitTP) {
          console.log(`🎯 ${leg.id.toUpperCase()} TP HIT`);

          if (CONFIG.enableTrading) {
            await tsApi.placeMarketOrder(
              CONFIG.accountId,
              CONFIG.symbol,
              leg.qty,
              position.side === 'LONG' ? 'SHORT' : 'LONG'
            );
          }

          leg.active = false;

          // Activate runner trailing after fixed TP
          if (leg.id === 'fixed') {
            const runner = position.legs.find(l => l.id === 'runner');
            if (runner && runner.active && CONFIG.trailRunner) {
              runner.trailing = true;
              console.log('🏃 Runner trailing activated');
            }
          }

          await logTrade(position, { price: leg.takeProfit, qty: leg.qty }, `${leg.id}_TP`);
        }

        // === STOP LOSS ===
        if (hitSL) {
          console.log(`🛑 ${leg.id.toUpperCase()} SL HIT`);

          if (CONFIG.enableTrading) {
            await tsApi.placeMarketOrder(
              CONFIG.accountId,
              CONFIG.symbol,
              leg.qty,
              position.side === 'LONG' ? 'SHORT' : 'LONG'
            );
          }

          leg.active = false;

          await logTrade(position, { price: leg.stopLoss, qty: leg.qty }, `${leg.id}_SL`);
        }

        // === TRAILING LOGIC (RUNNER ONLY) ===
        if (leg.id === 'runner' && leg.trailing && leg.active) {
          if (position.side === 'LONG') {
            const newStop = closedBar.close - CONFIG.trailDistance;
            if (newStop > leg.stopLoss) leg.stopLoss = newStop;
          } else {
            const newStop = closedBar.close + CONFIG.trailDistance;
            if (newStop < leg.stopLoss) leg.stopLoss = newStop;
          }
        }
      }

      // If all legs inactive → clear position
      const stillActive = position.legs.some(l => l.active);
      if (!stillActive) {
        console.log('📦 All legs closed — clearing position');
        position = null;
        return;
      }
    }

    // ---- FLIP CHECK (TARGET POSITION BASED) ----
    if (position) {
      const flipSignal = strategy.checkEntrySignal();

      if (
        flipSignal &&
        flipSignal.type &&
        flipSignal.type !== position.side
      ) {
        console.log(
          `🔁 FLIP SIGNAL | ${position.side} → ${flipSignal.type} (TARGET MODE)`
        );

        // Determine desired target position
        const desiredQty =
          flipSignal.type === 'LONG'
            ? CONFIG.qty
            : -CONFIG.qty;

        // Query current broker position
        const brokerData = await tsApi.getOpenPositions(CONFIG.accountId);
        const positions = brokerData?.Positions || brokerData || [];

        const currentPos = positions.find(
          (p) => p.Symbol === CONFIG.symbol
        );

        const currentQty = currentPos ? Number(currentPos.Quantity) : 0;

        const orderSize = desiredQty - currentQty;

        if (orderSize !== 0 && CONFIG.enableTrading) {
          const side = orderSize > 0 ? 'LONG' : 'SHORT';

          // Pre-order verification
          const verifyData = await tsApi.getOpenPositions(CONFIG.accountId);
          const verifyPositions = verifyData?.Positions || verifyData || [];
          const verifyPos = verifyPositions.find(
            (p) => p.Symbol === CONFIG.symbol
          );

          const verifyQty = verifyPos ? Number(verifyPos.Quantity) : 0;

          if (Math.abs(verifyQty) !== Math.abs(position?.qty || 0)) {
            console.log('⚠️ Pre-order verification failed — position changed. Skipping order.');
            return;
          }

          await tsApi.placeMarketOrder(
            CONFIG.accountId,
            CONFIG.symbol,
            Math.abs(orderSize),
            side
          );
        }

        position = {
          side: flipSignal.type,
          entryPrice: closedBar.close,
          entryTime: closedBar.time,
          qty: CONFIG.qty,
          legs: [
            {
              id: 'fixed',
              qty: 1,
              takeProfit:
                flipSignal.type === 'LONG'
                  ? closedBar.close + CONFIG.tp
                  : closedBar.close - CONFIG.tp,
              stopLoss:
                flipSignal.type === 'LONG'
                  ? closedBar.close - CONFIG.sl
                  : closedBar.close + CONFIG.sl,
              active: true
            },
            {
              id: 'runner',
              qty: CONFIG.qty - 1,
              stopLoss:
                flipSignal.type === 'LONG'
                  ? closedBar.close - CONFIG.sl
                  : closedBar.close + CONFIG.sl,
              trailing: false,
              active: CONFIG.qty > 1
            }
          ],
          beAdjusted: false,
          maxFavorable: 0,
          maxAdverse: 0
        };

        return;
      }
    }

    if (tradingDisabled) {
      console.log('🛑 Trading disabled for session');
      return;
    }

    if (!position) {
      const rawSignal = strategy.checkEntrySignal();

      if (rawSignal && rawSignal.type) {
        const entryPrice = closedBar.close;

        console.log(
          `📈 ENTRY SIGNAL | Side=${rawSignal.type} | Entry=${entryPrice}`
        );

        // Determine desired target
        const desiredQty =
          rawSignal.type === 'LONG'
            ? CONFIG.qty
            : -CONFIG.qty;

        // Query broker
        const brokerData = await tsApi.getOpenPositions(CONFIG.accountId);
        const positions = brokerData?.Positions || brokerData || [];

        const currentPos = positions.find(
          (p) => p.Symbol === CONFIG.symbol
        );

        const currentQty = currentPos ? Number(currentPos.Quantity) : 0;

        const orderSize = desiredQty - currentQty;

        if (orderSize !== 0 && CONFIG.enableTrading) {
          const side = orderSize > 0 ? 'LONG' : 'SHORT';

          // Pre-order verification
          const verifyData = await tsApi.getOpenPositions(CONFIG.accountId);
          const verifyPositions = verifyData?.Positions || verifyData || [];
          const verifyPos = verifyPositions.find(
            (p) => p.Symbol === CONFIG.symbol
          );

          const verifyQty = verifyPos ? Number(verifyPos.Quantity) : 0;

          if (Math.abs(verifyQty) !== Math.abs(position?.qty || 0)) {
            console.log('⚠️ Pre-order verification failed — position changed. Skipping order.');
            return;
          }

          await tsApi.placeMarketOrder(
            CONFIG.accountId,
            CONFIG.symbol,
            Math.abs(orderSize),
            side
          );
        }

        position = {
          side: rawSignal.type,
          entryPrice,
          entryTime: closedBar.time,
          qty: CONFIG.qty,
          legs: [
            {
              id: 'fixed',
              qty: 1,
              takeProfit:
                rawSignal.type === 'LONG'
                  ? entryPrice + CONFIG.tp
                  : entryPrice - CONFIG.tp,
              stopLoss:
                rawSignal.type === 'LONG'
                  ? entryPrice - CONFIG.sl
                  : entryPrice + CONFIG.sl,
              active: true
            },
            {
              id: 'runner',
              qty: CONFIG.qty - 1,
              stopLoss:
                rawSignal.type === 'LONG'
                  ? entryPrice - CONFIG.sl
                  : entryPrice + CONFIG.sl,
              trailing: false,
              active: CONFIG.qty > 1
            }
          ],
          beAdjusted: false,
          maxFavorable: 0,
          maxAdverse: 0
        };
      } else {
        console.log(`⏭ No entry`);
      }
    }
  }

  formingBar = {
    minute: minuteTs,
    open: tick.open,
    high: tick.high,
    low: tick.low,
    close: tick.close,
    volume: tick.volume || 0
  };
}

// ================= CALLBACK ROUTE =================
app.get('/', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.log('OAuth error:', error);
    return res.send(`OAuth error: ${error}`);
  }

  if (!code) {
    return res.send('ROOT WORKING');
  }

  console.log('🔑 Authorization code received');

  try {
    await tsApi.exchangeAuthorizationCode(code);
    console.log('✅ Tokens saved successfully');
    res.send('Authorization successful. Restarting bot...');
    setTimeout(startBot, 1000);
  } catch (err) {
    console.error('OAuth exchange failed:', err.message);
    res.status(500).send('Authorization failed.');
  }
});


// ================= BOT LOGIC =================
async function startBot() {
  try {
    await tsApi.ensureValidToken();
    
    console.log('✅ Authenticated with TradeStation');

    // ============================================================
    // BROKER POSITION SYNC (Startup Reconciliation)
    // ============================================================
    try {
      const brokerData = await tsApi.getOpenPositions(CONFIG.accountId);

      const positions = brokerData?.Positions || brokerData || [];

      const mnqPosition = positions.find(
        (p) =>
          p.Symbol === CONFIG.symbol &&
          Number(p.Quantity) !== 0
      );

      if (mnqPosition) {
        const qty = Number(mnqPosition.Quantity);
        const side = qty > 0 ? 'LONG' : 'SHORT';

        const entryPrice = Number(mnqPosition.AveragePrice);

        position = {
          side,
          entryPrice,
          qty: Math.abs(qty),
          entryTime: new Date(),
          legs: [
            {
              id: 'fixed',
              qty: 1,
              takeProfit:
                side === 'LONG'
                  ? entryPrice + CONFIG.tp
                  : entryPrice - CONFIG.tp,
              stopLoss:
                side === 'LONG'
                  ? entryPrice - CONFIG.sl
                  : entryPrice + CONFIG.sl,
              active: true
            },
            {
              id: 'runner',
              qty: Math.abs(qty) - 1,
              stopLoss:
                side === 'LONG'
                  ? entryPrice - CONFIG.sl
                  : entryPrice + CONFIG.sl,
              trailing: false,
              active: Math.abs(qty) > 1
            }
          ],
          beAdjusted: false,
          maxFavorable: 0,
          maxAdverse: 0
        };

        console.log(
          `🔄 Synced broker position: ${side} ${Math.abs(qty)} @ ${mnqPosition.AveragePrice}`
        );
      } else {
        console.log('🟢 No open broker position detected — starting flat');
      }
    } catch (err) {
      console.error('⚠️ Failed to sync broker positions:', err.message);
    }
  } catch {
    console.log('\n🔐 AUTHORIZATION REQUIRED\n');
    console.log('Open this URL in your browser:\n');
    console.log(tsApi.getAuthorizationUrl());
    return;
  }

  console.log('🚀 Starting MNQ Bot...');

  const hist = await tsApi.getHistoricalBars(CONFIG.symbol, 1, 'Minute', 300);

  hist.Bars.forEach((b) =>
    strategy.addBar({
      time: new Date(b.TimeStamp),
      open: +b.Open,
      high: +b.High,
      low: +b.Low,
      close: +b.Close,
      volume: +b.TotalVolume
    })
  );

  await tsApi.streamBars(CONFIG.symbol, 1, async (bar) => {
    await handleStreamBar(bar);
  });
}

// ================= SERVER =================
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  await startBot();
});