import { escapeMarkdown } from '@discordjs/formatters'
import { bnToU8a, compactAddLength, stringToU8a, u8aConcat } from '@polkadot/util'
import { blake2AsHex } from '@polkadot/util-crypto'

// Discord refuses the whole post when any part runs past its limit
const THREAD_NAME_MAX = 100
const DESCRIPTION_MAX = 4096

const BATCHES = ['batch', 'batchAll', 'forceBatch']

// An identity counts as verified with one of these judgements and none of the disputing ones, as on the explorer
const VERIFYING = ['Reasonable', 'KnownGood']
const DISPUTING = ['Erroneous', 'LowQuality']

const DAY = 86_400
const REMINDER_DAYS = [7, 3, 1]

const OUTCOMES = {
  Confirmed: 'was approved',
  Rejected: 'was rejected',
  Cancelled: 'was cancelled',
  TimedOut: 'timed out',
  Killed: 'was killed',
}

const ENACTMENT_FAILURES = {
  CallUnavailable: 'The chain no longer holds its call',
  PermanentlyOverweight: 'Its call is too heavy to ever run',
}

const COUNTDOWNS = {
  timeout: 'Times out',
  decision: 'Decision ends',
  confirmation: 'Passes',
}

export const CONFIRMATION_CAVEAT = 'unless approval or support falls short'

export function formatAmount(units, { decimals, symbol }) {
  const unit = 10n ** BigInt(decimals)
  const whole = (units / unit).toLocaleString('en-US')
  const frac = (units % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac} ${symbol}` : `${whole} ${symbol}`
}

export function shortAddress(address) {
  return `${address.slice(0, 7)}…${address.slice(-4)}`
}

export function accountLink(explorer, address, name) {
  return `[${name ? plainText(name) : shortAddress(address)}](${explorer}/account/${address})`
}

function verified({ judgements }) {
  const verdicts = judgements.map(([, judgement]) => judgement.type)
  return verdicts.some((verdict) => VERIFYING.includes(verdict)) && !verdicts.some((verdict) => DISPUTING.includes(verdict))
}

/** A sub account's name, the one identity field pallet_identity still keeps as `Data`. */
function subName(data) {
  if (data.isNone) return null
  return data.isRaw ? new TextDecoder().decode(data.asRaw) : `${data.type} ${data.value.toHex().slice(0, 6)}…${data.value.toHex().slice(-4)}`
}

/**
 * What an account goes by, labelled the way the explorer does. Only a name a
 * registrar verified counts, since Discord has no badge to tell it from one
 * anybody could claim.
 */
export function identityName(own, sub, parent) {
  if (own) return verified(own) ? new TextDecoder().decode(own.info.display) || null : null
  if (!sub || !parent || !verified(parent)) return null
  const name = subName(sub[1])
  return name ? `${new TextDecoder().decode(parent.info.display)}/${name}` : null
}

/** The chain pads a track name to a fixed width and writes it in snake case. */
export function readableTrack(name) {
  const trimmed = name.replace(/\0+$/, '').replace(/_/g, ' ')
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/**
 * Counts UTF-16 units, never fewer than Discord does, and drops the half of a
 * surrogate pair a cut leaves behind.
 */
export function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`
}

/** Text anybody can write on chain appears as typed, the way the explorer renders it. */
function plainText(text) {
  const escaped = escapeMarkdown(text, { heading: true, bulletedList: true, numberedList: true })
  // escapeMarkdown leaves block quotes and subtext alone, and its maskedLink
  // option escapes only the first link on a line
  return escaped.replace(/[[\]]/g, '\\$&').replace(/^( *)(>|-#)/gm, '$1\\$2')
}

/**
 * A referendum's text is a dump shaped like a commit message, the title on the
 * first line and the description after it.
 */
export function splitText(dump) {
  const cut = dump.indexOf('\n')
  return {
    title: (cut === -1 ? dump : dump.slice(0, cut)).trim(),
    description: cut === -1 ? '' : dump.slice(cut + 1).trim(),
  }
}

/** Every treasury spend a call books, instalments in a batch included. */
export function collectSpends(call) {
  const args = Object.fromEntries(call.argsEntries)
  const spendTo = (beneficiary) => [{ amount: args.amount.toBigInt(), beneficiary: beneficiary.toString() }]
  if (call.section === 'treasury' && call.method === 'spend') return spendTo(args.beneficiary)
  // spend_local takes its beneficiary as a MultiAddress, and only the Id form resolves to an account
  if (call.section === 'treasury' && call.method === 'spendLocal' && args.beneficiary.type === 'Id') return spendTo(args.beneficiary.value)
  if (call.section === 'utility' && BATCHES.includes(call.method)) return args.calls.flatMap(collectSpends)
  return []
}

/** The block a deciding referendum's decision period runs out at. */
export function decisionEndOf(status, tracks) {
  const [, track] = tracks.find(([id]) => id === status.track)
  return status.deciding.since + track.decisionPeriod
}

/**
 * What a running referendum counts down to, and the block it falls on. One
 * queued for a decision slot can't time out, so it has nothing to count down to.
 */
export function countdownOf(status, tracks, undecidingTimeout) {
  if (status.deciding?.confirming) return { end: 'confirmation', deadline: status.deciding.confirming }
  if (status.deciding) return { end: 'decision', deadline: decisionEndOf(status, tracks) }
  if (status.inQueue) return null
  return { end: 'timeout', deadline: status.submitted + undecidingTimeout }
}

/**
 * The reminder a referendum has come due for, and what to remember about it.
 * Only the nearest goes out when several came due together, and a deadline
 * that moves starts the count again.
 */
export function reminderFor(watched, deadline, secondsLeft) {
  const sent = watched.deadline === deadline ? watched.sent : null
  const due = REMINDER_DAYS.filter((days) => secondsLeft <= days * DAY).at(-1)
  const days = secondsLeft > 0 && due !== undefined && (sent === null || due < sent) ? due : null
  return { days, watched: { deadline, sent: days ?? sent } }
}

/** The name pallet_referenda gives the task that runs a passed call, `(ASSEMBLY_ID, "enactment", index)` hashed. */
export function enactmentId(index) {
  return blake2AsHex(u8aConcat(stringToU8a('assembly'), compactAddLength(stringToU8a('enactment')), bnToU8a(index, { bitLength: 32 })))
}

/** The referendum a scheduler task enacts, among those with a thread. */
export function enactedReferendum(threads, task) {
  return Object.keys(threads)
    .map(Number)
    .find((index) => enactmentId(index) === task)
}

/** A pallet as the runtime names it, `Treasury` where polkadot-js says `treasury`. */
export function palletName(registry, index) {
  return registry.metadata.pallets.find((pallet) => pallet.index.eq(index)).name.toString()
}

/** A dispatch error by name, prefixed with its pallet or kind, as in `Token.FundsUnavailable`. */
export function errorName(error) {
  if (error.isModule) return `${palletName(error.registry, error.asModule.index)}.${error.registry.findMetaError(error.asModule).method}`
  const names = []
  for (let level = error; level?.type; level = level.value) names.push(level.type)
  return names.join('.')
}

export function voteLink(wallet, index, genesis) {
  const url = new URL(wallet)
  url.searchParams.set('vote', String(index))
  url.searchParams.set('genesis', genesis)
  return url.href
}

export function discussionLink(guild, thread) {
  return `https://discord.com/channels/${guild}/${thread}`
}

/** A time Discord shows in each reader's own zone, and the block it falls on. */
export function moment(height, unix) {
  return `<t:${unix}:F>, at block #${height.toLocaleString('en-US')}`
}

/** Dates a message by the block it reports on, since it may go out long after. */
function stamp(embed, block) {
  return {
    ...embed,
    footer: { text: `Block #${block.number.toLocaleString('en-US')}` },
    timestamp: new Date(block.time * 1000).toISOString(),
  }
}

function proposalField(proposal, token, explorer, names) {
  if (proposal.kind === 'other') return { name: 'Proposal', value: proposal.label }

  const { spends } = proposal
  const total = formatAmount(spends.reduce((sum, spend) => sum + spend.amount, 0n), token)
  const [{ beneficiary }] = spends
  if (spends.length === 1) return { name: 'Spend', value: `${total} to ${accountLink(explorer, beneficiary, names[beneficiary])}` }
  return { name: 'Spend', value: `${total} over ${spends.length} payouts` }
}

export function buildPost({ index, explorer, token, block, title, description, track, proposer, proposal, names = {} }) {
  const fields = []
  if (track) fields.push({ name: 'Track', value: track, inline: true })
  if (proposer) fields.push({ name: 'Proposer', value: accountLink(explorer, proposer, names[proposer]), inline: true })
  if (proposal) fields.push(proposalField(proposal, token, explorer, names))

  return {
    thread_name: title ? clip(`#${index} · ${title}`, THREAD_NAME_MAX) : `Referendum #${index}`,
    embeds: [
      stamp(
        {
          title: `Referendum #${index}`,
          url: `${explorer}/referendum/${index}`,
          description: description ? clip(plainText(description), DESCRIPTION_MAX) : undefined,
          fields,
        },
        block,
      ),
    ],
  }
}

/** One update in a referendum's thread. */
export function buildNotice({ index, explorer, block, title, description }) {
  return { embeds: [stamp({ title, url: `${explorer}/referendum/${index}`, description: description || undefined }, block)] }
}

/** The text a referendum carries now, its title in bold above the description. */
export function buildTextNotice({ index, explorer, block, hash, title, description }) {
  if (!hash) return buildNotice({ index, explorer, block, title: 'Text removed' })

  // The title is clipped like a thread name so the cut always falls in the description
  const text = [title && `**${clip(plainText(title), THREAD_NAME_MAX)}**`, description && plainText(description)]
  return buildNotice({ index, explorer, block, title: 'Text updated', description: clip(text.filter(Boolean).join('\n\n'), DESCRIPTION_MAX) })
}

export function buildReminder({ index, explorer, vote, days, end, deadline, endsAt }) {
  const left = days === 1 ? '1 day' : `${days} days`
  const caveat = end === 'confirmation' ? `, ${CONFIRMATION_CAVEAT}` : ''
  return {
    embeds: [
      {
        title: `${COUNTDOWNS[end]} in ${left}`,
        url: `${explorer}/referendum/${index}`,
        description: `Around ${moment(deadline, endsAt)}${caveat}\n[Vote](${vote})`,
      },
    ],
  }
}

export function buildOutcome({ index, explorer, block, outcome }) {
  return buildNotice({ index, explorer, block, title: `Referendum #${index} ${OUTCOMES[outcome]}` })
}

function enactmentFailure(name, result) {
  if (name !== 'Dispatched') return ENACTMENT_FAILURES[name]
  return result.isOk ? null : `Failed with \`${errorName(result.asErr)}\``
}

/** How a passed call fared once its enactment came due. */
export function buildEnactment({ index, explorer, block, name, result }) {
  const failure = enactmentFailure(name, result)
  return buildNotice({
    index,
    explorer,
    block,
    title: `Referendum #${index} ${failure ? 'could not be enacted' : 'was enacted'}`,
    description: failure,
  })
}
