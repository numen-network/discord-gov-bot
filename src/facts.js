import {
  blockSeconds,
  eventsAt,
  nameAt,
  namesAt,
  ongoingAt,
  readProposal,
  readText,
  referendumCount,
  timeAt,
  trackName,
  tracksOf,
  undecidingTimeout,
} from './chain.js'
import { countdownOf, decisionEndOf, enactedReferendum } from './message.js'

/** When a future block falls, counted from the time of the block an event came in. */
function dueAt(block, height) {
  return { height, time: block.time + (height - block.number) * blockSeconds(block.api) }
}

/** Where a referendum's decision ends as of a block, null once it was over. */
async function decisionEnd(block, index) {
  const status = await ongoingAt(block.api, index)
  if (!status) return null
  return dueAt(block, decisionEndOf(status, tracksOf(block.api)))
}

async function submitted(block, data) {
  const index = data.index.toNumber()
  const proposer = (await ongoingAt(block.api, index))?.submissionDeposit.who
  const proposal = await readProposal(block.api, data.proposal)
  return {
    kind: 'submitted',
    index,
    text: await readText(block.api, index),
    track: trackName(block.api, data.track.toNumber()),
    proposer,
    proposal,
    names: await namesAt(block.api, [proposer, ...(proposal.spends ?? []).map((spend) => spend.beneficiary)]),
  }
}

/** The text a referendum carries by the end of a block. */
async function text(block, data) {
  const index = data.index.toNumber()
  return { kind: 'text', index, text: await readText(block.api, index) }
}

async function depositPlaced(block, data) {
  const who = data.who.toString()
  return { kind: 'deposit', index: data.index.toNumber(), amount: data.amount.toBigInt(), who, name: await nameAt(block.api, who) }
}

async function decisionStarted(block, data) {
  const index = data.index.toNumber()
  return { kind: 'deciding', index, ends: await decisionEnd(block, index) }
}

async function confirmStarted(block, data) {
  const index = data.index.toNumber()
  const until = (await ongoingAt(block.api, index))?.deciding?.confirming
  return { kind: 'confirming', index, passes: until ? dueAt(block, until) : null }
}

async function confirmAborted(block, data) {
  const index = data.index.toNumber()
  return { kind: 'unconfirmed', index, ends: await decisionEnd(block, index) }
}

async function ended(block, data, name) {
  return { kind: 'ended', index: data.index.toNumber(), outcome: name }
}

async function enacted(block, data, name) {
  const index = enactedReferendum(await referendumCount(block.api), data.id.unwrapOr(null)?.toHex())
  if (index === undefined) return null
  return { kind: 'enacted', index, name, result: data.result }
}

// Refunded and slashed deposits matter to their depositor alone and get no notice
const EVENTS = {
  referenda: {
    Submitted: submitted,
    MetadataSet: text,
    MetadataCleared: text,
    DecisionDepositPlaced: depositPlaced,
    DecisionStarted: decisionStarted,
    ConfirmStarted: confirmStarted,
    ConfirmAborted: confirmAborted,
    Confirmed: ended,
    Rejected: ended,
    TimedOut: ended,
    Cancelled: ended,
    Killed: ended,
  },
  // A passed call runs as a scheduler task, and the scheduler says how it went
  scheduler: {
    Dispatched: enacted,
    CallUnavailable: enacted,
    PermanentlyOverweight: enacted,
  },
}

/** The events of a block the bot acts on, from a position in it onward. */
export function pendingEvents(events, from) {
  return events
    .map(({ event }, position) => ({ position, pallet: event.section, name: event.method, args: event.data }))
    .filter(({ position, pallet, name }) => position >= from && EVENTS[pallet]?.[name])
}

/** What an event means, read at the end of its block. Null when the bot ignores it. */
export function factOf(block, { pallet, name, args }) {
  return EVENTS[pallet][name](block, args, name)
}

/** A block's events the bot acts on, and the block to read them against. */
export async function readBlock(chain, height, from = 0) {
  const api = await chain.at(height)
  const pending = pendingEvents(await eventsAt(api), from)
  if (pending.length === 0) return { pending }
  return { pending, block: { number: height, api, time: await timeAt(api) } }
}

/** Where the chain stands at its finalized head, which every countdown is read against. */
export async function clockAt(chain, height) {
  const api = await chain.at(height)
  return {
    api,
    height,
    now: await timeAt(api),
    blockSeconds: blockSeconds(api),
    tracks: tracksOf(api),
    undecidingTimeout: undecidingTimeout(api),
  }
}

/** What a running referendum counts down to at the head. Null once it's over or has nothing to count down to. */
export async function countdownAt(clock, index) {
  const status = await ongoingAt(clock.api, index)
  const countdown = status && countdownOf(status, clock.tracks, clock.undecidingTimeout)
  if (!countdown) return null
  const secondsLeft = (countdown.deadline - clock.height) * clock.blockSeconds
  return { ...countdown, secondsLeft, endsAt: clock.now + secondsLeft }
}
