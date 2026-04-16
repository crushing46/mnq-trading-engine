# MNQ Automated Trading System

Automated trading system for MNQ (Micro E-mini Nasdaq-100) futures using the **optimized EMA 13/34 + 50 EMA trend filter strategy**.

## Strategy Overview

**Entry Rules:**
- **LONG:** EMA 13 crosses above EMA 34 AND price closes above EMA 50
- **SHORT:** EMA 13 crosses below EMA 34 AND price closes below EMA 50

**Exit Rules (2-Contract System):**
- **Both Contracts:** TP = 25 points (100 ticks / $200) | SL = 18 points (72 ticks / $144)

**Backtest Performance (3 months):**
- Total Profit: $19,656
- Win Rate: 48.08%
- Profit Factor: 1.19
- Expected Monthly: ~$6,500

## Prerequisites

1. **Node.js** (v18+)
2. **TradeStation Account** with API access
3. **PostgreSQL** (optional, for trade logging)

## Quick Start

### 1. Install Dependencies

```bash
cd mnq-trading-system
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your TradeStation API credentials:

```bash
cp .env.example .env
```

Edit `.env`:
```
TS_API_KEY=your_api_key_here
TS_SECRET_KEY=your_secret_key_here
TS_REDIRECT_URI=http://localhost:3000/callback
```

### 3. Authenticate with TradeStation

Start the server:
```bash
npm start
```

The server will display an authorization URL. Open it in your browser to authenticate with TradeStation.

### 4. Start Trading

Once authenticated, you can start the trading system:

**Via API:**
```bash
curl -X POST http://localhost:3000/trading/start
```

**Via Dashboard:**
Open `http://localhost:3000/dashboard.html` in your browser

## Project Structure

```
mnq-trading-system/
├── src/
│   ├── index.js              # Main application
│   ├── services/
│   │   └── strategy.js       # EMA strategy logic
│   ├── api/
│   │   └── tradestation.js   # TradeStation API client
│   └── utils/
├── public/
│   └── dashboard.html        # Monitoring dashboard
├── .env.example              # Environment template
└── package.json
```

## API Endpoints

### Authentication
- `GET /auth/url` - Get TradeStation authorization URL
- `GET /callback` - OAuth callback (handled automatically)

### Trading Control
- `POST /trading/start` - Start automated trading
- `POST /trading/stop` - Stop trading
- `GET /trading/state` - Get current system state
- `POST /trading/reset-daily` - Reset daily P&L counter

### Account & Strategy
- `GET /account/info` - Get account balances and positions
- `POST /strategy/check` - Manually check for signals

## Configuration Options

Edit `.env` to customize:

```bash
# Trading Parameters
SYMBOL=MNQ
CONTRACT_SIZE=2
TP_POINTS=25
SL_POINTS=18

# Risk Management
MAX_DAILY_LOSS=500          # Stop trading if daily loss exceeds this
MAX_CONCURRENT_POSITIONS=2  # Maximum number of simultaneous positions

# Safety
ENABLE_TRADING=false        # Set to 'true' for live trading, 'false' for paper trading
```

## Safety Features

1. **Paper Trading Mode:** Set `ENABLE_TRADING=false` to test without real orders
2. **Daily Loss Limit:** Automatically stops trading if daily loss exceeds threshold
3. **Position Limits:** Prevents over-leveraging
4. **Token Auto-Refresh:** Handles OAuth token expiration automatically

## Monitoring

### Dashboard
Open `http://localhost:3000/dashboard.html` for real-time monitoring:
- Current positions
- P&L tracking
- Signal indicators
- Recent trades

### Console Logs
The system provides detailed console output:
```
🎯 LONG SIGNAL at 25950.50
   Time: 1/9/2026, 10:35:00 AM
   EMA13: 25945.23, EMA34: 25920.15, EMA50: 25900.50
   📝 Entry orders:
      C1: LONG 1 contract @ market
         TP: 25975.50 (+25 pts)
         SL: 25932.50 (-18 pts)
      C2: LONG 1 contract @ market
         TP: 25975.50 (+25 pts)
         SL: 25932.50 (-18 pts)
```

### API Monitoring
Use the `/trading/state` endpoint to programmatically monitor:
```bash
curl http://localhost:3000/trading/state
```

## Testing

### Backtest Mode
Test the strategy against historical data:
```bash
npm run test
```

### Paper Trading
Set `ENABLE_TRADING=false` in `.env` to run without placing real orders

## Risk Management

**Per Trade Risk:**
- Maximum loss per signal: $288 (2 contracts × $144)
- Expected profit per signal: $400 (2 contracts × $200)

**Position Sizing Recommendations:**
- Minimum account: $5,000 (1.7% risk per trade)
- Recommended: $10,000-$15,000 (1-2% risk)
- Conservative: $20,000+ (0.5-1% risk)

## Important Notes

### Trading Hours
- MNQ trades nearly 24/5 (Sunday 6pm - Friday 5pm ET)
- Consider adding time filters for optimal periods:
  - Avoid first 15 minutes after open (high volatility)
  - Avoid lunch hour (11:30am-1:30pm ET, low volume)

### Commission & Fees
- Account for ~$0.50-$1.50 per contract per side
- Typical cost per round trip: $2-$6 per contract
- Total per signal: $4-$12 (2 contracts)

### Slippage
- 1-minute MNQ is liquid but expect 1-2 tick slippage on market orders
- Use limit orders if you want better fills (requires more complex logic)

## Troubleshooting

### "Not authenticated" error
1. Make sure you've opened the authorization URL
2. Check that the callback was successful
3. Verify your API credentials in `.env`

### "No bars received" error
1. Check your TradeStation account has market data subscription
2. Verify the symbol is correct (MNQ for Micro Nasdaq)
3. Check TradeStation API status

### Orders not placing
1. Verify `ENABLE_TRADING=true` in `.env`
2. Check account has sufficient margin
3. Verify market is open
4. Check daily loss limit hasn't been hit

## Extending the System

### Add Time Filters
Edit `src/services/strategy.js` to add time-based logic:
```javascript
checkSignals() {
  const hour = new Date().getHours();
  
  // Avoid first 15 mins and lunch hour
  if (hour === 9 && minute < 45) return null;
  if (hour >= 11 && hour <= 13) return null;
  
  // ... rest of signal logic
}
```

### Add Trailing Stops
Modify exit logic in `src/services/strategy.js`:
```javascript
// Activate trailing stop after 20 points profit
if (profitPoints >= 20) {
  contract.stopLoss = currentPrice - 15; // Trail by 15 points
}
```

### Database Logging
Install PostgreSQL and create a trades table to log all activity:
```sql
CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  entry_time TIMESTAMP,
  exit_time TIMESTAMP,
  side VARCHAR(10),
  entry_price DECIMAL,
  exit_price DECIMAL,
  profit_points DECIMAL,
  profit_usd DECIMAL,
  exit_reason VARCHAR(10)
);
```

## Support & Development

### Backtesting Results
See `MNQ_Strategy_Analysis_Report.txt` for detailed backtest analysis

### Pine Script Version
See the Pine Script implementation in the report for TradingView testing

## Disclaimer

This software is for educational purposes only. Trading futures involves substantial risk of loss. Past performance does not guarantee future results. Always start with paper trading before going live.

## License

MIT License - Use at your own risk
