import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempDisposableSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'

const storeIn = (dir) => new Store(join(dir.path, 'state.db'))

test('state starts at genesis before the first save', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gov-bot-'))
  const store = storeIn(dir)
  assert.deepEqual(store.state, { cursor: { block: 0, event: 0 }, threads: {}, watching: {} })
  assert.equal(store.cursor(), -1)
})

test('state survives a round trip', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gov-bot-'))
  const state = {
    cursor: { block: 85_205, event: 4 },
    threads: { 2: { id: '222', text: '0xb42a' } },
    watching: { 2: { deadline: 9_000, sent: 7 } },
  }
  const store = storeIn(dir)
  store.state = state
  store.save()
  assert.deepEqual(storeIn(dir).state, state)
})

test('advance moves the cursor to the first event of the next block', () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'gov-bot-'))
  storeIn(dir).advance(85_205)
  const store = storeIn(dir)
  assert.equal(store.cursor(), 85_205)
  assert.deepEqual(store.state.cursor, { block: 85_206, event: 0 })
})
