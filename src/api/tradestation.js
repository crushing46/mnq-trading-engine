/**
 * TradeStation API Integration Service
 * Handles:
 * - OAuth
 * - Token persistence
 * - REST requests
 * - Market data streaming
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

  async getHistoricalBars(symbol, interval, unit, barsBack) {
    return this.makeRequest(
      'GET',
      `/marketdata/barcharts/${symbol}?interval=${interval}&unit=${unit}&barsback=${barsBack}`
    );
  }

  async streamBars(symbol, interval, onBar) {
    await this.ensureValidToken();

    const connect = async () => {
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

      let buffer = '';

      res.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;

          let jsonStr = line.startsWith('data:')
            ? line.replace('data:', '').trim()
            : line;

          try {
            const b = JSON.parse(jsonStr);

            if (b.BarStatus !== 'Closed') continue;

            onBar({
              time: new Date(b.TimeStamp),
              open: +b.Open,
              high: +b.High,
              low: +b.Low,
              close: +b.Close,
              volume: +b.TotalVolume || 0,
              barStatus: b.BarStatus
            });
          } catch {}
        }
      });

      res.data.on('end', () => setTimeout(connect, 5000));
      res.data.on('error', () => setTimeout(connect, 5000));
    };

    connect();
  }

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
}

module.exports = TradeStationAPI;