import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "raseel-mc.db");

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

export function nowIso(): string {
  return new Date().toISOString();
}

/** node:sqlite returns Record<string, SQLOutputValue>; cast rows to our typed interfaces at the boundary. */
export function asRow<T>(value: unknown): T {
  return value as T;
}
