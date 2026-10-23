'use strict';
// PM2 configuration. Start with:  pm2 start ecosystem.config.js   (or run deploy/pm2-start.sh)
// Paths are taken from the folder this file is in, so it works unchanged on Windows, Linux and macOS.
// Override settings with environment variables when starting, e.g.  PORT=3090 pm2 start ecosystem.config.js
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'ulutan',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,          // must stay 1 - only one server may open data/db.json
      exec_mode: 'fork',     // never 'cluster' (same reason)
      autorestart: true,
      watch: false,          // do not restart when files change
      restart_delay: 2000,   // ms to wait before restarting after a crash
      max_restarts: 10,      // give up after 10 crashes within a minute
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3080,
        DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'), // db.json, sessions and backups
        TZ: process.env.TZ || 'Asia/Manila',                            // time zone used on printed reports
      },
    },
  ],
};
