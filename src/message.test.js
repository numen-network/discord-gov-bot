import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildEnactment,
  buildNotice,
  buildOutcome,
  buildPost,
  buildReminder,
  buildTextNotice,
  clip,
  collectSpends,
  countdownOf,
  discussionLink,
  enactedReferendum,
  enactmentId,
  errorName,
  formatAmount,
  identityName,
  readableTrack,
  reminderFor,
  shortAddress,
  splitText,
  voteLink,
} from './message.js'

const UNIT = 10n ** 18n
const TOKEN = { decimals: 18, symbol: 'NUMN' }
const EXPLORER = 'https://explorer.test'
const PROPOSER = 'nu7bkLdXi7aBVP8phwhrm3Js8PgNjseDbaj5XPuzfkQhgDzYT'
const BENEFICIARY = 'nu7iBot1ZuaFNt6wh4CQ8B8yh82Q6PsgJF7N7gfCGnoLLxZwv'
const BLOCK = { number: 16_748, time: 1_789_668_863 }

// Stand-ins for the polkadot-js codecs the bot reads, each with only what the bot calls on it
const big = (value) => ({ toBigInt: () => value })
const address = (value) => ({ toString: () => value })

const spend = (amount) => ({ section: 'treasury', method: 'spend', argsEntries: [['amount', big(amount)], ['beneficiary', address(BENEFICIARY)]] })
const spendLocal = (amount, beneficiary) => ({ section: 'treasury', method: 'spendLocal', argsEntries: [['amount', big(amount)], ['beneficiary', beneficiary]] })
const batch = (calls) => ({ section: 'utility', method: 'batchAll', argsEntries: [['calls', calls]] })

test('formatAmount groups whole units and drops a zero fraction', () => {
  assert.equal(formatAmount(1_000n * UNIT, TOKEN), '1,000 NUMN')
})

test('formatAmount keeps a fraction without trailing zeros', () => {
  assert.equal(formatAmount(UNIT / 2n, TOKEN), '0.5 NUMN')
})

test('formatAmount writes the decimals and symbol it is given', () => {
  assert.equal(formatAmount(1_500n, { decimals: 3, symbol: 'tNUMN' }), '1.5 tNUMN')
})

test('shortAddress keeps seven leading and four trailing characters', () => {
  assert.equal(shortAddress(PROPOSER), 'nu7bkLd…DzYT')
})

test('readableTrack strips the padding and reads as words', () => {
  assert.equal(readableTrack('small_spender\0\0\0'), 'Small spender')
})

test('clip leaves text within the limit untouched', () => {
  assert.equal(clip('Fund the explorer', 17), 'Fund the explorer')
})

test('clip cuts overlong text to the limit and marks the cut', () => {
  assert.equal(clip('Fund the explorer', 9), 'Fund the…')
})

test('clip never leaves half a surrogate pair at the cut', () => {
  assert.equal(clip('😀😀😀', 4), '😀…')
})

test('splitText reads the first line as the title and the rest as the description', () => {
  assert.deepEqual(splitText('Fund the explorer\n\nSix months of hosting.\nPaid monthly.'), {
    title: 'Fund the explorer',
    description: 'Six months of hosting.\nPaid monthly.',
  })
})

test('splitText reads a single line as a title with no description', () => {
  assert.deepEqual(splitText('Fund the explorer'), { title: 'Fund the explorer', description: '' })
})

test('collectSpends reads a lone spend', () => {
  assert.deepEqual(collectSpends(spend(5n)), [{ amount: 5n, beneficiary: BENEFICIARY }])
})

test('collectSpends reads a spend_local paid to an account', () => {
  assert.deepEqual(collectSpends(spendLocal(7n, { type: 'Id', value: address(BENEFICIARY) })), [{ amount: 7n, beneficiary: BENEFICIARY }])
})

test('collectSpends finds nothing in a spend_local with no account to pay', () => {
  assert.deepEqual(collectSpends(spendLocal(7n, { type: 'Index', value: big(3n) })), [])
})

test('collectSpends walks nested batches in order', () => {
  const call = batch([spend(1n), batch([spend(2n), spend(3n)])])
  assert.deepEqual(collectSpends(call).map((entry) => entry.amount), [1n, 2n, 3n])
})

test('collectSpends finds nothing in a call that books no spend', () => {
  const remark = { section: 'system', method: 'remark', argsEntries: [['remark', new Uint8Array()]] }
  assert.deepEqual(collectSpends(batch([remark])), [])
})


test('buildPost lays out a spend referendum', () => {
  const post = buildPost({
    index: 12,
    explorer: EXPLORER,
    token: TOKEN,
    block: BLOCK,
    track: 'Small spender',
    proposer: PROPOSER,
    proposal: { kind: 'spend', spends: [{ amount: 1_000n * UNIT, beneficiary: BENEFICIARY }] },
  })

  assert.equal(post.thread_name, 'Referendum #12')
  const embed = post.embeds[0]
  assert.equal(embed.url, 'https://explorer.test/referendum/12')
  assert.deepEqual(embed.fields.map((field) => field.name), ['Track', 'Proposer', 'Spend'])
  assert.equal(embed.fields[2].value, '1,000 NUMN to [nu7iBot…xZwv](https://explorer.test/account/nu7iBot1ZuaFNt6wh4CQ8B8yh82Q6PsgJF7N7gfCGnoLLxZwv)')
})

test('buildPost dates the post by the block the referendum came in', () => {
  const embed = buildPost({ index: 12, explorer: EXPLORER, token: TOKEN, block: BLOCK }).embeds[0]
  assert.deepEqual(embed.footer, { text: 'Block #16,748' })
  assert.equal(embed.timestamp, '2026-09-17T18:14:23.000Z')
})

test('buildPost sums instalments into one total', () => {
  const spends = [4_000n, 3_000n, 5_000n].map((amount) => ({ amount: amount * UNIT, beneficiary: BENEFICIARY }))
  const post = buildPost({ index: 12, explorer: EXPLORER, token: TOKEN, block: BLOCK, proposal: { kind: 'spend', spends } })
  assert.deepEqual(post.embeds[0].fields, [{ name: 'Spend', value: '12,000 NUMN over 3 payouts' }])
})

test('buildPost labels a proposal that is not a spend', () => {
  const post = buildPost({
    index: 3,
    explorer: EXPLORER,
    token: TOKEN,
    block: BLOCK,
    track: 'Big spender',
    proposer: PROPOSER,
    proposal: { kind: 'other', label: 'Utility.batch' },
  })
  assert.deepEqual(post.embeds[0].fields.map((field) => field.name), ['Track', 'Proposer', 'Proposal'])
  assert.equal(post.embeds[0].fields[2].value, 'Utility.batch')
})

test('buildPost names the thread after the title', () => {
  const post = buildPost({ index: 12, explorer: EXPLORER, token: TOKEN, block: BLOCK, title: 'Fund the explorer' })
  assert.equal(post.thread_name, '#12 · Fund the explorer')
})

test('buildPost clips a long title to the thread name limit', () => {
  const post = buildPost({ index: 12, explorer: EXPLORER, token: TOKEN, block: BLOCK, title: 'x'.repeat(120) })
  assert.equal(post.thread_name.length, 100)
  assert.ok(post.thread_name.startsWith('#12 · x'))
  assert.ok(post.thread_name.endsWith('…'))
})

test('buildPost shows the description as plain text', () => {
  const post = buildPost({
    index: 12,
    explorer: EXPLORER,
    token: TOKEN,
    block: BLOCK,
    description: '# Claim\n[here](https://evil.test) **now**\n> Quoted\n-# Small print',
  })
  assert.equal(post.embeds[0].description, '\\# Claim\n\\[here\\](https://evil.test) \\*\\*now\\*\\*\n\\> Quoted\n\\-# Small print')
})

test('buildPost escapes every masked link on a line', () => {
  const post = buildPost({
    index: 12,
    explorer: EXPLORER,
    token: TOKEN,
    block: BLOCK,
    description: 'See [docs](https://numen-network.org) and [vote here](https://evil.test)',
  })
  assert.equal(post.embeds[0].description, 'See \\[docs\\](https://numen-network.org) and \\[vote here\\](https://evil.test)')
})

test('buildPost clips a long description to the embed limit', () => {
  const post = buildPost({ index: 12, explorer: EXPLORER, token: TOKEN, block: BLOCK, description: '*'.repeat(10_000) })
  const { description } = post.embeds[0]
  assert.ok(description.length <= 4096)
  assert.ok(description.endsWith('…'))
})

test('buildPost shows a description up to the embed limit in full', () => {
  const post = buildPost({ index: 12, explorer: EXPLORER, token: TOKEN, block: BLOCK, description: 'a'.repeat(4_096) })
  assert.equal(post.embeds[0].description, 'a'.repeat(4_096))
})

test('buildPost leaves the description out when there is none', () => {
  const post = buildPost({ index: 12, explorer: EXPLORER, token: TOKEN, block: BLOCK, description: '' })
  assert.equal(post.embeds[0].description, undefined)
})

test('buildPost names accounts by their verified identity, read as plain text', () => {
  const post = buildPost({
    index: 12,
    explorer: EXPLORER,
    token: TOKEN,
    block: BLOCK,
    proposer: PROPOSER,
    proposal: { kind: 'spend', spends: [{ amount: UNIT, beneficiary: BENEFICIARY }] },
    names: { [PROPOSER]: 'FD', [BENEFICIARY]: '[Numen] *Treasury*' },
  })
  const [proposer, payee] = post.embeds[0].fields
  assert.equal(proposer.value, `[FD](https://explorer.test/account/${PROPOSER})`)
  assert.equal(payee.value, `1 NUMN to [\\[Numen\\] \\*Treasury\\*](https://explorer.test/account/${BENEFICIARY})`)
})

const registration = (display, ...verdicts) => ({
  info: { display: new TextEncoder().encode(display) },
  judgements: verdicts.map((type, registrar) => [registrar, { type }]),
})
const VALIDATOR_1 = ['nu3Numen1pYQqAfigZh4LiK2VF2b1cRBggkKB4gQcLFpBDhGp', { isNone: false, isRaw: true, asRaw: new TextEncoder().encode('Validator1') }]

test('identityName names an account by a display a registrar verified', () => {
  assert.equal(identityName(registration('FD', 'Reasonable')), 'FD')
  assert.equal(identityName(registration('FD', 'FeePaid', 'KnownGood')), 'FD')
})

test('identityName leaves out a name nobody verified or a registrar disputed', () => {
  assert.equal(identityName(registration('Numen Foundation')), null)
  assert.equal(identityName(registration('Numen Foundation', 'FeePaid')), null)
  assert.equal(identityName(registration('FD', 'KnownGood', 'Erroneous')), null)
  assert.equal(identityName(undefined, undefined, undefined), null)
})

test('identityName names a sub account after its verified parent', () => {
  assert.equal(identityName(undefined, VALIDATOR_1, registration('Numen', 'KnownGood')), 'Numen/Validator1')
  assert.equal(identityName(undefined, VALIDATOR_1, registration('Numen')), null)
})

test("identityName goes by an account's own registration over its parent's", () => {
  assert.equal(identityName(registration('Validator1'), VALIDATOR_1, registration('Numen', 'KnownGood')), null)
})

test('buildNotice links the referendum and dates the update by its block', () => {
  const embed = buildNotice({ index: 12, explorer: EXPLORER, block: BLOCK, title: 'Confirming', description: 'Soon' }).embeds[0]
  assert.equal(embed.url, 'https://explorer.test/referendum/12')
  assert.deepEqual(embed.footer, { text: 'Block #16,748' })
  assert.equal(embed.timestamp, '2026-09-17T18:14:23.000Z')
  assert.equal(embed.description, 'Soon')
})

test('buildNotice leaves the description out when there is none', () => {
  assert.equal(buildNotice({ index: 12, explorer: EXPLORER, block: BLOCK, title: 'Confirming', description: null }).embeds[0].description, undefined)
})

const textNotice = (text) => buildTextNotice({ index: 12, explorer: EXPLORER, block: BLOCK, hash: '0xb42a', ...text }).embeds[0]

test('buildTextNotice shows the new title in bold above the description', () => {
  const embed = textNotice({ title: 'Fund the explorer', description: 'Six months of hosting.' })
  assert.equal(embed.title, 'Text updated')
  assert.equal(embed.description, '**Fund the explorer**\n\nSix months of hosting.')
})

test('buildTextNotice shows the new text as plain text', () => {
  assert.equal(textNotice({ title: '**Free** coins', description: '' }).description, '**\\*\\*Free\\*\\* coins**')
})

test('buildTextNotice fills the embed limit and keeps the bold title whole', () => {
  const { description } = textNotice({ title: 'T'.repeat(500), description: '*'.repeat(10_000) })
  assert.equal(description.length, 4096)
  assert.ok(description.startsWith(`**${'T'.repeat(99)}…**\n\n\\*`))
})

test('buildTextNotice says when a referendum no longer has any text', () => {
  const embed = buildTextNotice({ index: 12, explorer: EXPLORER, block: BLOCK, hash: null, title: '', description: '' }).embeds[0]
  assert.equal(embed.title, 'Text removed')
  assert.equal(embed.description, undefined)
})

const DAY = 86_400
const TRACKS = [[30, { name: 'small_spender\0\0\0', decisionPeriod: 1_000 }]]
const FRESH = { deadline: null, sent: null }

const ongoing = (over) => ({ track: 30, submitted: 100, deciding: null, inQueue: false, ...over })

test('countdownOf counts a deciding referendum down to the end of its decision period', () => {
  const status = ongoing({ deciding: { since: 400, confirming: null } })
  assert.deepEqual(countdownOf(status, TRACKS, 2_000), { end: 'decision', deadline: 1_400 })
})

test('countdownOf counts a confirming referendum down to passing', () => {
  const status = ongoing({ deciding: { since: 400, confirming: 900 } })
  assert.deepEqual(countdownOf(status, TRACKS, 2_000), { end: 'confirmation', deadline: 900 })
})

test('countdownOf counts a referendum that never starts deciding down to timing out', () => {
  assert.deepEqual(countdownOf(ongoing({}), TRACKS, 2_000), { end: 'timeout', deadline: 2_100 })
})

test('countdownOf has nothing for a referendum queued for a decision slot', () => {
  assert.equal(countdownOf(ongoing({ inQueue: true }), TRACKS, 2_000), null)
})

test('reminderFor stays quiet with more than a week left', () => {
  assert.deepEqual(reminderFor(FRESH, 9_000, 8 * DAY), { days: null, watched: { deadline: 9_000, sent: null } })
})

test('reminderFor sends the week reminder once a week is left', () => {
  assert.deepEqual(reminderFor(FRESH, 9_000, 7 * DAY), { days: 7, watched: { deadline: 9_000, sent: 7 } })
})

test('reminderFor sends each reminder once', () => {
  assert.equal(reminderFor({ deadline: 9_000, sent: 7 }, 9_000, 5 * DAY).days, null)
  assert.equal(reminderFor({ deadline: 9_000, sent: 7 }, 9_000, 3 * DAY).days, 3)
})

test('reminderFor sends only the nearest of several that came due together', () => {
  assert.equal(reminderFor(FRESH, 9_000, 2 * DAY).days, 3)
  assert.equal(reminderFor({ deadline: 9_000, sent: 7 }, 9_000, DAY / 2).days, 1)
})

test('reminderFor counts again once the deadline moves', () => {
  // starting to decide trades the timeout for the end of the decision period
  assert.equal(reminderFor({ deadline: 9_000, sent: 1 }, 20_000, 7 * DAY).days, 7)
})

test('reminderFor says nothing once the deadline has passed', () => {
  assert.equal(reminderFor(FRESH, 9_000, 0).days, null)
})

test('voteLink names the referendum and the chain it runs on', () => {
  assert.equal(voteLink('https://wallet.test', 12, '0xabc'), 'https://wallet.test/?vote=12&genesis=0xabc')
})

test('discussionLink points at the thread inside its server', () => {
  assert.equal(discussionLink('999', '222'), 'https://discord.com/channels/999/222')
})

const reminder = (over) =>
  buildReminder({
    index: 12,
    explorer: EXPLORER,
    vote: 'https://wallet.test/?vote=12',
    days: 7,
    end: 'decision',
    deadline: 123_456,
    endsAt: 1_800_000_000,
    ...over,
  }).embeds[0]

test('buildReminder counts a deciding referendum down to the end of its decision', () => {
  const embed = reminder({})
  assert.equal(embed.title, 'Decision ends in 7 days')
  assert.equal(embed.url, 'https://explorer.test/referendum/12')
  assert.equal(embed.description, 'Around <t:1800000000:F>, at block #123,456\n[Vote](https://wallet.test/?vote=12)')
})

test('buildReminder counts an undecided referendum down to timing out', () => {
  assert.equal(reminder({ days: 1, end: 'timeout' }).title, 'Times out in 1 day')
})

test('buildReminder counts a confirming referendum down to passing', () => {
  const embed = reminder({ days: 3, end: 'confirmation' })
  assert.equal(embed.title, 'Passes in 3 days')
  assert.equal(embed.description, 'Around <t:1800000000:F>, at block #123,456, unless approval or support falls short\n[Vote](https://wallet.test/?vote=12)')
})

test('buildOutcome says how a referendum ended', () => {
  const outcome = (name) => buildOutcome({ index: 12, explorer: EXPLORER, block: BLOCK, outcome: name }).embeds[0].title
  assert.equal(outcome('Confirmed'), 'Referendum #12 was approved')
  assert.equal(outcome('TimedOut'), 'Referendum #12 timed out')
})

const enactment = (name, result) => buildEnactment({ index: 12, explorer: EXPLORER, block: BLOCK, name, result }).embeds[0]

test('buildEnactment reports a call that ran', () => {
  const embed = enactment('Dispatched', { isOk: true })
  assert.equal(embed.title, 'Referendum #12 was enacted')
  assert.equal(embed.description, undefined)
})

test('buildEnactment names the error a call failed with', () => {
  // A runtime whose treasury pallet sits at index 18
  const registry = {
    metadata: { pallets: [{ index: { eq: (index) => index === 18 }, name: 'Treasury' }] },
    findMetaError: () => ({ method: 'InsufficientPermission' }),
  }
  const error = { isModule: true, asModule: { index: 18 }, registry }
  const embed = enactment('Dispatched', { isOk: false, asErr: error })
  assert.equal(embed.title, 'Referendum #12 could not be enacted')
  assert.equal(embed.description, 'Failed with `Treasury.InsufficientPermission`')
})

test('buildEnactment explains a call the scheduler could not run at all', () => {
  assert.equal(enactment('CallUnavailable').description, 'The chain no longer holds its call')
  assert.equal(enactment('PermanentlyOverweight').description, 'Its call is too heavy to ever run')
})

test('errorName reads an error with no pallet behind it', () => {
  assert.equal(errorName({ type: 'BadOrigin' }), 'BadOrigin')
  assert.equal(errorName({ type: 'Token', value: { type: 'FundsUnavailable' } }), 'Token.FundsUnavailable')
})

test('enactmentId matches the tasks that enacted referenda 0 and 1 on mainnet', () => {
  assert.equal(enactmentId(0), '0x5a614cd58fac2c25d3f478ab06ba0748f0819a96726cc60e729b0c146dc562d6')
  assert.equal(enactmentId(1), '0xe7b617767036ae8f0fb1ddac190d1e21886f1b963b2e862090142ae7c38c20c3')
})

test('enactedReferendum finds the referendum behind a task', () => {
  const threads = { 0: { id: '100' }, 1: { id: '101' } }
  assert.equal(enactedReferendum(threads, enactmentId(1)), 1)
})

test('enactedReferendum finds nothing behind an alarm or another task', () => {
  const threads = { 0: { id: '100' } }
  assert.equal(enactedReferendum(threads, undefined), undefined)
  assert.equal(enactedReferendum(threads, enactmentId(7)), undefined)
})
