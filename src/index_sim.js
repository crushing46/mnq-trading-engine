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
  accountId: process.env.ACCOUNT_ID
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

    const local = closedBar.time.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      hour12: true
    });

    console.log(
      `📊 ${local} | O:${closedBar.open} H:${closedBar.high} L:${closedBar.low} C:${closedBar.close}`
    );

    strategy.addBar(closedBar);

    // ---- EXIT CHECK ----
    if (position) {
      const slCheck = strategy.checkExitSignal(
        position.side === 'LONG'
          ? closedBar.low
          : closedBar.high,
        position
      );

      const tpCheck = strategy.checkExitSignal(
        position.side === 'LONG'
          ? closedBar.high
          : closedBar.low,
        position
      );

      const finalExit = slCheck || tpCheck;

      if (finalExit) {
        console.log(
          `🚪 EXIT ${finalExit.reason} | Price=${finalExit.price}`
        );

        if (CONFIG.enableTrading) {
          await tsApi.placeMarketOrder(
            CONFIG.accountId,
            CONFIG.symbol,
            position.qty,
            position.side === 'LONG' ? 'SHORT' : 'LONG'
          );
        }

        position = null;
        return;
      }
    }

    if (!position) {
      const rawSignal = strategy.checkEntrySignal();

      if (rawSignal && rawSignal.type) {
        const entryPrice = closedBar.close;

        console.log(
          `📈 ENTRY SIGNAL | Side=${rawSignal.type} | Entry=${entryPrice}`
        );

        if (CONFIG.enableTrading) {
          await tsApi.placeMarketOrder(
            CONFIG.accountId,
            CONFIG.symbol,
            CONFIG.qty,
            rawSignal.type
          );
        }

        position = {
          side: rawSignal.type,
          entryPrice,
          stopLoss: rawSignal.stopLoss,
          takeProfit: rawSignal.takeProfit,
          qty: CONFIG.qty,
          entryTime: closedBar.time,
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

        position = {
          side,
          entryPrice: Number(mnqPosition.AveragePrice),
          stopLoss: null,
          takeProfit: null,
          qty: Math.abs(qty),
          entryTime: new Date(),
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