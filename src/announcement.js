import { CONFIRMATION_CAVEAT, clip, ENACTMENT_FAILURES, errorName, formatAmount, plainText, shortAddress, stamp } from './message.js'

// Cut like a thread name
const TITLE_MAX = 100

const OUTCOMES = {
  Confirmed: 'passed',
  Rejected: 'was rejected',
  Cancelled: 'was cancelled',
  TimedOut: 'timed out',
  Killed: 'was killed',
}

// An announcement is a headline, the referendum's title and lines of parts.
// A part is plain text, `{ text, url }`, `{ time }` in unix seconds or
// `{ code }`, and each channel renders it its own way.

const account = (explorer, address, name) => ({ text: name ?? shortAddress(address), url: `${explorer}/account/${address}` })
const line = (...parts) => ({ parts })
const field = (label, ...parts) => ({ label, parts })

function proposalLine(proposal, token, explorer, names) {
  if (proposal.kind === 'other') return field('Proposal', proposal.label)
  const { spends } = proposal
  const total = formatAmount(spends.reduce((sum, spend) => sum + spend.amount, 0n), token)
  const [{ beneficiary }] = spends
  if (spends.length === 1) return field('Spend', `${total} to `, account(explorer, beneficiary, names[beneficiary]))
  return field('Spend', `${total} over ${spends.length} payouts`)
}

function enactmentLine(name, result) {
  if (name !== 'Dispatched') return line(ENACTMENT_FAILURES[name])
  return result.isOk ? null : line('Failed with ', { code: errorName(result.asErr) })
}

const ANNOUNCEMENTS = {
  submitted: ({ index, text, track, proposer, proposal, names }, { explorer, token }) => ({
    headline: `New referendum #${index}`,
    title: text.title,
    lines: [
      field('Track', track),
      proposer && field('Proposer', account(explorer, proposer, names[proposer])),
      proposalLine(proposal, token, explorer, names),
    ],
  }),
  text: ({ index, text }) =>
    text.hash ? { headline: `Referendum #${index} was edited`, title: text.title, lines: [] } : { headline: `Text removed from referendum #${index}`, lines: [] },
  deposit: ({ index, amount, who, name }, { explorer, token, title }) => ({
    headline: `Decision deposit placed on referendum #${index}`,
    title,
    lines: [line(`${formatAmount(amount, token)} by `, account(explorer, who, name))],
  }),
  deciding: ({ index, ends }, { title }) => ({
    headline: `Referendum #${index} is in its decision period`,
    title,
    lines: [ends && line('Ends around ', { time: ends.time })],
  }),
  confirming: ({ index, passes }, { title }) => ({
    headline: `Referendum #${index} is on track to pass`,
    title,
    lines: [passes && line('Passes around ', { time: passes.time }, `, ${CONFIRMATION_CAVEAT}`)],
  }),
  unconfirmed: ({ index, ends }, { title }) => ({
    headline: `Referendum #${index} is no longer on track to pass`,
    title,
    lines: [ends && line('Decision ends around ', { time: ends.time })],
  }),
  ended: ({ index, outcome }, { title }) => ({ headline: `Referendum #${index} ${OUTCOMES[outcome]}`, title, lines: [], over: true }),
  enacted: ({ index, name, result }, { title }) => {
    const failure = enactmentLine(name, result)
    return {
      headline: failure ? `Referendum #${index} passed but could not take effect` : `Referendum #${index} took effect`,
      title,
      lines: [failure],
      over: true,
    }
  },
}

/** What the public channels hear of a fact. The title is the one the referendum carries by the end of its block. */
export function announcementOf(fact, context) {
  const announcement = ANNOUNCEMENTS[fact.kind](fact, context)
  return { ...announcement, lines: announcement.lines.filter(Boolean) }
}

const COUNTDOWNS = {
  decision: (index, left) => [`${left} left to vote on referendum #${index}`, 'Ends around '],
  confirmation: (index, left) => [`Referendum #${index} passes in ${left}`, 'Passes around '],
  timeout: (index, left) => [`Referendum #${index} times out in ${left}`, 'Times out around '],
}

export function reminderAnnouncement({ index, days, end, endsAt, title }) {
  const [headline, around] = COUNTDOWNS[end](index, days === 1 ? '1 day' : `${days} days`)
  const caveat = end === 'confirmation' ? [`, ${CONFIRMATION_CAVEAT}`] : []
  return { headline, title, lines: [line(around, { time: endsAt }, ...caveat)] }
}

/** Where an announcement leads. The wallet takes votes only while the referendum runs. The thread shows up once it opens. */
export function announcementLinks({ explorer, vote, discussion }) {
  return [
    { text: 'View on explorer', url: explorer },
    vote && { text: 'Vote in wallet', url: vote },
    discussion && { text: 'Discuss on Discord', url: discussion },
  ].filter(Boolean)
}

function discordPart(part) {
  if (typeof part === 'string') return plainText(part)
  if ('url' in part) return `[${plainText(part.text)}](${part.url})`
  if ('time' in part) return `<t:${part.time}:F>`
  return `\`${part.code}\``
}

const discordLine = ({ label, parts }) => `${label ? `**${label}** ` : ''}${parts.map(discordPart).join('')}`

/** An announcement as a webhook post, dated by its block when it reports on one. */
export function discordAnnouncement({ headline, title, lines }, links, block) {
  const description = [
    title && `**${plainText(clip(title, TITLE_MAX))}**`,
    lines.length > 0 && lines.map(discordLine).join('\n'),
    links.map(discordPart).join(' · '),
  ]
  const embed = { title: headline, description: description.filter(Boolean).join('\n\n') }
  return { embeds: [block ? stamp(embed, block) : embed] }
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const UTC = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })

function telegramPart(part) {
  if (typeof part === 'string') return escapeHtml(part)
  if ('url' in part) return `<a href="${escapeHtml(part.url)}">${escapeHtml(part.text)}</a>`
  if ('time' in part) return `${UTC.format(part.time * 1000)} UTC`
  return `<code>${escapeHtml(part.code)}</code>`
}

const telegramLine = ({ label, parts }) => `${label ? `<b>${label}</b> ` : ''}${parts.map(telegramPart).join('')}`

/** An announcement as a Telegram HTML message. */
export function telegramAnnouncement({ headline, title, lines }, links) {
  const text = [
    [`<b>${escapeHtml(headline)}</b>`, title && escapeHtml(clip(title, TITLE_MAX))].filter(Boolean).join('\n'),
    lines.length > 0 && lines.map(telegramLine).join('\n'),
    links.map(telegramPart).join(' · '),
  ]
  return text.filter(Boolean).join('\n\n')
}
