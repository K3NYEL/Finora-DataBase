import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

export type ApiDatabase = InstanceType<typeof Database>;

type Migration = {
  version: number;
  apply: (database: ApiDatabase) => void;
};

const migrations: Migration[] = [
  {
    version: 1,
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS api_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          disabled_at TEXT
        );

        CREATE TABLE IF NOT EXISTS api_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_api_sessions_user_expiry
          ON api_sessions(user_id, expires_at);
      `);
    },
  },
];

function applyMigrations(database: ApiDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  for (const migration of migrations) {
    const applied = database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(migration.version);
    if (applied) continue;

    const applyTransaction = database.transaction(() => {
      migration.apply(database);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
    });
    applyTransaction();
  }

  const missingTables = ["api_users", "api_sessions"].filter((table) => {
    const row = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    return !row;
  });
  if (missingTables.length > 0) {
    throw new Error(`Database schema is incomplete: ${missingTables.join(", ")}`);
  }
}

export function openDatabase(filePath = process.env.DATABASE_PATH ?? "./data/finora.db"): ApiDatabase {
  const isMemoryDatabase = filePath === ":memory:";
  const absolutePath = isMemoryDatabase ? ":memory:" : resolve(filePath);
  if (!isMemoryDatabase) {
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  }

  const database = new Database(absolutePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    applyMigrations(database);

    if (!isMemoryDatabase) {
      try {
        chmodSync(absolutePath, 0o600);
      } catch {
        // Some filesystems do not support POSIX file modes.
      }
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
