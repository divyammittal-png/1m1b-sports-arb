'use strict';
// Run once on Railway to generate the client certificate for Betfair cert auth:
//   node generate-cert.js
//
// After running:
//   1. Go to Betfair Developer Portal → My API Access → client-2048.crt
//   2. Upload the generated client-2048.crt
//   3. Restart the bot — it will use cert login automatically

const { execSync }   = require('child_process');
const { generateKeyPairSync, createSign } = require('crypto');
const path           = require('path');
const fs             = require('fs');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'betfair-inplay')
  : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const KEY_FILE  = path.join(DATA_DIR, 'client-2048.key');
const CERT_FILE = path.join(DATA_DIR, 'client-2048.crt');

// ── Try openssl first (available on Railway / Linux) ─────────────────────────
function generateWithOpenssl() {
  console.log('[CERT] Generating 2048-bit RSA private key via openssl...');
  execSync(`openssl genrsa -out "${KEY_FILE}" 2048`, { stdio: 'pipe' });

  console.log('[CERT] Generating self-signed certificate (valid 3 years)...');
  execSync(
    `openssl req -new -x509 -key "${KEY_FILE}" -out "${CERT_FILE}" -days 1095` +
    ` -subj "/CN=BetfairClient/O=1M1BQuant/C=GB"`,
    { stdio: 'pipe' }
  );
}

// ── Pure Node.js fallback (no openssl binary required) ───────────────────────
// Builds a minimal DER-encoded self-signed X.509 v3 certificate.

function asn1Length(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function asn1Tag(tag, content) {
  return Buffer.concat([Buffer.from([tag]), asn1Length(content.length), content]);
}

function asn1Seq(content)  { return asn1Tag(0x30, content); }
function asn1Set(content)  { return asn1Tag(0x31, content); }
function asn1Int(buf)      { return asn1Tag(0x02, buf); }
function asn1OID(oid)      { return asn1Tag(0x06, Buffer.from(oid)); }
function asn1Utf8(str)     { return asn1Tag(0x0c, Buffer.from(str, 'utf8')); }
function asn1BitStr(buf)   { return asn1Tag(0x03, Buffer.concat([Buffer.from([0x00]), buf])); }
function asn1OctetStr(buf) { return asn1Tag(0x04, buf); }

function encodeRdnAttr(oidBytes, value) {
  return asn1Set(asn1Seq(Buffer.concat([asn1OID(oidBytes), asn1Utf8(value)])));
}

function encodeGeneralizedTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return asn1Tag(0x17, Buffer.from(s, 'ascii')); // UTCTime
}

// OIDs
const OID_RSA_ENCRYPTION    = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_SHA256_WITH_RSA   = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_COMMON_NAME       = [0x55, 0x04, 0x03];
const OID_ORGANIZATION      = [0x55, 0x04, 0x0a];
const OID_COUNTRY           = [0x55, 0x04, 0x06];

function buildSubjectDN() {
  return asn1Seq(Buffer.concat([
    encodeRdnAttr(OID_COUNTRY,      'GB'),
    encodeRdnAttr(OID_ORGANIZATION, '1M1BQuant'),
    encodeRdnAttr(OID_COMMON_NAME,  'BetfairClient'),
  ]));
}

function generateWithNodeCrypto() {
  console.log('[CERT] openssl not found — generating certificate with Node.js crypto...');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength:   2048,
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(KEY_FILE, privateKey, 'utf8');
  console.log('[CERT] Private key written:', KEY_FILE);

  // Build TBSCertificate
  const now    = new Date();
  const expiry = new Date(now.getTime() + 3 * 365 * 24 * 3600 * 1000);
  const serial = asn1Int(Buffer.from([0x01]));
  const sigAlg = asn1Seq(Buffer.concat([asn1OID(OID_SHA256_WITH_RSA), Buffer.from([0x05, 0x00])]));
  const subjectDN  = buildSubjectDN();
  const validity   = asn1Seq(Buffer.concat([encodeGeneralizedTime(now), encodeGeneralizedTime(expiry)]));
  const spkiAlgSeq = asn1Seq(Buffer.concat([asn1OID(OID_RSA_ENCRYPTION), Buffer.from([0x05, 0x00])]));
  const spkiInfo   = asn1Seq(Buffer.concat([spkiAlgSeq, asn1BitStr(publicKey)]));

  const tbs = asn1Seq(Buffer.concat([
    asn1Tag(0xa0, Buffer.from([0x02, 0x01, 0x02])), // version v3
    serial, sigAlg, subjectDN, validity,
    subjectDN,  // issuer = subject (self-signed)
    spkiInfo,
  ]));

  // Sign TBSCertificate
  const sign = createSign('sha256');
  sign.update(tbs);
  const signature = sign.sign({ key: privateKey, dsaEncoding: 'der' });

  const cert = asn1Seq(Buffer.concat([tbs, sigAlg, asn1BitStr(signature)]));

  const pem = [
    '-----BEGIN CERTIFICATE-----',
    cert.toString('base64').match(/.{1,64}/g).join('\n'),
    '-----END CERTIFICATE-----\n',
  ].join('\n');

  fs.writeFileSync(CERT_FILE, pem, 'utf8');
  console.log('[CERT] Certificate written:', CERT_FILE);
}

// ── Run ───────────────────────────────────────────────────────────────────────
try {
  execSync('openssl version', { stdio: 'pipe' });
  generateWithOpenssl();
} catch {
  generateWithNodeCrypto();
}

console.log('\n[CERT] Files generated:');
console.log('  Key:  ', KEY_FILE);
console.log('  Cert: ', CERT_FILE);
console.log('\n[CERT] NEXT STEP: upload client-2048.crt to:');
console.log('  https://developer.betfair.com → Account → My API Access → SSL Certificates');
console.log('  Then restart the bot.\n');
