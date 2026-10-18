'use strict';
/**
 * Copy the database to data/backups/ (safe while the server is running, because
 * the server always replaces db.json in one atomic step).
 * Usage: npm run backup            -> data/backups/db-<time>-manual.json
 *        npm run backup -- D:\USB  -> also copies to another folder (e.g. a USB drive)
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const src = path.join(dataDir, 'db.json');
if (!fs.existsSync(src)) { console.error(`No database found at ${src}`); process.exit(1); }
JSON.parse(fs.readFileSync(src, 'utf8')); // make sure it is valid before copying
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `db-${stamp}-manual.json`;
const targets = [path.join(dataDir, 'backups')];
if (process.argv[2]) targets.push(path.resolve(process.argv[2]));
for (const dir of targets) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, path.join(dir, name));
  console.log(`Backup written: ${path.join(dir, name)}`);
}
