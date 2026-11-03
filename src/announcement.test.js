import assert from 'node:assert/strict'
import { test } from 'node:test'
import { announcementLinks, announcementOf, discordAnnouncement, reminderAnnouncement, telegramAnnouncement } from './announcement.js'

const UNIT = 10n ** 18n
const TOKEN = { decimals: 18, symbol: 'NUMN' }
const EXPLORER = 'https://explorer.test'
const PROPOSER = 'nu7bkLdXi7aBVP8phwhrm3Js8PgNjseDbaj5XPuzfkQhgDzYT'
const BENEFICIARY = 'nu7iBot1ZuaFNt6wh4CQ8B8yh82Q6PsgJF7N7gfCGnoLLxZwv'
const BLOCK = { number: 85_205, time: 1_789_668_863 }
const CONTEXT = { explorer: EXPLORER, token: TOKEN }

const SUBMITTED = {
  kind: 'submitted',
  index: 12,
  text: { hash: '0xb42a', title: 'Fund the <Q1> audit', description: 'Six months.' },
  track: 'Small spender',
  proposer: PROPOSER,
  proposal: { kind: 'spend', spends: [{ amount: 50_000n * UNIT, beneficiary: BENEFICIARY }] },
  names: { [PROPOSER]: 'alice & co' },
}

const LINKS = announcementLinks({ explorer: `${EXPLORER}/referendum/12`, vote: 'https://wallet.test/?vote=12', discussion: 'https://discord.com/channels/9/222' })

test('announcementLinks leads to the explorer, the wallet and the thread', () => {
  assert.deepEqual(LINKS.map(({ text }) => text), ['View on explorer', 'Vote in wallet', 'Discuss on Discord'])
})

test('announcementLinks leaves the thread out until it opens', () => {
  const links = announcementLinks({ explorer: `${EXPLORER}/referendum/12`, vote: 'https://wallet.test/?vote=12', discussion: undefined })
  assert.deepEqual(links.map(({ text }) => text), ['View on explorer', 'Vote in wallet'])
})

test('announcementLinks leaves the wallet out once voting is over', () => {
  const links = announcementLinks({ explorer: `${EXPLORER}/referendum/12`, vote: undefined, discussion: 'https://discord.com/channels/9/222' })
  assert.deepEqual(links.map(({ text }) => text), ['View on explorer', 'Discuss on Discord'])
})

test('discordAnnouncement lays out a new referendum with its links last', () => {
  const [embed] = discordAnnouncement(announcementOf(SUBMITTED, CONTEXT), LINKS, BLOCK).embeds
  assert.equal(embed.title, 'New referendum #12')
  assert.equal(
    embed.description,
    [
      '**Fund the <Q1> audit**',
      [
        '**Track** Small spender',
        `**Proposer** [alice & co](${EXPLORER}/account/${PROPOSER})`,
        `**Spend** 50,000 NUMN to [nu7iBot…xZwv](${EXPLORER}/account/${BENEFICIARY})`,
      ].join('\n'),
      `[View on explorer](${EXPLORER}/referendum/12) · [Vote in wallet](https://wallet.test/?vote=12) · [Discuss on Discord](https://discord.com/channels/9/222)`,
    ].join('\n\n'),
  )
  assert.deepEqual(embed.footer, { text: 'Block #85,205' })
})

test('telegramAnnouncement lays out a new referendum as escaped HTML', () => {
  assert.equal(
    telegramAnnouncement(announcementOf(SUBMITTED, CONTEXT), LINKS),
    [
      '<b>New referendum #12</b>\nFund the &lt;Q1&gt; audit',
      [
        '<b>Track</b> Small spender',
        `<b>Proposer</b> <a href="${EXPLORER}/account/${PROPOSER}">alice &amp; co</a>`,
        `<b>Spend</b> 50,000 NUMN to <a href="${EXPLORER}/account/${BENEFICIARY}">nu7iBot…xZwv</a>`,
      ].join('\n'),
      `<a href="${EXPLORER}/referendum/12">View on explorer</a> · <a href="https://wallet.test/?vote=12">Vote in wallet</a> · <a href="https://discord.com/channels/9/222">Discuss on Discord</a>`,
    ].join('\n\n'),
  )
})

test('announcementOf names the referendum by the title it carries', () => {
  const announcement = announcementOf({ kind: 'deposit', index: 12, amount: 5_000n * UNIT, who: PROPOSER, name: null }, { ...CONTEXT, title: 'Fund the audit' })
  assert.equal(announcement.headline, 'Decision deposit placed on referendum #12')
  assert.equal(announcement.title, 'Fund the audit')
})

test('announcementOf times when a confirming referendum passes', () => {
  const announcement = announcementOf({ kind: 'confirming', index: 12, passes: { height: 85_905, time: 1_789_675_863 } }, CONTEXT)
  assert.equal(telegramAnnouncement(announcement, []).split('\n\n')[1], 'Passes around Sep 17, 2026, 8:11 PM UTC, unless approval or support falls short')
  assert.equal(discordAnnouncement(announcement, [], null).embeds[0].description, 'Passes around <t:1789675863:F>, unless approval or support falls short')
})

test('announcementOf says when a referendum no longer has any text', () => {
  const announcement = announcementOf({ kind: 'text', index: 12, text: { hash: null, title: '', description: '' } }, CONTEXT)
  assert.deepEqual(announcement, { headline: 'Text removed from referendum #12', lines: [] })
})

test('announcementOf says how a referendum ended', () => {
  assert.equal(announcementOf({ kind: 'ended', index: 12, outcome: 'Confirmed' }, CONTEXT).headline, 'Referendum #12 passed')
  assert.equal(announcementOf({ kind: 'ended', index: 12, outcome: 'Confirmed' }, CONTEXT).over, true)
  assert.equal(announcementOf({ kind: 'ended', index: 12, outcome: 'TimedOut' }, CONTEXT).headline, 'Referendum #12 timed out')
})

test('announcementOf names the error a passed call failed with', () => {
  const result = { isOk: false, asErr: { type: 'BadOrigin' } }
  const announcement = announcementOf({ kind: 'enacted', index: 12, name: 'Dispatched', result }, CONTEXT)
  assert.equal(announcement.headline, 'Referendum #12 passed but could not take effect')
  assert.equal(telegramAnnouncement(announcement, []).split('\n\n')[1], 'Failed with <code>BadOrigin</code>')
})

test('announcementOf reports a call that took effect', () => {
  const announcement = announcementOf({ kind: 'enacted', index: 12, name: 'Dispatched', result: { isOk: true } }, CONTEXT)
  assert.deepEqual([announcement.headline, announcement.lines, announcement.over], ['Referendum #12 took effect', [], true])
})

test('reminderAnnouncement counts down to the end of voting', () => {
  const announcement = reminderAnnouncement({ index: 12, days: 3, end: 'decision', endsAt: 1_789_675_863, title: 'Fund the audit' })
  assert.equal(announcement.headline, '3 days left to vote on referendum #12')
  assert.equal(discordAnnouncement(announcement, [], null).embeds[0].description, '**Fund the audit**\n\nEnds around <t:1789675863:F>')
})

test('reminderAnnouncement counts a confirming referendum down to passing', () => {
  const announcement = reminderAnnouncement({ index: 12, days: 1, end: 'confirmation', endsAt: 1_789_675_863 })
  assert.equal(announcement.headline, 'Referendum #12 passes in 1 day')
  assert.equal(discordAnnouncement(announcement, [], null).embeds[0].description, 'Passes around <t:1789675863:F>, unless approval or support falls short')
})
