'use strict';
const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'betfair-inplay')
  : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function dataPath(f) { return path.join(DATA_DIR, f); }

function load(f) {
  try { return JSON.parse(fs.readFileSync(dataPath(f), 'utf8')); } catch { return null; }
}

function save(f, d) {
  try { fs.writeFileSync(dataPath(f), JSON.stringify(d, null, 2)); }
  catch (e) { console.error(`[STORE] save ${f} error:`, e.message); }
}

module.exports = { dataPath, load, save };
