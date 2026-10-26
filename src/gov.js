import {
  blockSeconds,
  eventsAt,
  nameAt,
  namesAt,
  ongoingAt,
  readProposal,
  readText,
  timeAt,
  trackName,
  tracksOf,
  undecidingTimeout,
} from './chain.js'
import { threadClosed } from './discord.js'
import {
  accountLink,
  buildEnactment,
  buildNotice,
  buildOutcome,
  buildPost,
  buildReminder,
  buildTextNotice,
  CONFIRMATION_CAVEAT,
  countdownOf,
  decisionEndOf,
  enactedReferendum,
  formatAmount,
  moment,
  reminderFor,
  voteLink,
} from './message.js'

async function postInThread(ctx, index, payload) {
  try {
    await ctx.discord.post(payload, ctx.store.state.threads[index].id)
  } catch (error) {
    if (!threadClosed(error)) throw error
    console.error(`thread of referendum ${index} is closed, post dropped`)
  }
}

/** When a future block falls, counted from the time of the block an event came in. */
function dueAt(block, height) {
  return moment(height, block.time + (height - block.number) * blockSeconds(block.api))
}

/** Where a referendum's decision ends as of a block, null once it was over. */
async function decisionEnd(block, index) {
  const status = await ongoingAt(block.api, index)
  if (!status) return null
  return dueAt(block, decisionEndOf(status, tracksOf(block.api)))
}

async function open(ctx, block, data) {
  const index = data.index.toNumber()
  const text = await readText(block.api, index)
  const proposer = (await ongoingAt(block.api, index))?.submissionDeposit.who
  const call = await readProposal(block.api, data.proposal)
  const names = await namesAt(block.api, [proposer, ...(call.spends ?? []).map((spend) => spend.beneficiary)])
  const message = await ctx.discord.post(
    buildPost({
      index,
      explorer: ctx.explorer,
      token: ctx.chain.token,
      block,
      title: text.title,
      description: text.description,
      track: trackName(block.api, data.track.toNumber()),
      proposer,
      proposal: call,
      names,
    }),
  )
  ctx.store.state.threads[index] = { id: message.channel_id, text: text.hash }
  ctx.store.state.watching[index] = { deadline: null, sent: null }
  console.log(`opened thread for referendum ${index}`)
}

/** Posts the text a referendum carries by the end of a block, unless its thread already shows it. */
async function syncText(ctx, block, data) {
  const index = data.index.toNumber()
  // Once a referendum is over, clearing its text is housekeeping, and kill does it unasked
  if (!ctx.store.state.watching[index]) return
  const thread = ctx.store.state.threads[index]
  const text = await readText(block.api, index)
  if (text.hash === thread.text) return
  await postInThread(ctx, index, buildTextNotice({ index, explorer: ctx.explorer, block, ...text }))
  thread.text = text.hash
}

async function depositPlaced(ctx, block, data) {
  const index = data.index.toNumber()
  const who = data.who.toString()
  const description = `${formatAmount(data.amount.toBigInt(), ctx.chain.token)} by ${accountLink(ctx.explorer, who, await nameAt(block.api, who))}`
  await postInThread(ctx, index, buildNotice({ index, explorer: ctx.explorer, block, title: 'Decision deposit placed', description }))
}

async function decisionStarted(ctx, block, data) {
  const index = data.index.toNumber()
  const ends = await decisionEnd(block, index)
  const description = ends && `Ends around ${ends}`
  await postInThread(ctx, index, buildNotice({ index, explorer: ctx.explorer, block, title: 'Decision started', description }))
}

async function confirmStarted(ctx, block, data) {
  const index = data.index.toNumber()
  const until = (await ongoingAt(block.api, index))?.deciding?.confirming
  const description = until && `Passes around ${dueAt(block, until)}, ${CONFIRMATION_CAVEAT}`
  await postInThread(ctx, index, buildNotice({ index, explorer: ctx.explorer, block, title: 'Confirming', description }))
}

async function confirmAborted(ctx, block, data) {
  const index = data.index.toNumber()
  const ends = await decisionEnd(block, index)
  const description = ends && `Decision ends around ${ends}`
  await postInThread(ctx, index, buildNotice({ index, explorer: ctx.explorer, block, title: 'Back to deciding', description }))
}

async function ended(ctx, block, data, name) {
  const index = data.index.toNumber()
  await postInThread(ctx, index, buildOutcome({ index, explorer: ctx.explorer, block, outcome: name }))
  delete ctx.store.state.watching[index]
  console.log(`posted how referendum ${index} ended`)
}

async function enacted(ctx, block, data, name) {
  const index = enactedReferendum(ctx.store.state.threads, data.id.unwrapOr(null)?.toHex())
  if (index === undefined) return
  await postInThread(ctx, index, buildEnactment({ index, explorer: ctx.explorer, block, name, result: data.result }))
  console.log(`posted how referendum ${index} was enacted`)
}

// Refunded and slashed deposits matter to their depositor alone and get no notice
const HANDLERS = {
  referenda: {
    Submitted: open,
    MetadataSet: syncText,
    MetadataCleared: syncText,
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
    .filter(({ position, pallet, name }) => position >= from && HANDLERS[pallet]?.[name])
}

export async function postBlock(ctx, height) {
  const api = await ctx.chain.at(height)
  const pending = pendingEvents(await eventsAt(api), ctx.store.state.cursor.event)
  if (pending.length === 0) return

  const block = { number: height, api, time: await timeAt(api) }
  for (const { position, pallet, name, args } of pending) {
    await HANDLERS[pallet][name](ctx, block, args, name)
    // The cursor passes an event only once Discord has taken its post, so a
    // crash in between repeats that one post rather than dropping it
    ctx.store.state.cursor.event = position + 1
    ctx.store.save()
  }
}

/** Where the chain stands at its finalized head, which every countdown is read against. */
async function readClock(ctx, height) {
  const api = await ctx.chain.at(height)
  return {
    api,
    height,
    now: await timeAt(api),
    blockSeconds: blockSeconds(api),
    tracks: tracksOf(api),
    undecidingTimeout: undecidingTimeout(api),
  }
}

async function remindIfDue(ctx, index, clock) {
  // One already over at the head gets its outcome once the bot reads that far
  const status = await ongoingAt(clock.api, index)
  const countdown = status && countdownOf(status, clock.tracks, clock.undecidingTimeout)
  if (!countdown) return

  const secondsLeft = (countdown.deadline - clock.height) * clock.blockSeconds
  const { days, watched } = reminderFor(ctx.store.state.watching[index], countdown.deadline, secondsLeft)
  if (days !== null) {
    const reminder = buildReminder({
      index,
      explorer: ctx.explorer,
      vote: voteLink(ctx.wallet, index, ctx.chain.genesis),
      days,
      ...countdown,
      endsAt: clock.now + secondsLeft,
    })
    await postInThread(ctx, index, reminder)
    console.log(`reminded referendum ${index}, ${days}d left`)
  }
  ctx.store.state.watching[index] = watched
  ctx.store.save()
}

export async function remind(ctx, height) {
  // A failed read waits for the next round instead of stopping the bot
  const clock = await readClock(ctx, height).catch((error) => console.error('reminders failed', error))
  if (!clock) return
  for (const index of Object.keys(ctx.store.state.watching)) {
    // A thread Discord refuses holds none of the others back
    await remindIfDue(ctx, Number(index), clock).catch((error) => console.error(`referendum ${index}`, error))
  }
}
