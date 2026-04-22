// SQLite helper. Initializes schema and exports a getDb() handle.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db;

export function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initDb() {
  const schemaPath = path.join(__dirname, '..', '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const handle = getDb();
  handle.exec(schema);
  console.log(`Initialized schema at ${DB_PATH}`);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

if (process.argv.includes('--init')) {
  initDb();
  closeDb();
}
