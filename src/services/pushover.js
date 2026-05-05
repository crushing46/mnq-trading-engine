const axios = require('axios');

async function sendPushover({ title, message, priority = 0, url, urlTitle }) {
  if (process.env.PUSHOVER_ENABLED !== 'true') return;

  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;

  if (!token || !user) {
    console.warn('⚠️ Pushover enabled but PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY is missing.');
    return;
  }

  try {
    await axios.post('https://api.pushover.net/1/messages.json', {
      token,
      user,
      title,
      message,
      priority,
      url,
      url_title: urlTitle
    });

    console.log(`📲 Pushover sent: ${title}`);
  } catch (err) {
    console.error('❌ Failed to send Pushover:', err.response?.data || err.message);
  }
}

module.exports = {
  sendPushover
};