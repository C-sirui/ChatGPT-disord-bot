export type Param = string | number | null;

export interface Db {
  readonly driver: 'sqlite' | 'postgres';
  /** SQL uses Postgres-style `$1, $2…` placeholders on every driver. */
  query<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | undefined>;
  /** Returns affected row count. */
  exec(sql: string, params?: Param[]): Promise<number>;
  /** Run a multi-statement script without parameters (migrations). */
  script(sql: string): Promise<void>;
  /** Serializable-enough unit of work; nested calls reuse the outer transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
