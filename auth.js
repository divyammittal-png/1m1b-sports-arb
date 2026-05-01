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
    const payload = [
      `username=${encodeURIComponent(user)}`,
      `password=${encodeURIComponent(pass)}`,
      'redirectMethod=POST',
      'product=home.betfair.com',
      'website=home.betfair.com',
      'submitForm=Y',
    ].join('&');

    const opts = {
      hostname: 'identitysso.betfair.com',
      path:     '/api/login',
      method:   'POST',
      headers:  {
        'X-Application':  appKey,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'User-Agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(`[AUTH] HTTP ${res.statusCode} from Betfair`);
        console.log(`[AUTH] Raw response: ${body.slice(0, 500)}`);
        try {
          const j = JSON.parse(body);
          console.log(`[AUTH] status="${j.status}" error="${j.error || ''}" token=${j.token ? j.token.slice(0,8) + '…' : 'NONE'}`);
          if (j.status === 'SUCCESS' && j.token) {
            session.token      = j.token;
            session.loggedInAt = Date.now();
            console.log('[AUTH] Betfair login OK');
            resolve(true);
          } else {
            console.error('[AUTH] Login failed — status:', j.status, '| error:', j.error);
            console.error('[AUTH] Common errors: INVALID_USERNAME_OR_PASSWORD, ACCOUNT_LOCKED, PENDING_AUTH');
            resolve(false);
          }
        } catch (e) {
          console.error('[AUTH] JSON parse error:', e.message);
          console.error('[AUTH] Response was not JSON — possible network block or redirect');
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
