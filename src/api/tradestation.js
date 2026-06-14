/**
 * ============================================================
 * TradeStation API Integration Service
 * ============================================================
 *
 * Responsibilities:
 *   1. OAuth (authorization + refresh)
 *   2. Token persistence
 *   3. REST requests
 *   4. Market data (historical + streaming)
 *   5. Order execution
 *   6. Broker state queries (positions)
 * ============================================================
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '../../ts_tokens.json');

class TradeStationAPI {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.secretKey = config.secretKey;
    this.redirectUri = config.redirectUri;
    this.baseUrl = config.baseUrl || 'https://sim-api.tradestation.com/v3';

    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;

    this.loadTokens();
  }

  setBaseUrl(baseUrl) {
    if (!baseUrl) return;
    this.baseUrl = baseUrl;
  }

  // ============================================================
  // TOKEN MANAGEMENT
  // ============================================================
  loadTokens() {
    if (!fs.existsSync(TOKEN_PATH)) return;

    try {
      const saved = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      this.accessToken = saved.accessToken;
      this.refreshToken = saved.refreshToken;
      this.tokenExpiry = saved.tokenExpiry;
      console.log('🔐 Loaded saved TradeStation OAuth tokens');
    } catch {
      console.log('⚠️ Failed to load saved tokens');
    }
  }

  saveTokens() {
    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify(
        {
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          tokenExpiry: this.tokenExpiry
        },
        null,
        2
      )
    );
  }

  // ============================================================
  // OAUTH FLOW
  // ============================================================
  getAuthorizationUrl() {
    const scopes = 'openid offline_access MarketData ReadAccount Trade';
    return `https://signin.tradestation.com/authorize?response_type=code&client_id=${this.apiKey}&redirect_uri=${encodeURIComponent(
      this.redirectUri
    )}&audience=https://api.tradestation.com&scope=${encodeURIComponent(scopes)}`;
  }

  async exchangeAuthorizationCode(code) {
    const res = await axios.post(
      'https://signin.tradestation.com/oauth/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.apiKey,
        client_secret: this.secretKey,
        code,
        redirect_uri: this.redirectUri
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    this.accessToken = res.data.access_token;
    this.refreshToken = res.data.refresh_token;
    this.tokenExpiry = Date.now() + res.data.expires_in * 1000;

    this.saveTokens();

    console.log('✅ OAuth exchange successful');
  }

  async refreshAccessToken() {
    const res = await axios.post(
      'https://signin.tradestation.com/oauth/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.apiKey,
        client_secret: this.secretKey,
        refresh_token: this.refreshToken
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    this.accessToken = res.data.access_token;
    this.tokenExpiry = Date.now() + res.data.expires_in * 1000;

    this.saveTokens();
    console.log('🔄 Token refreshed');
  }

  // ============================================================
  // TOKEN VALIDATION
  // ============================================================
  async ensureValidToken() {
    if (!this.accessToken) {
      throw new Error('Not authenticated');
    }

    // Refresh only if token expires within 60 seconds
    if (
      !this.tokenExpiry ||
      Date.now() >= Number(this.tokenExpiry) - 60_000
    ) {
      await this.refreshAccessToken();
    }
  }

  // ============================================================
  // CORE REST REQUEST HELPER
  // ============================================================
  async makeRequest(method, endpoint, data) {
    await this.ensureValidToken();

    const res = await axios({
      method,
      url: `${this.baseUrl}${endpoint}`,
      headers: { Authorization: `Bearer ${this.accessToken}` },
      data
    });

    return res.data;
  }
  // ============================================================
  // MARKET DATA (HISTORICAL)
  // ============================================================
  async getHistoricalBars(symbol, interval, unit, barsBack) {
    return this.makeRequest(
      'GET',
      `/marketdata/barcharts/${symbol}?interval=${interval}&unit=${unit}&barsback=${barsBack}`
    );
  }

  // ============================================================
  // MARKET DATA (STREAMING)
  // ============================================================
  async streamBars(symbol, interval, onBar) {
    await this.ensureValidToken();

    const connect = async () => {
      try {
        await this.ensureValidToken();

        const url = `${this.baseUrl}/marketdata/stream/barcharts/${symbol}?interval=${interval}&unit=Minute`;

        const res = await axios({
          url,
          method: 'GET',
          responseType: 'stream',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'text/event-stream'
          },
          timeout: 0
        });

        console.log(`✅ Bar stream connected for ${symbol}`);

        let buffer = '';
        let currentBar = null;
        let lastEmittedMinute = null;

        const normalizeBar = (b) => {
          const time = new Date(b.TimeStamp);
          const minute = Math.floor(time.getTime() / 60000) * 60000;

          return {
            minute,
            time: new Date(minute),
            open: Number(b.Open),
            high: Number(b.High),
            low: Number(b.Low),
            close: Number(b.Close),
            volume: Number(b.TotalVolume || b.Volume || 0),
            barStatus: b.BarStatus,
            rawTimeStamp: b.TimeStamp
          };
        };

        const emitCompletedBar = (bar) => {
          if (!bar || bar.minute === lastEmittedMinute) return;
          if (!Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) return;

          lastEmittedMinute = bar.minute;

          onBar({
            time: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume || 0,
            barStatus: bar.barStatus || 'FinalizedByRollover',
            rawTimeStamp: bar.rawTimeStamp
          });
        };

        res.data.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;

            const jsonStr = line.startsWith('data:')
              ? line.replace('data:', '').trim()
              : line.trim();

            if (
              !jsonStr ||
              jsonStr === '[Heartbeat]' ||
              jsonStr === 'Heartbeat' ||
              jsonStr.startsWith('event:')
            ) {
              continue;
            }

            try {
              const b = JSON.parse(jsonStr);

              if (!b || !b.TimeStamp) continue;

              const nextBar = normalizeBar(b);

              if (!currentBar) {
                currentBar = nextBar;

                if (nextBar.barStatus === 'Closed') {
                  emitCompletedBar(nextBar);
                  currentBar = null;
                }

                continue;
              }

              if (nextBar.minute === currentBar.minute) {
                currentBar = {
                  ...currentBar,
                  high: Math.max(currentBar.high, nextBar.high),
                  low: Math.min(currentBar.low, nextBar.low),
                  close: nextBar.close,
                  volume: Math.max(currentBar.volume || 0, nextBar.volume || 0),
                  barStatus: nextBar.barStatus,
                  rawTimeStamp: nextBar.rawTimeStamp
                };

                if (nextBar.barStatus === 'Closed') {
                  emitCompletedBar(currentBar);
                  currentBar = null;
                }

                continue;
              }

              // A new minute has started. Finalize the prior minute immediately from the latest streamed values
              // instead of waiting for a potentially delayed TradeStation Closed event.
              emitCompletedBar(currentBar);
              currentBar = nextBar;

              if (nextBar.barStatus === 'Closed') {
                emitCompletedBar(nextBar);
                currentBar = null;
              }
            } catch {
              // Ignore malformed stream event
            }
          }
        });

        res.data.on('end', () => {
          console.log(`⚠️ Bar stream ended for ${symbol}. Reconnecting in 5 seconds...`);
          setTimeout(connect, 5000);
        });

        res.data.on('error', (err) => {
          console.error(`⚠️ Bar stream error for ${symbol}:`, err.message);
          setTimeout(connect, 5000);
        });
      } catch (err) {
        console.error(`⚠️ Bar stream connection failed for ${symbol}:`, err.message);

        try {
          await this.ensureValidToken();
        } catch {}

        setTimeout(connect, 5000);
      }
    };

    connect();
  }
  // ============================================================
  // MARKET DATA (STREAMING QUOTES / TICKS)
  // ============================================================
  async streamQuotes(symbol, onQuote) {
    await this.ensureValidToken();

    const connect = async () => {
      try {
        await this.ensureValidToken();

        const url = `${this.baseUrl}/marketdata/stream/quotes/${symbol}`;

        const res = await axios({
          url,
          method: 'GET',
          responseType: 'stream',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'text/event-stream'
          },
          timeout: 0
        });

        console.log(`✅ Quote stream connected for ${symbol}`);

        let buffer = '';

        res.data.on('data', (chunk) => {
          buffer += chunk.toString();

          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;

            const jsonStr = line.startsWith('data:')
              ? line.replace('data:', '').trim()
              : line.trim();

            if (
              !jsonStr ||
              jsonStr === '[Heartbeat]' ||
              jsonStr === 'Heartbeat' ||
              jsonStr.startsWith('event:')
            ) {
              continue;
            }

            try {
              const q = JSON.parse(jsonStr);

              // TradeStation quote payloads can vary by asset/feed.
              // Prefer Last, then fall back to midpoint/bid/ask.
              const bid = Number(q.Bid ?? q.BidPrice);
              const ask = Number(q.Ask ?? q.AskPrice);
              const last = Number(
                q.Last ??
                q.LastPrice ??
                q.TradePrice ??
                q.Close
              );

              let price = last;

              if (!Number.isFinite(price)) {
                if (Number.isFinite(bid) && Number.isFinite(ask)) {
                  price = (bid + ask) / 2;
                } else if (Number.isFinite(bid)) {
                  price = bid;
                } else if (Number.isFinite(ask)) {
                  price = ask;
                }
              }

              if (!Number.isFinite(price)) {
                continue;
              }

              onQuote({
                symbol: q.Symbol || symbol,
                time: q.TimeStamp ? new Date(q.TimeStamp) : new Date(),
                price,
                bid: Number.isFinite(bid) ? bid : null,
                ask: Number.isFinite(ask) ? ask : null,
                last: Number.isFinite(last) ? last : null,
                raw: q
              });
            } catch (err) {
              // Do not kill stream on one malformed event
            }
          }
        });

        res.data.on('end', () => {
          console.log(`⚠️ Quote stream ended for ${symbol}. Reconnecting in 5 seconds...`);
          setTimeout(connect, 5000);
        });

        res.data.on('error', (err) => {
          console.error(`⚠️ Quote stream error for ${symbol}:`, err.message);
          setTimeout(connect, 5000);
        });
      } catch (err) {
        console.error(`⚠️ Quote stream connection failed for ${symbol}:`, err.message);

        // Token may have expired while streaming.
        try {
          await this.ensureValidToken();
        } catch {}

        setTimeout(connect, 5000);
      }
    };

    connect();
  }
  // ============================================================
  // ORDER EXECUTION
  // ============================================================
  async placeMarketOrder(accountId, symbol, qty, side) {
    return this.makeRequest('POST', '/orderexecution/orders', {
      AccountID: accountId,
      Symbol: symbol,
      Quantity: String(qty),
      OrderType: 'Market',
      TradeAction: side === 'LONG' ? 'BUY' : 'SELL',
      TimeInForce: { Duration: 'DAY' }
    });
  }
  // ============================================================
  // BROKER STATE (POSITIONS)
  // ============================================================

  async getOpenPositions(accountId) {
    return this.makeRequest(
      'GET',
      `/brokerage/accounts/${accountId}/positions`
    );
  }

  // ============================================================
  // BROKER STATE (BALANCES / PnL)
  // ============================================================

  async getAccountBalances(accountId) {
    return this.makeRequest(
      'GET',
      `/brokerage/accounts/${accountId}/balances`
    );
  }

  // ============================================================
  // BROKER SNAPSHOT (AUTHORITATIVE STATE)
  // ============================================================

  async getBrokerSnapshot(accountId, symbol = null) {
    try {
      const [positionsRes, balancesRes] = await Promise.all([
        this.getOpenPositions(accountId),
        this.getAccountBalances(accountId)
      ]);

      const positions = positionsRes?.Positions || [];
      const balances = balancesRes?.Balances || [];

      let brokerPosition = null;

      if (symbol) {
        brokerPosition = positions.find(
          (p) =>
            p.Symbol === symbol ||
            p.Symbol?.replace('@', '') === symbol?.replace('@', '')
        );
      }

      const qty = Number(brokerPosition?.Quantity || 0);

      return {
        timestamp: new Date().toISOString(),
        symbol,
        rawPositions: positions,
        rawBalances: balances,
        brokerPosition,
        qty,
        side:
          qty > 0
            ? 'LONG'
            : qty < 0
              ? 'SHORT'
              : 'FLAT',
        avgPrice: brokerPosition?.AveragePrice
          ? Number(brokerPosition.AveragePrice)
          : null,
        unrealizedPnL:
          brokerPosition?.UnrealizedProfitLoss != null
            ? Number(brokerPosition.UnrealizedProfitLoss)
            : null,
        realizedPnL:
          balances[0]?.RealizedProfitLoss != null
            ? Number(balances[0].RealizedProfitLoss)
            : null,
        todaysPnL:
          balances[0]?.TodaysProfitLoss != null
            ? Number(balances[0].TodaysProfitLoss)
            : null
      };
    } catch (err) {
      console.error('❌ Failed to fetch broker snapshot:', err.message);

      return {
        timestamp: new Date().toISOString(),
        symbol,
        rawPositions: [],
        rawBalances: [],
        brokerPosition: null,
        qty: 0,
        side: 'FLAT',
        avgPrice: null,
        unrealizedPnL: null,
        realizedPnL: null,
        todaysPnL: null,
        error: err.message
      };
    }
  }
}

module.exports = TradeStationAPI;
