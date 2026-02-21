import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type UserRecord = {
  id: string;
  email: string;
  created_at: number;
  updated_at: number;
  locked_until: number | null;
};

export type LoginCodeRecord = {
  id: string;
  user_id: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  invalidated_at: number | null;
  attempts: number;
};

export type DatabaseClient = {
  db: Database;
  getUserByEmail: (email: string) => UserRecord | null;
  createUser: (id: string, email: string, now: number) => UserRecord;
  updateUserLock: (userId: string, lockedUntil: number | null, now: number) => void;
  updateUserTouched: (userId: string, now: number) => void;
  invalidateActiveCodes: (userId: string, now: number) => void;
  createLoginCode: (code: LoginCodeRecord) => void;
  getActiveLoginCode: (userId: string, now: number) => LoginCodeRecord | null;
  incrementAttempts: (codeId: string) => LoginCodeRecord | null;
  invalidateCode: (codeId: string, now: number) => void;
};

export const initDatabase = (databaseUrl: string): DatabaseClient => {
  const folder = dirname(databaseUrl);
  if (folder && folder !== ".") {
    mkdirSync(folder, { recursive: true });
  }
  const db = new Database(databaseUrl);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      locked_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      invalidated_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_login_codes_user_expires ON login_codes(user_id, expires_at);
  `);

  const getUserByEmailStmt = db.query<UserRecord, [string]>(
    "SELECT id, email, created_at, updated_at, locked_until FROM users WHERE email = ?;",
  );
  const createUserStmt = db.query<UserRecord, [string, string, number]>(
    "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id, email, created_at, updated_at, locked_until;",
  );
  const updateUserLockStmt = db.query("UPDATE users SET locked_until = ?, updated_at = ? WHERE id = ?;");
  const updateUserTouchedStmt = db.query("UPDATE users SET updated_at = ? WHERE id = ?;");
  const invalidateActiveCodesStmt = db.query(
    "UPDATE login_codes SET invalidated_at = ? WHERE user_id = ? AND invalidated_at IS NULL AND expires_at > ?;",
  );
  const createLoginCodeStmt = db.query(
    "INSERT INTO login_codes (id, user_id, code_hash, created_at, expires_at, invalidated_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?);",
  );
  const getActiveLoginCodeStmt = db.query<LoginCodeRecord, [string, number]>(
    "SELECT id, user_id, code_hash, created_at, expires_at, invalidated_at, attempts FROM login_codes WHERE user_id = ? AND invalidated_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1;",
  );
  const incrementAttemptsStmt = db.query(
    "UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? RETURNING id, user_id, code_hash, created_at, expires_at, invalidated_at, attempts;",
  );
  const invalidateCodeStmt = db.query("UPDATE login_codes SET invalidated_at = ? WHERE id = ?;");

  return {
    db,
    getUserByEmail: (email: string) => getUserByEmailStmt.get(email) ?? null,
    createUser: (id: string, email: string, now: number) =>
      createUserStmt.get(id, email, now, now) as UserRecord,
    updateUserLock: (userId: string, lockedUntil: number | null, now: number) => {
      updateUserLockStmt.run(lockedUntil, now, userId);
    },
    updateUserTouched: (userId: string, now: number) => {
      updateUserTouchedStmt.run(now, userId);
    },
    invalidateActiveCodes: (userId: string, now: number) => {
      invalidateActiveCodesStmt.run(now, userId, now);
    },
    createLoginCode: (code: LoginCodeRecord) => {
      createLoginCodeStmt.run(
        code.id,
        code.user_id,
        code.code_hash,
        code.created_at,
        code.expires_at,
        code.invalidated_at,
        code.attempts,
      );
    },
    getActiveLoginCode: (userId: string, now: number) => getActiveLoginCodeStmt.get(userId, now) ?? null,
    incrementAttempts: (codeId: string) => incrementAttemptsStmt.get(codeId) ?? null,
    invalidateCode: (codeId: string, now: number) => {
      invalidateCodeStmt.run(now, codeId);
    },
  };
};
