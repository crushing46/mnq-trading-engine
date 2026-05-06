require('dotenv').config();

const express = require('express');
const path = require('path');

const TradingStrategy = require('./services/strategy');
const TradeStationAPI = require('./api/tradestation');
const TradeLogger = require('./services/tradeLogger');
const RiskManager = require('./services/riskManager');
const PositionManager = require('./services/positionManager');
const createDashboardApi = require('./routes/dashboardApi');
const Notifier = require('./services/notifier');
const { sendPushover } = require('./services/pushover');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3001;

function normalizeTradeStationSymbol(rawSymbol) {
  const symbol = String(rawSymbol || '').trim();

  if (!symbol) return symbol;

  // TradeStation API futures order symbols should not use the chart-style @ prefix.
  if (symbol.startsWith('@')) {
    const cleaned = symbol.replace(/^@+/, '');
    console.warn(`⚠️ Removed chart-style @ prefix from SYMBOL. Using TradeStation symbol: ${cleaned}`);
    return cleaned;
  }

  return symbol;
}

function logSafeError(context, err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const message = err?.message || 'Unknown error';

  console.error(`❌ ${context}`);
  console.error(`Message: ${message}`);

  if (status) {
    console.error(`Status: ${status}`);
  }

  if (data) {
    console.error('Response:', typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }
}

process.on('unhandledRejection', (err) => {
  logSafeError('Unhandled promise rejection caught — bot will keep running if possible', err);
});

process.on('uncaughtException', (err) => {
  logSafeError('Uncaught exception caught — bot will keep running if possible', err);
});
const PROFIT_LOCK_ENABLED = process.env.PROFIT_LOCK_ENABLED === 'true';
const MAX_SESSION_PROFIT = Number(process.env.MAX_SESSION_PROFIT || 1500);
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://159.223.113.118:3001/dashboard';

let profitLockTriggered = false;
// ================= CONFIG =================
const CONFIG = {
  symbol: normalizeTradeStationSymbol(process.env.SYMBOL),
  qty: Number(process.env.CONTRACT_SIZE || 2),
  tp: Number(process.env.TP_POINTS || 40),
  sl: Number(process.env.SL_POINTS || 40),
  beTriggerPoints: Number(process.env.BE_TRIGGER_POINTS || 40),
  beOffsetPoints: Number(process.env.BE_OFFSET_POINTS || 2),
  emaFast: Number(process.env.EMA_FAST),
  emaSlow: Number(process.env.EMA_SLOW),
  emaTrend: Number(process.env.EMA_TREND),
  enableTrading: process.env.ENABLE_TRADING === 'true',
  trailRunner: process.env.TRAIL_RUNNER === 'true',
  trailDistance: Number(process.env.TRAIL_DISTANCE || 40),
  accountId: process.env.ACCOUNT_ID,
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 0),
  enableDailyLossLimit: process.env.ENABLE_DAILY_LOSS_LIMIT !== 'false',
  enableConsecutiveLossLimit: process.env.ENABLE_CONSECUTIVE_LOSS_LIMIT !== 'false',
  maxConsecutiveLosses: Number(process.env.MAX_CONSECUTIVE_LOSSES || 5),
  useTickExecution: process.env.USE_TICK_EXECUTION === 'true',
  enableEodFlatten: process.env.ENABLE_EOD_FLATTEN === 'true',
  eodFlattenHourCt: Number(process.env.EOD_FLATTEN_HOUR_CT || 15),
  eodFlattenMinuteCt: Number(process.env.EOD_FLATTEN_MINUTE_CT || 50),
  pointValue: Number(process.env.POINT_VALUE || 2)
};

console.log('🔧 CONFIG:', CONFIG);
console.log(`📡 Using SYMBOL: "${CONFIG.symbol}"`);

if (!CONFIG.symbol) {
  console.warn('⚠️ SYMBOL is undefined in .env');
} else if (CONFIG.symbol.startsWith('@')) {
  console.error(`❌ Invalid TradeStation futures symbol: ${CONFIG.symbol}`);
  console.error('TradeStation API should use NQM26, not @NQM26. Update SYMBOL in .env.');
  process.exit(1);
} else {
  console.log(`✅ Symbol configured for TradeStation API: ${CONFIG.symbol}`);
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
  maxDailyLoss: CONFIG.maxDailyLoss,
  enableDailyLossLimit: CONFIG.enableDailyLossLimit,
  enableConsecutiveLossLimit: CONFIG.enableConsecutiveLossLimit,
  maxConsecutiveLosses: CONFIG.maxConsecutiveLosses
});

const positionManager = new PositionManager({
  config: CONFIG,
  tsApi,
  riskManager,
  tradeLogger
});

const notifier = new Notifier({
  pushoverUser: process.env.PUSHOVER_USER,
  pushoverToken: process.env.PUSHOVER_TOKEN
});

app.use('/api', createDashboardApi({
  config: CONFIG,
  tsApi,
  positionManager,
  riskManager,
  tradeLogger,
  strategy,
  getLiveBrokerPosition,
  getProfitLockState: () => ({
    enabled: PROFIT_LOCK_ENABLED,
    triggered: profitLockTriggered,
    maxSessionProfit: MAX_SESSION_PROFIT
  }),
  resetProfitLock: () => {
    profitLockTriggered = false;
  }
}));

// ================= STREAM STATE =================
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

async function checkProfitLock({ realizedPnL = 0, unrealizedPnL = 0 }) {
  if (!PROFIT_LOCK_ENABLED) return false;

  const realized = Number(realizedPnL || 0);
  const unrealized = Number(unrealizedPnL || 0);
  const totalProfit = realized + unrealized;

  if (totalProfit < MAX_SESSION_PROFIT) return false;

  if (!profitLockTriggered) {
    profitLockTriggered = true;

    console.log(
      `🟢 PROFIT LOCK HIT | Realized=${realized.toFixed(2)} Unrealized=${unrealized.toFixed(2)} Total=${totalProfit.toFixed(2)} Limit=${MAX_SESSION_PROFIT.toFixed(2)}`
    );

    riskManager.disable('PROFIT_LOCK');

    await sendPushover({
      title: 'MNQ Bot Profit Lock Hit',
      message: `Profit lock hit at $${totalProfit.toFixed(2)}. Trading has been paused. Open the dashboard to decide whether to continue trading.`,
      priority: 1,
      url: DASHBOARD_URL,
      urlTitle: 'Open MNQ Dashboard'
    });
  }

  if (positionManager.hasPosition()) {
    await positionManager.flattenBrokerPosition('PROFIT_LOCK');
  }

  return true;
}

async function updateBrokerPnLAndEnforceRisk() {
  try {
    const balances = await tsApi.getAccountBalances(CONFIG.accountId);
    const balance = balances?.Balances?.[0] || balances?.Balances || balances || {};
    const detail = balance?.BalanceDetail || {};
    const currency = balance?.CurrencyDetails?.[0] || {};

    const brokerDailyPnL = Number(
      balance?.TodaysProfitLoss ??
      balance?.DayTradeProfitLoss ??
      balance?.DailyProfitLoss ??
      detail?.TodaysProfitLoss ??
      detail?.DayTradeProfitLoss ??
      riskManager.dailyPnL ??
      0
    );

    const brokerRealizedPnL = Number(
      detail?.RealizedProfitLoss ??
      currency?.RealizedProfitLoss ??
      balance?.RealizedProfitLoss ??
      0
    );

    const brokerUnrealizedPnL = Number(
      detail?.UnrealizedProfitLoss ??
      currency?.UnrealizedProfitLoss ??
      balance?.UnrealizedProfitLoss ??
      balance?.OpenTradeProfitLoss ??
      0
    );

    const profitLocked = await checkProfitLock({
      realizedPnL: brokerRealizedPnL,
      unrealizedPnL: brokerUnrealizedPnL
    });

    if (profitLocked) {
      return;
    }

    const breached = riskManager.updateBrokerPnL({
      dailyPnL: brokerDailyPnL,
      realizedPnL: brokerRealizedPnL,
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

    if (!livePos) return;

    const brokerQty = Number(livePos.Quantity || 0);
    const brokerSide = brokerQty > 0 ? 'LONG' : 'SHORT';
    const absBrokerQty = Math.abs(brokerQty);

    // If bot has no internal position but broker does, adopt it.
    // This covers manual entries or bot restart while a position is open.
    if (!positionManager.hasPosition()) {
      console.log(`🔄 No local position but broker has ${brokerSide} ${absBrokerQty} — adopting broker position`);
      positionManager.syncFromBrokerPosition(livePos);
      return;
    }

    const localPosition = positionManager.getPosition();
    const localSide = localPosition?.side;
    const localOpenQty = typeof positionManager.getOpenQty === 'function'
      ? positionManager.getOpenQty()
      : Math.abs(
          (localPosition?.legs || [])
            .filter((leg) => !leg.closed)
            .reduce((sum, leg) => sum + Number(leg.qty || 0), 0)
        );

    // If side changed, broker and bot are out of sync. Re-adopt broker state.
    if (localSide !== brokerSide) {
      console.log(
        `⚠️ Broker side mismatch | Local=${localSide} Broker=${brokerSide}. Re-syncing from broker.`
      );
      positionManager.syncFromBrokerPosition(livePos);
      return;
    }

    // If broker qty matches remaining open internal legs, preserve the current
    // leg/runner state, but still allow the broker average fill price to sync.
    if (absBrokerQty === localOpenQty) {
      positionManager.syncFromBrokerPosition(livePos);
      return;
    }

    // If broker qty is lower than local qty, mark closed legs without recreating full position.
    if (absBrokerQty < localOpenQty) {
      console.log(
        `🔄 Broker qty reduced | LocalOpenQty=${localOpenQty} BrokerQty=${absBrokerQty}. Preserving runner state.`
      );

      if (typeof positionManager.reconcileOpenQty === 'function') {
        positionManager.reconcileOpenQty(absBrokerQty, 'BROKER_QTY_REDUCED');
      }

      return;
    }

    // If broker qty is higher than local qty, something manual happened.
    // Re-adopt to avoid under-managing risk.
    if (absBrokerQty > localOpenQty) {
      console.log(
        `⚠️ Broker qty greater than local | LocalOpenQty=${localOpenQty} BrokerQty=${absBrokerQty}. Re-syncing from broker.`
      );
      positionManager.syncFromBrokerPosition(livePos);
    }
  } catch (err) {
    console.error('⚠️ Broker reconciliation failed:', err.message);
  }
}

function getChicagoTimeParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);

  const lookup = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return {
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second)
  };
}

async function handleEodFlatten(closedBar) {
  const { hour, minute } = getChicagoTimeParts(closedBar.time);

  if (
    CONFIG.enableEodFlatten &&
    hour === CONFIG.eodFlattenHourCt &&
    minute >= CONFIG.eodFlattenMinuteCt &&
    positionManager.hasPosition()
  ) {
    console.log('⏰ EOD AUTO FLATTEN');

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

function logBarSync(closedBar) {
  const now = new Date();

  const barStart = closedBar.time;
  const barEnd = new Date(barStart.getTime() + 60_000);
  const formingStart = new Date(Math.floor(now.getTime() / 60000) * 60000);

  const minutesBehindForming = Math.round(
    (formingStart.getTime() - barStart.getTime()) / 60000
  );

  const barStartCt = barStart.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour12: true
  });

  const barEndCt = barEnd.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour12: true
  });

  const formingCt = formingStart.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour12: true
  });

  const nowCt = now.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour12: true
  });

  const syncStatus =
    minutesBehindForming === 0
      ? '✅ SYNCED: bar close/end time matches current forming bar start'
      : minutesBehindForming === 1
        ? '✅ SYNCED: prior start-labeled closed bar is directly behind forming bar'
        : `⚠️ CHECK: bar label is ${minutesBehindForming} minute(s) behind forming bar`;

  console.log(
    `🧭 BAR SYNC | ${syncStatus} | InterpretedAsClose=${barStartCt} | Covers=${barStartCt}→${barEndCt} | FormingNow=${formingCt} | ProcessedAt=${nowCt}`
  );
}

// ================= TICK/BAR HANDLING =================
async function onTick(tick) {
  if (!tick || !Number.isFinite(tick.price)) return;
  positionManager.lastKnownPrice = tick.price;

  if (CONFIG.useTickExecution) {
    try {
      await positionManager.checkExitsByPrice({
        price: tick.price,
        time: tick.time,
        source: 'TICK'
      });
    } catch (err) {
      logSafeError('Tick exit check failed', err);
    }
  }
}

async function handleStreamBar(tick) {
  if (!tick || !(tick.time instanceof Date) || !Number.isFinite(tick.close)) return;

  positionManager.lastKnownPrice = tick.close;

  const minuteTs = Math.floor(tick.time.getTime() / 60000) * 60000;

  // TradeStation streamBars appears to deliver completed 1-minute bars.
  // Process each completed bar immediately and ignore duplicate updates for the same minute.
  if (minuteTs === lastFinalizedMinute) {
    await onTick({
      price: tick.close,
      time: tick.time
    });

    return;
  }

  lastFinalizedMinute = minuteTs;

  const closedBar = {
    time: new Date(minuteTs),
    open: tick.open,
    high: tick.high,
    low: tick.low,
    close: tick.close,
    volume: tick.volume || 0
  };

  riskManager.resetIfNewDay(closedBar.time);

  let eodFlattened = false;

  try {
    eodFlattened = await handleEodFlatten(closedBar);
  } catch (err) {
    logSafeError('EOD flatten failed', err);
  }

  if (eodFlattened) {
    return;
  }

  printBar(closedBar);
  logBarSync(closedBar);

  strategy.addBar(closedBar);

  await updateBrokerPnLAndEnforceRisk();
  await reconcileBrokerPosition();

  // Bar-based exits are only used when tick execution is disabled.
  // With USE_TICK_EXECUTION=true, quote/tick exits manage TP/SL intrabar.
  if (!CONFIG.useTickExecution) {
    try {
      await positionManager.checkExitsByBar(closedBar);
    } catch (err) {
      logSafeError('Bar exit check failed', err);
    }
  }

  if (!riskManager.canTrade()) {
    console.log('🛑 Trading disabled for session');
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
      try {
        await positionManager.flipPosition({
          newSide: signal.type,
          price: closedBar.close,
          time: closedBar.time
        });
      } catch (err) {
        logSafeError('Flip position failed — broker state not changed locally by index_sim.js', err);
      }

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

      try {
        await positionManager.enterTargetPosition({
          side: signal.type,
          entryPrice: closedBar.close,
          entryTime: closedBar.time
        });
      } catch (err) {
        logSafeError('Entry order failed — bot will stay flat unless broker confirms otherwise', err);
      }
    } else {
      console.log('⏭ No entry');
    }
  }
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
// ================= DASHBOARD ROUTE =================

app.get('/dashboard', (req, res) => {

  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));

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
    const authUrl = tsApi.getAuthorizationUrl();

    console.log('\n🔐 AUTHORIZATION REQUIRED\n');
    console.log('Open this URL in your browser:\n');
    console.log(authUrl);

    await notifier.sendAuthRequired(authUrl);

    return;
  }

  console.log('🚀 Starting MNQ Bot...');

  await notifier.sendBotStarted({
    symbol: CONFIG.symbol,
    accountId: CONFIG.accountId,
    mode: process.env.BOT_MODE || 'SIM'
  });

  let hist;

  try {
    hist = await tsApi.getHistoricalBars(CONFIG.symbol, 1, 'Minute', 300);
  } catch (err) {
    logSafeError('Failed to load historical bars — bot will not start stream', err);
    return;
  }

  (hist.Bars || []).forEach((b) =>
    strategy.addBar({
      time: new Date(b.TimeStamp),
      open: +b.Open,
      high: +b.High,
      low: +b.Low,
      close: +b.Close,
      volume: +b.TotalVolume
    })
  );

  try {
    await tsApi.streamBars(CONFIG.symbol, 1, async (bar) => {
      try {
        await handleStreamBar(bar);
      } catch (err) {
        logSafeError('Stream bar handler failed — continuing stream', err);
      }
    });
  } catch (err) {
    logSafeError('Bar stream failed', err);
    return;
  }

  if (CONFIG.useTickExecution) {
    if (typeof tsApi.streamQuotes !== 'function') {
      console.warn(
        '⚠️ USE_TICK_EXECUTION=true but tsApi.streamQuotes() is not available. TP/SL will use bar high/low backup only.'
      );
      return;
    }

    console.log('✅ True quote/tick execution enabled for TP/SL');

    try {
      await tsApi.streamQuotes(CONFIG.symbol, async (quote) => {
        try {
          await onTick({
            price: quote.price,
            time: quote.time,
            bid: quote.bid,
            ask: quote.ask,
            last: quote.last
          });
        } catch (err) {
          logSafeError('Quote handler failed — continuing stream', err);
        }
      });
    } catch (err) {
      logSafeError('Quote stream failed', err);
    }
  } else {
    console.log('ℹ️ USE_TICK_EXECUTION=false — TP/SL will use bar high/low backup only');
  }
}

// ================= SERVER =================
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);

  try {
    await startBot();
  } catch (err) {
    logSafeError('Bot startup failed', err);
  }
});