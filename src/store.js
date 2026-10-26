import { DatabaseSync } from 'node:sqlite'

/** The state database holds how far the bot has read, every thread ID and the reminders already sent. */
export class Store {
  constructor(path) {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)')
    const row = db.prepare('SELECT json FROM state').get()
    // A bot with no saved state has read nothing yet, so it starts at genesis
    this.state = row ? JSON.parse(row.json) : { cursor: { block: 0, event: 0 }, threads: {}, watching: {} }
    this.write = db.prepare('INSERT INTO state (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json')
  }

  /** The last block fully read, -1 before genesis. */
  cursor() {
    return this.state.cursor.block - 1
  }

  advance(height) {
    this.state.cursor = { block: height + 1, event: 0 }
    this.save()
  }

  save() {
    this.write.run(JSON.stringify(this.state))
  }
}
