import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Chain } from './chain.js'
import { Discord } from './discord.js'
import { pendingEvents, postBlock, remind } from './gov.js'
import { enactmentId } from './message.js'

const UNIT = 10n ** 18n
const EXPLORER = 'https://explorer.test'
const PROPOSER = 'nu7bkLdXi7aBVP8phwhrm3Js8PgNjseDbaj5XPuzfkQhgDzYT'
const BENEFICIARY = 'nu7iBot1ZuaFNt6wh4CQ8B8yh82Q6PsgJF7N7gfCGnoLLxZwv'

// Stand-ins for the polkadot-js codecs the bot reads, each with only what the bot calls on it
const num = (value) => ({ toNumber: () => value })
const big = (value) => ({ toBigInt: () => value })
const address = (value) => ({ toString: () => value })
const hex = (value) => ({ toHex: () => value })
const some = (value) => ({ unwrap: () => value, unwrapOr: () => value })
const NONE = { unwrapOr: (fallback) => fallback }

const spend = (amount) => ({ section: 'treasury', method: 'spend', argsEntries: [['amount', big(amount)], ['beneficiary', address(BENEFICIARY)]] })

const registration = (display, ...verdicts) => ({
  info: { display: new TextEncoder().encode(display) },
  judgements: verdicts.map((type, registrar) => [registrar, { type }]),
})

const TRACKS = [[30, { name: 'small_spender\0\0\0', decisionPeriod: 1_000 }]]
const FRESH = { deadline: null, sent: null }

const record = (section, method, data = {}) => ({ event: { section, method, data } })

test('pendingEvents picks the events the bot acts on, in block order', () => {
  const events = [
    record('system', 'ExtrinsicSuccess'),
    record('referenda', 'Submitted', { index: num(2) }),
    record('referenda', 'SubmissionDepositRefunded', { index: num(1) }),
    record('referenda', 'MetadataSet', { index: num(2) }),
    record('scheduler', 'Dispatched'),
  ]
  assert.deepEqual(
    pendingEvents(events, 0).map(({ position, pallet, name }) => [position, `${pallet}.${name}`]),
    [
      [1, 'referenda.Submitted'],
      [3, 'referenda.MetadataSet'],
      [4, 'scheduler.Dispatched'],
    ],
  )
})

test('pendingEvents skips what the cursor has passed', () => {
  const events = [record('referenda', 'DecisionStarted', { index: num(0) }), record('referenda', 'DecisionDepositPlaced', { index: num(0) })]
  assert.deepEqual(pendingEvents(events, 1).map(({ name, args }) => [name, args.index.toNumber()]), [['DecisionDepositPlaced', 0]])
})

// Block 85205 on mainnet, where placing the deposit started the decision at once
const DECIDING = [
  record('referenda', 'DecisionStarted', { index: num(0), track: num(30) }),
  record('referenda', 'DecisionDepositPlaced', { index: num(0), who: address(PROPOSER), amount: big(1_000n * UNIT) }),
]

// A referendum's text, kept on chain as a preimage
const TEXT_HASH = '0xb42a'
const TEXT = new TextEncoder().encode('Fund the explorer\n\nSix months of hosting.')

const ONGOING = { track: 30, submitted: 16_748, deciding: { since: 85_205, confirming: null }, inQueue: false, submissionDeposit: { who: PROPOSER } }
const ongoingInfo = (status) => some({ isOngoing: true, asOngoing: { toPrimitive: () => status } })

function chainAt(events, identities) {
  const block = {
    query: {
      system: { events: async () => events },
      timestamp: { now: async () => big(1_789_668_863_000n) },
      referenda: {
        referendumInfoFor: async () => ongoingInfo(ONGOING),
        metadataOf: async () => some(hex(TEXT_HASH)),
      },
      preimage: {
        requestStatusFor: async () => some({ isUnrequested: true, asUnrequested: { len: num(TEXT.length) } }),
        preimageFor: async ([hash]) => (hash === TEXT_HASH ? some(TEXT) : NONE),
      },
      identity: {
        identityOf: async (who) => (identities[who] ? some(identities[who]) : NONE),
        superOf: async () => NONE,
      },
    },
    consts: {
      referenda: { tracks: { toPrimitive: () => TRACKS }, undecidingTimeout: num(2_000) },
      difficulty: { targetBlockTime: num(10) },
    },
    registry: { createType: () => spend(1_000n * UNIT) },
  }
  return {
    genesisHash: hex('0xabc'),
    registry: { chainDecimals: [18], chainTokens: ['NUMN'] },
    rpc: { chain: { getBlockHash: async () => '0x85205' } },
    at: async () => block,
  }
}

function botAt(events, identities = {}) {
  const store = {
    state: { cursor: { block: 85_205, event: 0 }, threads: { 0: { id: '100', text: null } }, watching: { 0: FRESH } },
    saved: [],
    save() {
      this.saved.push({ ...this.state.cursor })
    },
  }
  return {
    chain: new Chain(chainAt(events, identities)),
    discord: new Discord('https://discord.test/api/webhooks/1/token', '999'),
    store,
    explorer: EXPLORER,
    wallet: 'https://wallet.test',
  }
}

// A head 500 blocks, under a day, before the end of the decision
const HEAD = 85_705

// Confirming until 200 blocks past the head
const CONFIRMING = { ...ONGOING, deciding: { since: 85_205, confirming: 85_905 } }
// Times out 200 blocks past the head
const UNDECIDED = { ...ONGOING, submitted: 83_905, deciding: null }

async function infoAtHead(ctx, info) {
  const head = await ctx.chain.api.at()
  head.query.referenda.referendumInfoFor = async () => info
}

const titles = (fetch) => fetch.mock.calls.map(({ arguments: [, init] }) => JSON.parse(init.body).embeds[0].title)
const firstPost = (fetch) => JSON.parse(fetch.mock.calls[0].arguments[1].body)

test('postBlock posts each event of a block into its thread with the decision timed', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt(DECIDING)
  await postBlock(ctx, 85_205)

  assert.deepEqual(titles(fetch), ['Decision started', 'Decision deposit placed'])
  const [started, deposit] = fetch.mock.calls.map(({ arguments: [url, init] }) => [url.searchParams.get('thread_id'), JSON.parse(init.body).embeds[0].description])
  assert.deepEqual(started, ['100', 'Ends around <t:1789678863:F>, at block #86,205'])
  assert.deepEqual(deposit, ['100', '1,000 NUMN by [nu7bkLd…DzYT](https://explorer.test/account/nu7bkLdXi7aBVP8phwhrm3Js8PgNjseDbaj5XPuzfkQhgDzYT)'])
  assert.deepEqual(ctx.store.saved, [{ block: 85_205, event: 1 }, { block: 85_205, event: 2 }])
})

test('postBlock picks up after a refused post without repeating the ones before it', async (t) => {
  let refuse = true
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) =>
    refuse && JSON.parse(init.body).embeds[0].title === 'Decision deposit placed'
      ? new Response('{"message":"Service Unavailable"}', { status: 503 })
      : Response.json({ id: '1', channel_id: '100' }),
  )
  const ctx = botAt(DECIDING)
  await assert.rejects(postBlock(ctx, 85_205), /503/)
  assert.deepEqual(ctx.store.state.cursor, { block: 85_205, event: 1 })

  refuse = false
  await postBlock(ctx, 85_205)
  assert.deepEqual(titles(fetch), ['Decision started', 'Decision deposit placed', 'Decision deposit placed'])
  assert.deepEqual(ctx.store.state.cursor, { block: 85_205, event: 2 })
})

test('postBlock moves past a post its deleted thread can no longer take', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"message":"Unknown Channel","code":10003}', { status: 404 }))
  t.mock.method(console, 'error', () => {})
  const ctx = botAt(DECIDING)
  await postBlock(ctx, 85_205)
  assert.deepEqual(ctx.store.state.cursor, { block: 85_205, event: 2 })
})

test('postBlock names a depositor with a verified identity', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  await postBlock(botAt(DECIDING, { [PROPOSER]: registration('FD', 'Reasonable') }), 85_205)
  const deposit = JSON.parse(fetch.mock.calls[1].arguments[1].body).embeds[0]
  assert.equal(deposit.description, `1,000 NUMN by [FD](https://explorer.test/account/${PROPOSER})`)
})

test('postBlock times when a confirming referendum passes', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([record('referenda', 'ConfirmStarted', { index: num(0) })])
  await infoAtHead(ctx, ongoingInfo(CONFIRMING))
  await postBlock(ctx, 85_205)
  assert.deepEqual(titles(fetch), ['Confirming'])
  assert.equal(firstPost(fetch).embeds[0].description, 'Passes around <t:1789675863:F>, at block #85,905, unless approval or support falls short')
})

test('postBlock leaves out the text a kill clears on its way out', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([record('referenda', 'Killed', { index: num(0) }), record('referenda', 'MetadataCleared', { index: num(0), hash: hex('0x01') })])
  ctx.store.state.threads[0].text = '0x01'
  await postBlock(ctx, 85_205)
  assert.deepEqual(titles(fetch), ['Referendum #0 was killed'])
  assert.deepEqual(ctx.store.state.cursor, { block: 85_205, event: 2 })
})

const submission = (proposal) => record('referenda', 'Submitted', { index: num(2), track: num(30), proposal })
const INLINE = { type: 'Inline', asInline: new Uint8Array() }

test('postBlock opens and records a thread for a submission', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '222' }))
  const ctx = botAt([submission(INLINE)])
  await postBlock(ctx, 85_205)

  assert.equal(fetch.mock.calls[0].arguments[0].searchParams.get('thread_id'), null)
  const post = firstPost(fetch)
  assert.equal(post.thread_name, '#2 · Fund the explorer')
  assert.equal(post.embeds[0].description, 'Six months of hosting.')
  assert.deepEqual(post.embeds[0].fields.map((field) => field.value), [
    'Small spender',
    `[nu7bkLd…DzYT](${EXPLORER}/account/${PROPOSER})`,
    `1,000 NUMN to [nu7iBot…xZwv](${EXPLORER}/account/${BENEFICIARY})`,
  ])
  assert.deepEqual(ctx.store.state.threads[2], { id: '222', text: TEXT_HASH })
  assert.deepEqual(ctx.store.state.watching[2], FRESH)
})

test('postBlock reads everything at the block it handles', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '222' }))
  const ctx = botAt([submission(INLINE), DECIDING[0]])
  const at = t.mock.method(ctx.chain.api, 'at')
  await postBlock(ctx, 85_205)
  assert.deepEqual(at.mock.calls.map(({ arguments: [hash] }) => hash), ['0x85205'])
})

test('postBlock opens a thread for a proposal whose preimage is gone', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '222' }))
  const ctx = botAt([submission({ type: 'Lookup', asLookup: { hash: hex('0xdead'), len: num(4) } })])
  await postBlock(ctx, 85_205)
  assert.deepEqual(firstPost(fetch).embeds[0].fields.at(-1), { name: 'Proposal', value: 'a preimage the chain does not hold' })
})

test('postBlock posts the text a running referendum takes on', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([record('referenda', 'MetadataSet', { index: num(0), hash: hex(TEXT_HASH) })])
  await postBlock(ctx, 85_205)
  const [embed] = firstPost(fetch).embeds
  assert.equal(embed.title, 'Text updated')
  assert.equal(embed.description, '**Fund the explorer**\n\nSix months of hosting.')
  assert.equal(ctx.store.state.threads[0].text, TEXT_HASH)
})

test('postBlock leaves out a text its thread already shows', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([record('referenda', 'MetadataSet', { index: num(0), hash: hex(TEXT_HASH) })])
  ctx.store.state.threads[0].text = TEXT_HASH
  await postBlock(ctx, 85_205)
  assert.equal(fetch.mock.callCount(), 0)
})

test('postBlock reports in its thread how a passed call fared', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const result = { isOk: false, asErr: { type: 'BadOrigin' } }
  await postBlock(botAt([record('scheduler', 'Dispatched', { id: some(hex(enactmentId(0))), result })]), 85_205)
  assert.equal(fetch.mock.calls[0].arguments[0].searchParams.get('thread_id'), '100')
  assert.deepEqual(titles(fetch), ['Referendum #0 could not be enacted'])
  assert.equal(firstPost(fetch).embeds[0].description, 'Failed with `BadOrigin`')
})

test('remind posts a due reminder only once', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([])
  await remind(ctx, HEAD)
  await remind(ctx, HEAD)
  assert.deepEqual(titles(fetch), ['Decision ends in 1 day'])
  assert.equal(fetch.mock.calls[0].arguments[0].searchParams.get('thread_id'), '100')
  assert.equal(firstPost(fetch).embeds[0].description, 'Around <t:1789673863:F>, at block #86,205\n[Vote](https://wallet.test/?vote=0&genesis=0xabc)')
  assert.deepEqual(ctx.store.state.watching[0], { deadline: 86_205, sent: 1 })
})

test('remind skips a referendum already over at the head', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([])
  await infoAtHead(ctx, some({ isOngoing: false }))
  await remind(ctx, HEAD)
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(ctx.store.state.watching[0], FRESH)
})

test('remind counts a confirming referendum down to passing', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([])
  await infoAtHead(ctx, ongoingInfo(CONFIRMING))
  await remind(ctx, HEAD)
  assert.deepEqual(titles(fetch), ['Passes in 1 day'])
  assert.equal(
    firstPost(fetch).embeds[0].description,
    'Around <t:1789670863:F>, at block #85,905, unless approval or support falls short\n[Vote](https://wallet.test/?vote=0&genesis=0xabc)',
  )
})

test('remind counts an undecided referendum down to timing out', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([])
  await infoAtHead(ctx, ongoingInfo(UNDECIDED))
  await remind(ctx, HEAD)
  assert.deepEqual(titles(fetch), ['Times out in 1 day'])
})

test("remind leaves a referendum queued for a decision slot alone, since it can't time out", async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  const ctx = botAt([])
  await infoAtHead(ctx, ongoingInfo({ ...UNDECIDED, inQueue: true }))
  await remind(ctx, HEAD)
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(ctx.store.state.watching[0], FRESH)
})

test('remind leaves a failed read for the next round', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: '1', channel_id: '100' }))
  t.mock.method(console, 'error', () => {})
  const ctx = botAt([])
  t.mock.method(ctx.chain.api.rpc.chain, 'getBlockHash', async () => {
    throw new Error('socket closed')
  })
  await remind(ctx, HEAD)
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(ctx.store.state.watching[0], FRESH)
})
