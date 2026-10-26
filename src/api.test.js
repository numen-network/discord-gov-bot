import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { discussionServer } from './api.js'

async function serving(t, threads) {
  const server = discussionServer({ state: { threads } }, '999').listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  return (path) => fetch(`http://127.0.0.1:${server.address().port}${path}`)
}

test('a referendum with a thread gets its link, cached for a day', async (t) => {
  const get = await serving(t, { 2: { id: '222', text: null } })
  const res = await get('/discussions/2')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400')
  assert.deepEqual(await res.json(), { url: 'https://discord.com/channels/999/222' })
})

test('a referendum without a thread is not found and not cached', async (t) => {
  const res = await (await serving(t, {}))('/discussions/2')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('cache-control'), 'no-cache')
})

test('a thread opened after the server starts shows up', async (t) => {
  const threads = {}
  const get = await serving(t, threads)
  threads[7] = { id: '777', text: null }
  assert.deepEqual(await (await get('/discussions/7')).json(), { url: 'https://discord.com/channels/999/777' })
})

test("an index that isn't a non-negative integer is a bad request", async (t) => {
  const get = await serving(t, {})
  for (const index of ['-1', '1.5', 'abc']) assert.equal((await get(`/discussions/${index}`)).status, 400)
})

test('any other path is not found', async (t) => {
  const get = await serving(t, { 2: { id: '222', text: null } })
  for (const path of ['/', '/discussions', '/discussions/2/x']) assert.equal((await get(path)).status, 404)
})

test('every answer lets any web page read it', async (t) => {
  const get = await serving(t, { 2: { id: '222', text: null } })
  for (const path of ['/discussions/2', '/discussions/3', '/discussions/abc', '/']) {
    assert.equal((await get(path)).headers.get('access-control-allow-origin'), '*')
  }
})
