'use strict';
const https = require('https');

const RESEND_KEY = process.env.RESEND_API_KEY || '';
const TO_EMAIL   = 'divya.m.mittal@gmail.com';

function formatStakes(legs) {
  return legs.map((l, i) =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${l.outcome}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0">${l.bookmaker}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:700">${l.rawOdds?.toFixed(2) ?? '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:700;color:#2b6cb0">£${l.stake?.toFixed(2) ?? '—'}</td>
    </tr>`
  ).join('');
}

function buildHtml(arb) {
  const kickoff = arb.commenceTime
    ? new Date(arb.commenceTime).toUTCString()
    : 'Unknown';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f9fa;margin:0;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">

  <div style="background:#1a202c;padding:24px 32px">
    <div style="font-size:20px;font-weight:800;color:#fff">1M1B QUANT — <span style="color:#48bb78">ARB FOUND</span></div>
    <div style="color:#a0aec0;font-size:13px;margin-top:4px">${arb.sport} · ${new Date().toUTCString()}</div>
  </div>

  <div style="padding:20px 32px;background:#f0fff4;border-bottom:3px solid #48bb78">
    <div style="font-size:28px;font-weight:800;color:#276749">+${arb.netProfitPct.toFixed(2)}% guaranteed profit</div>
    <div style="font-size:16px;color:#2d3748;margin-top:4px">${arb.event}</div>
    <div style="font-size:13px;color:#718096;margin-top:2px">Kickoff: ${kickoff}</div>
  </div>

  <div style="padding:24px 32px">
    <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#718096;margin-bottom:12px">Stakes (per £${arb.totalStake} total)</div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="background:#f7fafc">
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#4a5568">Outcome</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#4a5568">Bookmaker</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#4a5568">Odds</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;color:#4a5568">Stake</th>
        </tr>
      </thead>
      <tbody>${formatStakes(arb.legs)}</tbody>
    </table>
  </div>

  <div style="padding:0 32px 24px;font-size:13px;color:#718096">
    <div>Gross profit: <strong>${arb.grossProfitPct?.toFixed(2) ?? '—'}%</strong> &nbsp;·&nbsp;
         Net profit (after commission): <strong style="color:#276749">${arb.netProfitPct.toFixed(2)}%</strong></div>
    <div style="margin-top:6px;color:#e53e3e;font-weight:600">⚡ Act fast — odds change constantly</div>
  </div>

</div>
</body></html>`;
}

async function sendArbAlert(arb) {
  if (!RESEND_KEY) {
    console.log('[ALERT] RESEND_API_KEY not set — skipping email');
    return;
  }

  const subject = `ARB FOUND: +${arb.netProfitPct.toFixed(2)}% profit — ${arb.event}`;
  const html    = buildHtml(arb);
  const payload = JSON.stringify({
    from:    'sports-arb@resend.dev',
    to:      [TO_EMAIL],
    subject,
    html,
  });

  return new Promise(resolve => {
    const opts = {
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${RESEND_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[ALERT] Email sent — ${arb.event} +${arb.netProfitPct.toFixed(2)}%`);
        } else {
          console.warn('[ALERT] Email failed:', res.statusCode, body);
        }
        resolve();
      });
    });
    req.on('error', e => { console.warn('[ALERT] Request error:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendArbAlert };
