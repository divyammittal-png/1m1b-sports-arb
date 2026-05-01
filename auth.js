'use strict';
const https = require('https');

const session = { token: null, loggedInAt: null };

async function login() {
  const appKey = process.env.BETFAIR_APP_KEY;
  const user   = process.env.BETFAIR_USERNAME;
  const pass   = process.env.BETFAIR_PASSWORD;

  if (!appKey || !user || !pass) {
    console.warn('[AUTH] Missing credentials — set BETFAIR_APP_KEY, BETFAIR_USERNAME, BETFAIR_PASSWORD');
    return false;
  }

  return new Promise(resolve => {
    const payload = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    const opts = {
      hostname: 'identitysso.betfair.com',
      path:     '/api/login',
      method:   'POST',
      headers:  {
        'X-Application':  appKey,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.status === 'SUCCESS' && j.token) {
            session.token      = j.token;
            session.loggedInAt = Date.now();
            console.log('[AUTH] Betfair login OK');
            resolve(true);
          } else {
            console.error('[AUTH] Login failed:', j.error || j.status);
            resolve(false);
          }
        } catch (e) {
          console.error('[AUTH] Parse error:', e.message, '| body:', body.slice(0, 200));
          resolve(false);
        }
      });
    });

    req.on('error', e => { console.error('[AUTH] Request error:', e.message); resolve(false); });
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

function getToken()   { return session.token; }
function isLoggedIn() { return !!session.token; }

// Re-authenticate every 8 hours (Betfair sessions expire after ~12h)
function scheduleRefresh() {
  setInterval(async () => {
    console.log('[AUTH] Session refresh...');
    await login();
  }, 8 * 3600_000);
}

module.exports = { login, getToken, isLoggedIn, scheduleRefresh };
