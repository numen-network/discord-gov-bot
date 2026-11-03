import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Announcer, Outbox } from './announce.js'
import { Chain } from './chain.js'

const UNIT = 10n ** 18n
const PROPOSER = 'nu7bkLdXi7aBVP8phwhrm3Js8PgNjseDbaj5XPuzfkQhgDzYT'
const BENEFICIARY = 'nu7iBot1ZuaFNt6wh4CQ8B8yh82Q6PsgJF7N7gfCGnoLLxZwv'

// Stand-ins for the polkadot-js codecs the bot reads, each with only what the bot calls on it
const num = (value) => ({ toNumber: () => value })
const big = (value) => ({ toBigInt: () => value })
const address = (value) => ({ toString: () => value })
const hex = (value) => ({ toHex: () => value })
const some = (value) => ({ unwrap: () => value, unwrapOr: () => value })
const NONE = { unwrapOr: (fallback) => fallback }

const record = (section, method, data = {}) => ({ event: { section, method, data } })
const spend = (amount) => ({ section: 'treasury', method: 'spend', argsEntries: [['amount', big(amount)], ['beneficiary', address(BENEFICIARY)]] })

const TRACKS = [[30, { name: 'small_spender\0\0\0', decisionPeriod: 1_000 }]]
const TEXT_HASH = '0xb42a'
const TEXT = new TextEncoder().encode('Fund the explorer\n\nSix months of hosting.')

// Deciding since block 85,205, so its decision ends at 86,205
const ONGOING = { track: 30, submitted: 16_748, deciding: { since: 85_205, confirming: null }, inQueue: false, submissionDeposit: { who: PROPOSER } }
const ongoingInfo = some({ isOngoing: true, asOngoing: { toPrimitive: () => ONGOING } })

// Reads the chain the same at every height but for the events, which `events` keys by height
function chainWith(events) {
  const at = (height) => ({
    query: {
      system: { events: async () => events[height] ?? [] },
      timestamp: { now: async () => big(1_789_668_863_000n + BigInt(height - 85_205) * 10_000n) },
      referenda: {
        referendumInfoFor: Object.assign(async () => ongoingInfo, { entries: async () => [[{ args: [num(0)] }, ongoingInfo]] }),
        metadataOf: async () => some(hex(TEXT_HASH)),
        referendumCount: async () => num(3),
      },
      preimage: {
        requestStatusFor: async () => some({ isUnrequested: true, asUnrequested: { len: num(TEXT.length) } }),
        preimageFor: async ([hash]) => (hash === TEXT_HASH ? some(TEXT) : NONE),
      },
      identity: { identityOf: async () => NONE, superOf: async () => NONE },
    },
    consts: {
      referenda: { tracks: { toPrimitive: () => TRACKS }, undecidingTimeout: num(2_000) },
      difficulty: { targetBlockTime: num(10) },
    },
    registry: { createType: () => spend(1_000n * UNIT) },
  })
  return new Chain({
    genesisHash: hex('0xabc'),
    registry: { chainDecimals: [18], chainTokens: ['NUMN'] },
    rpc: { chain: { getBlockHash: async (height) => height } },
    at: async (height) => at(height),
  })
}

/** An outbox that keeps what it is handed, as a channel that never refuses. */
function recorder() {
  const sent = []
  const outbox = new Outbox('test', async (announcement, links) => sent.push({ headline: announcement.headline, links: links.map(({ text }) => text) }))
  return { outbox, sent }
}

async function announcerAt(height, events, threads = {}) {
  const ctx = {
    chain: chainWith(events),
    store: { state: { threads } },
    discord: { guild: '999' },
    explorer: 'https://explorer.test',
    wallet: 'https://wallet.test',
  }
  const { outbox, sent } = recorder()
  const announcer = await Announcer.start(ctx, [outbox], height, { threadWait: 30, poll: 5 })
  return { announcer, outbox, sent, ctx }
}

// Every referendum reads as deciding near its end, so a new one comes due for its last-day reminder at once
const besidesReminders = (sent) => sent.filter(({ headline }) => !headline.includes('left to vote'))

const submission = record('referenda', 'Submitted', { index: num(2), track: num(30), proposal: { type: 'Inline', asInline: new Uint8Array() } })

test('follow announces what happens past the head it starts at, never before', async (t) => {
  t.mock.method(console, 'log', () => {})
  const { announcer, outbox, sent } = await announcerAt(85_300, {
    85_300: [record('referenda', 'DecisionStarted', { index: num(0) })],
    85_301: [record('referenda', 'DecisionDepositPlaced', { index: num(0), who: address(PROPOSER), amount: big(UNIT) })],
  }, { 0: { id: '100' } })
  await announcer.follow(85_301)
  await outbox.drained
  assert.deepEqual(sent, [{ headline: 'Decision deposit placed on referendum #0', links: ['View on explorer', 'Vote in wallet', 'Discuss on Discord'] }])
})

test('start counts reminders already due as sent, so the next head announces none of them', async (t) => {
  t.mock.method(console, 'log', () => {})
  // 600 blocks, under a day, before the decision ends
  const { announcer, outbox, sent } = await announcerAt(85_605, {}, { 0: { id: '100' } })
  await announcer.follow(85_606)
  await outbox.drained
  assert.deepEqual(sent, [])
  assert.deepEqual(announcer.heard.watching[0], { deadline: 86_205, sent: 1 })
})

test('follow announces a submission once, though its text is set in the same block', async (t) => {
  t.mock.method(console, 'log', () => {})
  const { announcer, outbox, sent, ctx } = await announcerAt(85_300, {
    85_301: [submission, record('referenda', 'MetadataSet', { index: num(2), hash: hex(TEXT_HASH) })],
  })
  setTimeout(() => (ctx.store.state.threads[2] = { id: '222' }), 10)
  await announcer.follow(85_301)
  await outbox.drained
  assert.deepEqual(besidesReminders(sent), [{ headline: 'New referendum #2', links: ['View on explorer', 'Vote in wallet', 'Discuss on Discord'] }])
})

test('an announcement goes out without the thread once the wait for it runs out', async (t) => {
  t.mock.method(console, 'log', () => {})
  const { announcer, outbox, sent } = await announcerAt(85_300, { 85_301: [submission] })
  await announcer.follow(85_301)
  await outbox.drained
  assert.deepEqual(besidesReminders(sent), [{ headline: 'New referendum #2', links: ['View on explorer', 'Vote in wallet'] }])
})

test('the outcome of a referendum leads nowhere to vote', async (t) => {
  t.mock.method(console, 'log', () => {})
  const { announcer, outbox, sent } = await announcerAt(85_300, { 85_301: [record('referenda', 'Confirmed', { index: num(0) })] }, { 0: { id: '100' } })
  await announcer.follow(85_301)
  await outbox.drained
  assert.deepEqual(sent, [{ headline: 'Referendum #0 passed', links: ['View on explorer', 'Discuss on Discord'] }])
})

test('a failed read announces nothing of its block until it reads again', async (t) => {
  t.mock.method(console, 'log', () => {})
  const { announcer, outbox, sent, ctx } = await announcerAt(85_300, {
    85_301: [record('referenda', 'DecisionStarted', { index: num(0) }), record('referenda', 'MetadataSet', { index: num(0), hash: hex(TEXT_HASH) })],
  }, { 0: { id: '100' } })
  const at = ctx.chain.api.at
  let calls = 0
  ctx.chain.api.at = async (height) => {
    const block = await at(height)
    if (calls++ === 0) block.query.preimage.requestStatusFor = async () => Promise.reject(new Error('socket closed'))
    return block
  }
  await assert.rejects(announcer.follow(85_301), /socket closed/)
  assert.equal(announcer.height, 85_300)
  await announcer.follow(85_301)
  await outbox.drained
  assert.deepEqual(sent.map(({ headline }) => headline), ['Referendum #0 is in its decision period', 'Referendum #0 was edited'])
})

const item = (index) => ({ index, announcement: { headline: `#${index}` }, links: Promise.resolve([]), block: null })

test('Outbox tries a post again until it lands, keeping the order', async (t) => {
  t.mock.method(console, 'error', () => {})
  const sent = []
  let refuse = 2
  const outbox = new Outbox('test', async ({ headline }) => {
    if (headline === '#1' && refuse-- > 0) throw Object.assign(new Error('busy'), { status: 503 })
    sent.push(headline)
  }, { retry: 1 })
  outbox.push(item(1))
  outbox.push(item(2))
  await outbox.drained
  assert.deepEqual(sent, ['#1', '#2'])
})

test('Outbox drops a post the channel turns down for good', async (t) => {
  t.mock.method(console, 'error', () => {})
  const sent = []
  const outbox = new Outbox('test', async ({ headline }) => {
    if (headline === '#1') throw Object.assign(new Error('bad request'), { status: 400 })
    sent.push(headline)
  }, { retry: 1 })
  outbox.push(item(1))
  outbox.push(item(2))
  await outbox.drained
  assert.deepEqual(sent, ['#2'])
})
