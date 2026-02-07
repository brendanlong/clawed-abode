import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A stored message in the local SQLite database.
 * The content field is a JSON-serialized SDKMessage from the Agent SDK.
 */
export interface StoredMessage {
  sequence: number;
  session_id: string;
  type: string;
  content: string; // JSON-serialized SDKMessage
  created_at: string;
}

/**
 * SQLite-backed message persistence for the agent service.
 * Append-only store for SDK messages with auto-incrementing sequence numbers.
 */
export class MessageStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private getAfterStmt: Database.Statement;
  private getLastSequenceStmt: Database.Statement;
  private getCountStmt: Database.Statement;

  constructor(dbPath: string = `${process.env.HOME || '/tmp'}/.claude/agent-messages.db`) {
    // Ensure the parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Create index for efficient queries by session and sequence
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence
      ON messages (session_id, sequence)
    `);

    this.insertStmt = this.db.prepare(
      'INSERT INTO messages (session_id, type, content) VALUES (?, ?, ?)'
    );

    this.getAfterStmt = this.db.prepare(
      'SELECT sequence, session_id, type, content, created_at FROM messages WHERE sequence > ? ORDER BY sequence ASC'
    );

    this.getLastSequenceStmt = this.db.prepare(
      'SELECT MAX(sequence) as last_sequence FROM messages'
    );

    this.getCountStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
    );
  }

  /**
   * Append a message to the store.
   * Returns the auto-incremented sequence number.
   */
  append(sessionId: string, type: string, content: string): number {
    const result = this.insertStmt.run(sessionId, type, content);
    return Number(result.lastInsertRowid);
  }

  /**
   * Get all messages after a given sequence number.
   */
  getAfter(afterSequence: number): StoredMessage[] {
    return this.getAfterStmt.all(afterSequence) as StoredMessage[];
  }

  /**
   * Get the last sequence number across all messages.
   * Returns 0 if no messages exist.
   */
  getLastSequence(): number {
    const row = this.getLastSequenceStmt.get() as { last_sequence: number | null };
    return row.last_sequence ?? 0;
  }

  /**
   * Get the message count for a session.
   */
  getCount(sessionId: string): number {
    const row = this.getCountStmt.get(sessionId) as { count: number };
    return row.count;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
