import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
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
  {
    version: 2,
    apply(database) {
      database.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
          account_type TEXT NOT NULL CHECK(account_type IN ('cash', 'bank', 'card', 'savings', 'investment', 'other')),
          currency_code TEXT NOT NULL CHECK(currency_code GLOB '[A-Z][A-Z][A-Z]'),
          opening_balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(opening_balance_minor) = 'integer'),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(id, user_id)
        );

        CREATE INDEX idx_accounts_user_created
          ON accounts(user_id, created_at);

        CREATE TABLE categories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
          kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(id, user_id),
          UNIQUE(user_id, kind, name)
        );

        CREATE INDEX idx_categories_user_kind
          ON categories(user_id, kind);

        CREATE TABLE transactions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          category_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
          amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor) = 'integer' AND amount_minor > 0),
          occurred_at TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
          created_at TEXT NOT NULL,
          FOREIGN KEY(account_id, user_id) REFERENCES accounts(id, user_id) ON DELETE RESTRICT,
          FOREIGN KEY(category_id, user_id) REFERENCES categories(id, user_id) ON DELETE RESTRICT
        );

        CREATE INDEX idx_transactions_user_date
          ON transactions(user_id, occurred_at DESC, id);
        CREATE INDEX idx_transactions_account
          ON transactions(account_id, user_id, occurred_at DESC);

        CREATE TABLE transfers (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          from_account_id TEXT NOT NULL,
          to_account_id TEXT NOT NULL,
          amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor) = 'integer' AND amount_minor > 0),
          occurred_at TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
          created_at TEXT NOT NULL,
          CHECK(from_account_id <> to_account_id),
          FOREIGN KEY(from_account_id, user_id) REFERENCES accounts(id, user_id) ON DELETE RESTRICT,
          FOREIGN KEY(to_account_id, user_id) REFERENCES accounts(id, user_id) ON DELETE RESTRICT
        );

        CREATE INDEX idx_transfers_user_date
          ON transfers(user_id, occurred_at DESC, id);
        CREATE INDEX idx_transfers_accounts
          ON transfers(user_id, from_account_id, to_account_id);

        CREATE TABLE budgets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          category_id TEXT NOT NULL,
          amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor) = 'integer' AND amount_minor > 0),
          period_start TEXT NOT NULL CHECK(length(period_start) = 10),
          period_end TEXT NOT NULL CHECK(length(period_end) = 10 AND period_end >= period_start),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(category_id, user_id) REFERENCES categories(id, user_id) ON DELETE RESTRICT,
          UNIQUE(user_id, category_id, period_start, period_end)
        );

        CREATE INDEX idx_budgets_user_period
          ON budgets(user_id, period_start, period_end);
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

  const requiredTables = [
    "api_users", "api_sessions", "accounts", "categories",
    "transactions", "transfers", "budgets",
  ];
  const missingTables = requiredTables.filter((table) => {
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
    const descriptor = openSync(absolutePath, "a", 0o600);
    closeSync(descriptor);
    try {
      chmodSync(absolutePath, 0o600);
    } catch {
      // Some filesystems do not support POSIX file modes.
    }
  }

  const database = new Database(absolutePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
