import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * Minimal D1-compatible facade over `node:sqlite`, so state-machine tests run
 * the same SQL and the same migration that production uses.
 */
class Statement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly args: unknown[];

  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): Statement {
    return new Statement(this.db, this.sql, args);
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const result = this.db.prepare(this.sql).run(...(this.args as never[]));
    return {
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    if (!row) return null;
    const plain = { ...row } as Record<string, unknown>;
    return (column ? (plain[column] as T) : (plain as T)) ?? null;
  }

  async all<T>(): Promise<{ success: true; results: T[] }> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[]));
    return { success: true, results: rows.map((row) => ({ ...row }) as T) };
  }
}

export type TestDatabase = {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
  close(): void;
};

export function createTestDb(): TestDatabase {
  const sqlite = new DatabaseSync(":memory:");
  const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }

  return {
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (statements: Statement[]) => {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    close: () => sqlite.close(),
  };
}
