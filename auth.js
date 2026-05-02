'use strict';
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CERT_PATH = path.join(__dirname, 'client-2048.crt');
const KEY_PATH  = path.join(__dirname, 'client-2048.key');

const session = { token: null, loggedInAt: null };

async function login() {
  const appKey = process.env.BETFAIR_APP_KEY;
  const user   = process.env.BETFAIR_USERNAME;
  const pass   = process.env.BETFAIR_PASSWORD;

  if (!appKey || !user || !pass) {
    console.warn('[AUTH] Missing credentials — set BETFAIR_APP_KEY, BETFAIR_USERNAME, BETFAIR_PASSWORD');
    return false;
  }

  // Load certificate and private key
  let cert, key;
  try {
    cert = fs.readFileSync(CERT_PATH);
    key  = fs.readFileSync(KEY_PATH);
    console.log('[AUTH] Certificate loaded from', CERT_PATH);
  } catch (e) {
    console.error('[AUTH] Certificate not found:', e.message);
    console.error('[AUTH] Run: node generate-cert.js');
    console.error('[AUTH] Then upload client-2048.crt to: https://developer.betfair.com → My API Access → SSL Certificates');
    return false;
  }

  return new Promise(resolve => {
    const payload = `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

    const opts = {
      hostname: 'identitysso-cert.betfair.com',
      path:     '/api/certlogin',
      method:   'POST',
      cert,
      key,
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
        console.log(`[AUTH] HTTP ${res.statusCode} from identitysso-cert.betfair.com`);
        console.log(`[AUTH] Raw response: ${body.slice(0, 500)}`);
        try {
          const j = JSON.parse(body);
          console.log(`[AUTH] status="${j.status}" error="${j.error || ''}" token=${j.token ? j.token.slice(0, 8) + '…' : 'NONE'}`);
          if (j.status === 'SUCCESS' && j.token) {
            session.token      = j.token;
            session.loggedInAt = Date.now();
            console.log('[AUTH] Betfair cert login OK');
            resolve(true);
          } else {
            console.error('[AUTH] Login failed — status:', j.status, '| error:', j.error);
            if (j.error === 'CERTIFICATE_ERROR') {
              console.error('[AUTH] Certificate not registered — upload client-2048.crt at:');
              console.error('[AUTH] https://developer.betfair.com → My API Access → SSL Certificates');
            }
            resolve(false);
          }
        } catch (e) {
          console.error('[AUTH] JSON parse error:', e.message);
          console.error('[AUTH] Raw body was:', body.slice(0, 300));
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

function scheduleRefresh() {
  setInterval(async () => {
    console.log('[AUTH] Session refresh...');
    await login();
  }, 8 * 3600_000);
}

module.exports = { login, getToken, isLoggedIn, scheduleRefresh };
