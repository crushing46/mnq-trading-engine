const axios = require('axios');

class Notifier {
  constructor({ pushoverUser, pushoverToken }) {
    this.pushoverUser = pushoverUser;
    this.pushoverToken = pushoverToken;
  }

  isEnabled() {
    return Boolean(this.pushoverUser && this.pushoverToken);
  }

  async send({ title, message, priority = 0, url = null, urlTitle = null }) {
    if (!this.isEnabled()) {
      console.warn('⚠️ Pushover not configured. Skipping notification.');
      return false;
    }

    try {
      const payload = {
        token: this.pushoverToken,
        user: this.pushoverUser,
        title,
        message,
        priority
      };

      if (url) {
        payload.url = url;
        payload.url_title = urlTitle || 'Open Link';
      }

      await axios.post('https://api.pushover.net/1/messages.json', payload, {
        timeout: 10000
      });

      console.log(`📲 Pushover sent | ${title}`);
      return true;
    } catch (err) {
      console.error('⚠️ Failed to send Pushover notification:', err.message);
      return false;
    }
  }

  async sendAuthRequired(authUrl) {
    return this.send({
      title: 'MNQ Bot Auth Required',
      message: 'TradeStation authorization is required. Tap to re-authenticate the bot.',
      priority: 1,
      url: authUrl,
      urlTitle: 'Authorize TradeStation'
    });
  }

  async sendBotStarted({ symbol, accountId, mode }) {
    return this.send({
      title: 'MNQ Bot Started',
      message: `Bot started. Mode=${mode || 'SIM'} Symbol=${symbol} Account=${accountId}`,
      priority: 0
    });
  }

  async sendBotError({ title = 'MNQ Bot Error', message }) {
    return this.send({
      title,
      message,
      priority: 1
    });
  }
}

module.exports = Notifier;