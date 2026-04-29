require('dotenv').config();

const express = require('express');
const path = require('path');

const TradingStrategy = require('./services/strategy');
const TradeStationAPI = require('./api/tradestation');
const TradeLogger = require('./services/tradeLogger');
const RiskManager = require('./services/riskManager');
const PositionManager = require('./services/positionManager');

const app = express();
app.use(express.json());

const PORT = 3001;

// ================= CONFIG =================
const CONFIG = {
  symbol: process.env.SYMBOL,
  qty: Number(process.env.CONTRACT_SIZE || 2),
  tp: Number(process.env.TP_POINTS || 40),
  sl: Number(process.env.SL_POINTS || 40),
  emaFast: Number(process.env.EMA_FAST),
  emaSlow: Number(process.env.EMA_SLOW),
  emaTrend: Number(process.env.EMA_TREND),
  enableTrading: process.env.ENABLE_TRADING === 'true',
  trailRunner: process.env.TRAIL_RUNNER === 'true',
  trailDistance: Number(process.env.TRAIL_DISTANCE || 40),
  accountId: process.env.ACCOUNT_ID,
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 0),
  useTickExecution: process.env.USE_TICK_EXECUTION === 'true',
  pointValue: Number(process.env.POINT_VALUE || 2)
};

console.log('🔧 CONFIG:', CONFIG);
console.log(`📡 Using SYMBOL: "${CONFIG.symbol}"`);

if (!CONFIG.symbol) {
  console.warn('⚠️ SYMBOL is undefined in .env');
} else {
  console.log(`✅ Symbol configured: ${CONFIG.symbol}`);
}

if (!CONFIG.accountId) {
  console.warn('⚠️ ACCOUNT_ID is undefined in .env');
}

// ================= API =================
const tsApi = new TradeStationAPI({
  apiKey: process.env.TS_API_KEY,
  secretKey: process.env.TS_SECRET_KEY,
  redirectUri: process.env.TS_REDIRECT_URI
});

// ================= SERVICES =================
const strategy = new TradingStrategy({
  emaFast: CONFIG.emaFast,
  emaSlow: CONFIG.emaSlow,
  emaTrend: CONFIG.emaTrend,
  tpPoints: CONFIG.tp,
  slPoints: CONFIG.sl,
  contractSize: CONFIG.qty
});

const tradeLogger = new TradeLogger({
  journalPath: path.join(__dirname, 'trades.csv'),
  sessionLogPath: path.join(__dirname, 'session_log.csv'),
  pointValue: CONFIG.pointValue
});

const riskManager = new RiskManager({
  maxDailyLoss: CONFIG.maxDailyLoss
});

const positionManager = new PositionManager({
  config: CONFIG,
  tsApi,
  riskManager,
  tradeLogger
});

// ================= STREAM STATE =================
let formingBar = null;
let lastFinalizedMinute = null;

// ================= HELPERS =================
async function getLiveBrokerPosition() {
  const brokerData = await tsApi.getOpenPositions(CONFIG.accountId);
  const positions = brokerData?.Positions || brokerData || [];

  return positions.find(
    (p) =>
      p.Symbol === CONFIG.symbol &&
      Number(p.Quantity) !== 0
  );
}

async function updateBrokerPnLAndEnforceRisk() {
  try {
    const balances = await tsApi.getAccountBalances(CONFIG.accountId);

    const brokerDailyPnL = Number(
      balances?.Balances?.DayTradeProfitLoss ??
      balances?.DayTradeProfitLoss ??
      balances?.Balances?.DailyProfitLoss ??
      balances?.DailyProfitLoss ??
      riskManager.dailyPnL
    );

    const brokerUnrealizedPnL = Number(
      balances?.Balances?.OpenTradeProfitLoss ??
      balances?.OpenTradeProfitLoss ??
      balances?.Balances?.UnrealizedProfitLoss ??
      balances?.UnrealizedProfitLoss ??
      0
    );

    const breached = riskManager.updateBrokerPnL({
      dailyPnL: brokerDailyPnL,
      unrealizedPnL: brokerUnrealizedPnL
    });

    if (breached) {
      await positionManager.flattenBrokerPosition('BROKER_DAILY_LOSS_BREACH');
    }
  } catch (err) {
    console.error('⚠️ Failed to fetch broker balances:', err.message);
  }
}

async function reconcileBrokerPosition() {
  try {
    const livePos = await getLiveBrokerPosition();

    if (!livePos && positionManager.hasPosition()) {
      console.log('⚠️ Broker shows FLAT — clearing internal position');
      positionManager.clearPosition('BROKER_FLAT_RECONCILE');
      return;
    }

    if (livePos) {
      positionManager.syncFromBrokerPosition(livePos);
    }
  } catch (err) {
    console.error('⚠️ Broker reconciliation failed:', err.message);
  }
}

async function handleEodFlatten(closedBar) {
  const hour = closedBar.time.getHours();
  const minute = closedBar.time.getMinutes();

  if (hour === 15 && minute >= 50 && positionManager.hasPosition()) {
    console.log('⏰ 3:50 PM CT — AUTO FLATTEN');

    await positionManager.flattenBrokerPosition('EOD_FLATTEN', closedBar.close);

    const riskState = riskManager.getState();

    tradeLogger.logSessionSummary({
      date: closedBar.time.toISOString().split('T')[0],
      dailyPnL: riskState.dailyPnL,
      consecutiveLosses: riskState.consecutiveLosses
    });

    riskManager.disable('EOD_FLATTEN');

    return true;
  }

  return false;
}

function printBar(closedBar) {
  const local = closedBar.time.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    hour12: true
  });

  console.log(
    `📊 ${local} | O:${closedBar.open} H:${closedBar.high} L:${closedBar.low} C:${closedBar.close}`
  );
}

// ================= TICK/BAR HANDLING =================
async function onTick(tick) {
  if (!tick || !Number.isFinite(tick.price)) return;

  if (CONFIG.useTickExecution) {
    await positionManager.checkExitsByPrice({
      price: tick.price,
      time: tick.time,
      source: 'TICK'
    });
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

    riskManager.resetIfNewDay(closedBar.time);

    const eodFlattened = await handleEodFlatten(closedBar);
    if (eodFlattened) {
      rolloverFormingBar(tick, minuteTs);
      return;
    }

    printBar(closedBar);

    strategy.addBar(closedBar);

    await updateBrokerPnLAndEnforceRisk();
    await reconcileBrokerPosition();

    // Safety: always evaluate bar TP/SL as a backup.
    // Even when USE_TICK_EXECUTION=true, this catches missed stream updates.
    await positionManager.checkExitsByBar(closedBar);

    if (!riskManager.canTrade()) {
      console.log('🛑 Trading disabled for session');
      rolloverFormingBar(tick, minuteTs);
      return;
    }

    const signal = strategy.checkEntrySignal();

    if (positionManager.hasPosition()) {
      const currentPosition = positionManager.getPosition();

      if (
        signal &&
        signal.type &&
        signal.type !== currentPosition.side
      ) {
        await positionManager.flipPosition({
          newSide: signal.type,
          price: closedBar.close,
          time: closedBar.time
        });

        rolloverFormingBar(tick, minuteTs);
        return;
      }
    }

    if (!positionManager.hasPosition()) {
      if (signal && signal.type) {
        console.log(
          `📈 ENTRY SIGNAL | Side=${signal.type} | Entry=${closedBar.close} | FixedTP=${
            signal.type === 'LONG'
              ? closedBar.close + CONFIG.tp
              : closedBar.close - CONFIG.tp
          } | SL=${
            signal.type === 'LONG'
              ? closedBar.close - CONFIG.sl
              : closedBar.close + CONFIG.sl
          }`
        );

        await positionManager.enterTargetPosition({
          side: signal.type,
          entryPrice: closedBar.close,
          entryTime: closedBar.time
        });
      } else {
        console.log('⏭ No entry');
      }
    }
  }

  rolloverFormingBar(tick, minuteTs);
}

function rolloverFormingBar(tick, minuteTs) {
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

    try {
      const livePos = await getLiveBrokerPosition();

      if (livePos) {
        positionManager.syncFromBrokerPosition(livePos);
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

  if (CONFIG.useTickExecution) {
    if (typeof tsApi.streamQuotes !== 'function') {
      console.warn(
        '⚠️ USE_TICK_EXECUTION=true but tsApi.streamQuotes() is not available. TP/SL will use bar high/low backup only.'
      );
      return;
    }

    console.log('✅ True quote/tick execution enabled for TP/SL');

    await tsApi.streamQuotes(CONFIG.symbol, async (quote) => {
      await onTick({
        price: quote.price,
        time: quote.time,
        bid: quote.bid,
        ask: quote.ask,
        last: quote.last
      });
    });
  } else {
    console.log('ℹ️ USE_TICK_EXECUTION=false — TP/SL will use bar high/low backup only');
  }
}

// ================= SERVER =================
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  await startBot();
});