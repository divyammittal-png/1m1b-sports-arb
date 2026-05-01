'use strict';
const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sports-arb')
  : path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function dataPath(filename) { return path.join(DATA_DIR, filename); }

module.exports = { dataPath };
