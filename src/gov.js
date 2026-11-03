import { clockAt, countdownAt, factOf, readBlock } from './facts.js'
import { threadClosed } from './discord.js'
import { buildPost, buildReminder, buildThreadNotice, reminderFor, voteLink } from './message.js'

async function postInThread(ctx, index, payload) {
  try {
    await ctx.discord.post(payload, ctx.store.state.threads[index].id)
  } catch (error) {
    if (!threadClosed(error)) throw error
    console.error(`thread of referendum ${index} is closed, post dropped`)
  }
}

async function open(ctx, block, { index, text, ...fact }) {
  const message = await ctx.discord.post(
    buildPost({ index, explorer: ctx.explorer, token: ctx.chain.token, block, title: text.title, description: text.description, ...fact }),
  )
  ctx.store.state.threads[index] = { id: message.channel_id, text: text.hash }
  ctx.store.state.watching[index] = { deadline: null, sent: null }
  console.log(`opened thread for referendum ${index}`)
}

/** A thread hears each text once, and nothing more of it once its referendum is over. */
function newToThread(ctx, { kind, index, text }) {
  if (kind !== 'text') return true
  // Once a referendum is over, clearing its text is housekeeping, and kill does it unasked
  return Boolean(ctx.store.state.watching[index]) && text.hash !== ctx.store.state.threads[index].text
}

async function postFact(ctx, block, fact) {
  if (!fact) return
  if (fact.kind === 'submitted') return open(ctx, block, fact)
  if (!newToThread(ctx, fact)) return

  await postInThread(ctx, fact.index, buildThreadNotice(fact, { explorer: ctx.explorer, token: ctx.chain.token, block }))
  if (fact.kind === 'text') ctx.store.state.threads[fact.index].text = fact.text.hash
  if (fact.kind === 'ended') delete ctx.store.state.watching[fact.index]
}

export async function postBlock(ctx, height) {
  const { pending, block } = await readBlock(ctx.chain, height, ctx.store.state.cursor.event)
  for (const event of pending) {
    await postFact(ctx, block, await factOf(block, event))
    // The cursor passes an event only once Discord has taken its post, so a
    // crash in between repeats that one post rather than dropping it
    ctx.store.state.cursor.event = event.position + 1
    ctx.store.save()
  }
}

async function remindIfDue(ctx, index, clock) {
  // One already over at the head gets its outcome once the bot reads that far
  const countdown = await countdownAt(clock, index)
  if (!countdown) return

  const { days, watched } = reminderFor(ctx.store.state.watching[index], countdown.deadline, countdown.secondsLeft)
  if (days !== null) {
    const vote = voteLink(ctx.wallet, index, ctx.chain.genesis)
    await postInThread(ctx, index, buildReminder({ index, explorer: ctx.explorer, vote, days, ...countdown }))
    console.log(`reminded referendum ${index}, ${days}d left`)
  }
  ctx.store.state.watching[index] = watched
  ctx.store.save()
}

export async function remind(ctx, height) {
  // A failed read waits for the next round instead of stopping the bot
  const clock = await clockAt(ctx.chain, height).catch((error) => console.error('reminders failed', error))
  if (!clock) return
  for (const index of Object.keys(ctx.store.state.watching)) {
    // A thread Discord refuses holds none of the others back
    await remindIfDue(ctx, Number(index), clock).catch((error) => console.error(`referendum ${index}`, error))
  }
}
