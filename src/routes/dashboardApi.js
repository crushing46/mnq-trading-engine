function requireApiKey(req, res, next) {
  const providedKey =
    req.headers['x-bot-api-key'] ||
    req.query.apiKey;

  if (!process.env.BOT_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'BOT_API_KEY is not configured on server'
    });
  }

  if (providedKey !== process.env.BOT_API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  next();
}

function requireControlToken(req, res, next) {
  const providedToken =
    req.headers['x-bot-control-token'] ||
    req.body?.controlToken ||
    req.query.controlToken;

  if (!process.env.BOT_CONTROL_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: 'BOT_CONTROL_TOKEN is not configured on server'
    });
  }

  if (providedToken !== process.env.BOT_CONTROL_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized control action'
    });
  }

  next();
}

function createDashboardApi({
  config,
  tsApi,
  positionManager,
  riskManager,
  tradeLogger,
  strategy,
  getLiveBrokerPosition,
  toggleProfitLock,
  getProfitLockState
}) {
  const express = require('express');
  const router = express.Router();

  router.use(requireApiKey);

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      status: 'alive',
      timestamp: new Date().toISOString(),
      mode: process.env.BOT_MODE || 'SIM',
      symbol: config.symbol,
      accountId: config.accountId,
      enableTrading: config.enableTrading,
      useTickExecution: config.useTickExecution
    });
  });

  router.get('/live', (req, res) => {
    try {
      const localPosition = typeof positionManager.getPosition === 'function'
        ? positionManager.getPosition()
        : null;

      const riskState = typeof riskManager.getState === 'function'
        ? riskManager.getState()
        : null;

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        bot: {
          mode: process.env.BOT_MODE || 'SIM',
          symbol: config.symbol,
          accountId: config.accountId,
          enableTrading: config.enableTrading,
          useTickExecution: config.useTickExecution,
          trailRunner: config.trailRunner,
          trailDistance: config.trailDistance,
          tp: config.tp,
          sl: config.sl,
          beTriggerPoints: config.beTriggerPoints,
          beOffsetPoints: config.beOffsetPoints,
          qty: config.qty
        },
        market: {
          lastKnownPrice: positionManager.lastKnownPrice ?? null
        },
        localPosition,
        risk: riskState,
        profitLock:
          typeof getProfitLockState === 'function'
            ? getProfitLockState()
            : null
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  });

  router.get('/status', async (req, res) => {
    try {
      const localPosition = typeof positionManager.getPosition === 'function'
        ? positionManager.getPosition()
        : null;

      const riskState = typeof riskManager.getState === 'function'
        ? riskManager.getState()
        : null;

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        bot: {
          mode: process.env.BOT_MODE || 'SIM',
          symbol: config.symbol,
          accountId: config.accountId,
          enableTrading: config.enableTrading,
          useTickExecution: config.useTickExecution,
          trailRunner: config.trailRunner,
          trailDistance: config.trailDistance,
          tp: config.tp,
          sl: config.sl,
          beTriggerPoints: config.beTriggerPoints,
          beOffsetPoints: config.beOffsetPoints,
          qty: config.qty
        },
        localPosition,
        risk: riskState,
        profitLock:
          typeof getProfitLockState === 'function'
            ? getProfitLockState()
            : null
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  });

  router.get('/positions', async (req, res) => {
    try {
      const brokerData = await tsApi.getOpenPositions(config.accountId);

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        accountId: config.accountId,
        data: brokerData
      });
    } catch (err) {
      res.status(err?.response?.status || 500).json({
        ok: false,
        error: err.message,
        response: err?.response?.data
      });
    }
  });

  router.get('/balances', async (req, res) => {
    try {
      const balances = await tsApi.getAccountBalances(config.accountId);

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        accountId: config.accountId,
        data: balances
      });
    } catch (err) {
      res.status(err?.response?.status || 500).json({
        ok: false,
        error: err.message,
        response: err?.response?.data
      });
    }
  });

  router.get('/broker-position', async (req, res) => {
    try {
      const livePosition = await getLiveBrokerPosition();

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        symbol: config.symbol,
        accountId: config.accountId,
        livePosition: livePosition || null
      });
    } catch (err) {
      res.status(err?.response?.status || 500).json({
        ok: false,
        error: err.message,
        response: err?.response?.data
      });
    }
  });

  router.post('/flatten', requireControlToken, async (req, res) => {
    try {
      if (typeof positionManager.flattenBrokerPosition !== 'function') {
        return res.status(500).json({
          ok: false,
          error: 'flattenBrokerPosition is not available on positionManager'
        });
      }

      const livePositionBefore = await getLiveBrokerPosition();

      if (!livePositionBefore) {
        return res.json({
          ok: true,
          message: 'No open broker position detected. Already flat.',
          timestamp: new Date().toISOString()
        });
      }

      await positionManager.flattenBrokerPosition('DASHBOARD_FLATTEN');

      const livePositionAfter = await getLiveBrokerPosition();

      res.json({
        ok: true,
        message: 'Flatten request submitted.',
        timestamp: new Date().toISOString(),
        before: livePositionBefore,
        after: livePositionAfter || null
      });
    } catch (err) {
      res.status(err?.response?.status || 500).json({
        ok: false,
        error: err.message,
        response: err?.response?.data
      });
    }
  });

  router.post('/pause', requireControlToken, (req, res) => {
    try {
      if (typeof riskManager.disable === 'function') {
        riskManager.disable('DASHBOARD_PAUSE');
      }

      config.enableTrading = false;

      res.json({
        ok: true,
        message: 'Trading paused. New entries disabled.',
        timestamp: new Date().toISOString(),
        enableTrading: config.enableTrading
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  });

  router.post('/resume', requireControlToken, (req, res) => {
    try {
      if (typeof riskManager.enable === 'function') {
        riskManager.enable('DASHBOARD_RESUME');
      }

      config.enableTrading = true;

      res.json({
        ok: true,
        message: 'Trading resumed. New entries enabled.',
        timestamp: new Date().toISOString(),
        enableTrading: config.enableTrading
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  });

  router.post('/risk-limits', requireControlToken, (req, res) => {
    try {
      const rawDailyLossLimit = req.body?.dailyLossLimit;
      const rawConsecutiveLossLimit = req.body?.consecutiveLossLimit;

      const dailyLossLimit =
        rawDailyLossLimit === true ||
        rawDailyLossLimit === 'true';

      const consecutiveLossLimit =
        rawConsecutiveLossLimit === true ||
        rawConsecutiveLossLimit === 'true';

      if (typeof riskManager.setRiskLimitsEnabled !== 'function') {
        return res.status(500).json({
          ok: false,
          error: 'Risk manager does not support runtime risk limit updates.'
        });
      }

      const risk = riskManager.setRiskLimitsEnabled({
        dailyLossLimit,
        consecutiveLossLimit
      });

      res.json({
        ok: true,
        message: 'Risk limits updated.',
        timestamp: new Date().toISOString(),
        risk
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  });

  router.post('/toggle-profit-lock', requireControlToken, (req, res) => {
    try {
      const enabled =
        req.body.enabled === true ||
        req.body.enabled === 'true';

      if (typeof toggleProfitLock !== 'function') {
        return res.status(500).json({
          ok: false,
          error: 'toggleProfitLock is not available.'
        });
      }

      toggleProfitLock(enabled);

      res.json({
        ok: true,
        message: `Profit lock ${enabled ? 'enabled' : 'disabled'}.`,
        timestamp: new Date().toISOString(),
        enabled
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  });

  return router;
}

module.exports = createDashboardApi;