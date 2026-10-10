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
  {
    version: 3,
    apply(database) {
      // Keep existing IDs and rows intact. Deletions become tombstones so
      // future sync clients can observe them before physical cleanup.
      for (const table of ["accounts", "categories", "transactions", "transfers", "budgets"]) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1 CHECK(sync_version >= 1)`);
        database.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`);
      }

      database.exec(`
        ALTER TABLE transactions ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
        ALTER TABLE transfers ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
        UPDATE transactions SET updated_at = created_at WHERE updated_at = '';
        UPDATE transfers SET updated_at = created_at WHERE updated_at = '';

        CREATE INDEX idx_accounts_user_sync ON accounts(user_id, updated_at, id);
        CREATE INDEX idx_categories_user_sync ON categories(user_id, updated_at, id);
        CREATE INDEX idx_transactions_user_sync ON transactions(user_id, updated_at, id);
        CREATE INDEX idx_transfers_user_sync ON transfers(user_id, updated_at, id);
        CREATE INDEX idx_budgets_user_sync ON budgets(user_id, updated_at, id);

        CREATE TABLE api_idempotency_keys (
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
          request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
          response_status INTEGER,
          response_json TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          PRIMARY KEY(user_id, idempotency_key),
          CHECK(
            (response_status IS NULL AND response_json IS NULL AND completed_at IS NULL)
            OR
            (response_status BETWEEN 100 AND 599 AND response_json IS NOT NULL AND completed_at IS NOT NULL)
          )
        );
        CREATE INDEX idx_idempotency_created ON api_idempotency_keys(created_at);
      `);
    },
  },
  {
    version: 4,
    apply(database) {
      // A global monotonic sequence avoids missing changes when timestamps tie.
      database.exec("CREATE TABLE sync_clock (id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL CHECK(value >= 0))");
      database.exec("INSERT INTO sync_clock(id, value) VALUES (1, 0)");
      for (const table of ["accounts", "categories", "transactions", "transfers", "budgets"]) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0 CHECK(sync_seq >= 0)`);
        const rows = database.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>;
        const update = database.prepare(`UPDATE ${table} SET sync_seq = ? WHERE id = ?`);
        for (const row of rows) {
          database.prepare("UPDATE sync_clock SET value = value + 1 WHERE id = 1").run();
          const seq = (database.prepare("SELECT value FROM sync_clock WHERE id = 1").get() as { value: number }).value;
          update.run(seq, row.id);
        }
        database.exec(`
          CREATE TRIGGER ${table}_sync_seq_insert AFTER INSERT ON ${table}
          BEGIN
            UPDATE sync_clock SET value = value + 1 WHERE id = 1;
            UPDATE ${table} SET sync_seq = (SELECT value FROM sync_clock WHERE id = 1) WHERE id = NEW.id;
          END;
          CREATE TRIGGER ${table}_sync_seq_update AFTER UPDATE ON ${table}
          WHEN NEW.sync_seq = OLD.sync_seq
          BEGIN
            UPDATE sync_clock SET value = value + 1 WHERE id = 1;
            UPDATE ${table} SET sync_seq = (SELECT value FROM sync_clock WHERE id = 1) WHERE id = NEW.id;
          END;
          CREATE INDEX idx_${table}_sync_seq ON ${table}(user_id, sync_seq);
        `);
      }
    },
  },

  {
    version: 5,
    apply(database) {
      database.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
          message TEXT NOT NULL CHECK(length(trim(message)) BETWEEN 1 AND 2000),
          severity TEXT NOT NULL CHECK(severity IN ('info', 'success', 'warning', 'critical')),
          created_at TEXT NOT NULL,
          expires_at TEXT,
          published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0, 1))
        );
        CREATE INDEX idx_notifications_published ON notifications(published, created_at DESC);

        CREATE TABLE notification_reads (
          notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES api_users(id) ON DELETE CASCADE,
          read_at TEXT NOT NULL,
          PRIMARY KEY(notification_id, user_id)
        );
        CREATE INDEX idx_notification_reads_user ON notification_reads(user_id, read_at DESC);

        CREATE TABLE patch_releases (
          id TEXT PRIMARY KEY,
          version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 32),
          build INTEGER NOT NULL CHECK(build >= 0),
          platform TEXT NOT NULL CHECK(platform IN ('android')),
          architecture TEXT NOT NULL CHECK(architecture IN ('arm64-v8a', 'armeabi-v7a', 'x86_64', 'universal')),
          download_url TEXT NOT NULL,
          sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
          size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 104857600),
          mandatory INTEGER NOT NULL DEFAULT 0 CHECK(mandatory IN (0, 1)),
          notes_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0, 1)),
          UNIQUE(version, build, platform, architecture)
        );
        CREATE INDEX idx_patch_releases_latest ON patch_releases(platform, architecture, published, build DESC);
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
    "transactions", "transfers", "budgets", "api_idempotency_keys", "sync_clock",
    "notifications", "notification_reads", "patch_releases",
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
