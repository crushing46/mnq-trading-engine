module.exports = {
  apps: [
    {
      name: 'mnq-bot',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
        ENABLE_TRADING: 'true'
      }
    }
  ]
};