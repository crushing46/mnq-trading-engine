const fs = require('fs');

const DEFAULT_SIM_API_URL = 'https://sim-api.tradestation.com/v3';
const DEFAULT_LIVE_API_URL = 'https://api.tradestation.com/v3';

function normalizeMode(rawMode) {
  const mode = String(rawMode || 'SIM').trim().toUpperCase();
  return mode === 'LIVE' ? 'LIVE' : 'SIM';
}

function resolveTradingMode(env = process.env, preferredMode = env.BOT_MODE) {
  const mode = normalizeMode(preferredMode);
  const currentMode = normalizeMode(env.BOT_MODE);
  const simApiUrl =
    env.SIM_API_URL ||
    (currentMode === 'SIM' ? env.TS_API_BASE_URL : '') ||
    DEFAULT_SIM_API_URL;
  const liveApiUrl =
    env.LIVE_API_URL ||
    (currentMode === 'LIVE' ? env.TS_API_BASE_URL : '') ||
    DEFAULT_LIVE_API_URL;
  const simAccountId =
    env.SIM_ACCOUNT_ID ||
    (currentMode === 'SIM' ? env.ACCOUNT_ID : '') ||
    '';
  const liveAccountId =
    env.LIVE_ACCOUNT_ID ||
    (currentMode === 'LIVE' ? env.ACCOUNT_ID : '') ||
    '';

  return {
    mode,
    accountId: mode === 'LIVE' ? liveAccountId : simAccountId,
    baseUrl: mode === 'LIVE' ? liveApiUrl : simApiUrl,
    simAccountId,
    liveAccountId,
    simApiUrl,
    liveApiUrl
  };
}

function upsertEnvValue(source, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');

  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }

  const prefix = source.endsWith('\n') || source.length === 0 ? '' : '\n';
  return `${source}${prefix}${line}\n`;
}

function persistTradingMode(envPath, nextMode) {
  const mode = normalizeMode(nextMode);
  const current = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : '';

  const resolved = resolveTradingMode(process.env, mode);

  let updated = current;
  updated = upsertEnvValue(updated, 'BOT_MODE', resolved.mode);
  updated = upsertEnvValue(updated, 'TS_API_BASE_URL', resolved.baseUrl);
  updated = upsertEnvValue(updated, 'ACCOUNT_ID', resolved.accountId || '');

  fs.writeFileSync(envPath, updated);

  return resolved;
}

module.exports = {
  normalizeMode,
  resolveTradingMode,
  persistTradingMode
};
