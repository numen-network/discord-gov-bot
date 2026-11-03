import { announcementLinks, announcementOf, discordAnnouncement, reminderAnnouncement, telegramAnnouncement } from './announcement.js'
import { ongoingIndexes, readText } from './chain.js'
import { clockAt, countdownAt, factOf, readBlock } from './facts.js'
import { discussionLink, reminderFor, voteLink } from './message.js'

const FRESH = { deadline: null, sent: null }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A dropped connection, a rate limit or a server error, any of which may pass. */
function transient(error) {
  return error.status === undefined || error.status === 429 || error.status >= 500
}

/** Sends one channel's announcements in order. Each is retried until it lands or the channel refuses it for good. */
export class Outbox {
  constructor(name, send, { retry = 5_000 } = {}) {
    this.name = name
    this.send = send
    this.retry = retry
    this.items = []
    this.drained = Promise.resolve()
  }

  push(item) {
    this.items.push(item)
    if (this.items.length === 1) this.drained = this.drain()
  }

  async drain() {
    while (this.items.length > 0) {
      const item = this.items[0]
      try {
        await this.send(item.announcement, await item.links, item.block)
      } catch (error) {
        if (transient(error)) {
          console.error(`${this.name} announcement of referendum ${item.index} failed, trying again`, error)
          await sleep(this.retry)
          continue
        }
        console.error(`${this.name} turned down the announcement of referendum ${item.index}, dropped`, error)
      }
      this.items.shift()
    }
  }
}

export const discordOutbox = (discord, options) =>
  new Outbox('Discord', (announcement, links, block) => discord.post(discordAnnouncement(announcement, links, block)), options)

export const telegramOutbox = (telegram, options) =>
  new Outbox('Telegram', (announcement, links) => telegram.send(telegramAnnouncement(announcement, links)), options)

/** The public channels hear each text once, and nothing more of it once its referendum is over. */
function newToChannels(heard, { kind, index, text }) {
  return kind !== 'text' || (Boolean(heard.watching[index]) && heard.texts[index] !== text.hash)
}

function hear(heard, { kind, index, text }) {
  if (kind === 'submitted') heard.watching[index] = FRESH
  if (kind === 'submitted' || kind === 'text') heard.texts[index] = text.hash
  if (kind === 'ended') {
    delete heard.watching[index]
    delete heard.texts[index]
  }
}

/**
 * Tells the public channels what happens to referenda from the finalized head
 * it starts at onward. Nothing it heard is saved, so what happens while it is
 * down goes unannounced.
 */
export class Announcer {
  constructor(ctx, outboxes, { height, watching, threadWait = 60_000, poll = 1_000 }) {
    this.ctx = ctx
    this.outboxes = outboxes
    this.height = height
    this.heard = { watching, texts: {} }
    this.threadWait = threadWait
    this.poll = poll
  }

  /** Marks reminders already due as sent, so a start announces none. */
  static async start(ctx, outboxes, height, options = {}) {
    const clock = await clockAt(ctx.chain, height)
    const watching = {}
    for (const index of await ongoingIndexes(clock.api)) {
      const countdown = await countdownAt(clock, index)
      watching[index] = countdown ? reminderFor(FRESH, countdown.deadline, countdown.secondsLeft).watched : FRESH
    }
    return new Announcer(ctx, outboxes, { height, watching, ...options })
  }

  async follow(finalized) {
    if (this.height >= finalized) return
    while (this.height < finalized) {
      await this.read(this.height + 1)
      this.height += 1
    }
    await this.remind(finalized)
  }

  /** Reads all of a block before announcing any of it, so a failed read can start over clean. */
  async read(height) {
    const { pending, block } = await readBlock(this.ctx.chain, height)
    const heard = { watching: { ...this.heard.watching }, texts: { ...this.heard.texts } }
    const items = []
    for (const event of pending) {
      const fact = await factOf(block, event)
      if (!fact || !newToChannels(heard, fact)) continue
      const title = fact.text ? fact.text.title : (await readText(block.api, fact.index)).title
      items.push([fact.index, announcementOf(fact, { explorer: this.ctx.explorer, token: this.ctx.chain.token, title }), block])
      hear(heard, fact)
    }
    this.heard = heard
    for (const item of items) this.announce(...item)
  }

  async remind(height) {
    // A failed read waits for the next head instead of stopping the announcements
    const clock = await clockAt(this.ctx.chain, height).catch((error) => console.error('announced reminders failed', error))
    if (!clock) return
    for (const index of Object.keys(this.heard.watching).map(Number)) {
      await this.remindIfDue(index, clock).catch((error) => console.error(`announced reminder of referendum ${index}`, error))
    }
  }

  async remindIfDue(index, clock) {
    const countdown = await countdownAt(clock, index)
    if (!countdown) return
    const { days, watched } = reminderFor(this.heard.watching[index], countdown.deadline, countdown.secondsLeft)
    if (days !== null) {
      const { title } = await readText(clock.api, index)
      this.announce(index, reminderAnnouncement({ index, days, title, ...countdown }), null)
    }
    this.heard.watching[index] = watched
  }

  /** The referendum's thread once it opens, or nothing when it doesn't open in time. */
  async threadOf(index) {
    const until = Date.now() + this.threadWait
    while (!this.ctx.store.state.threads[index] && Date.now() < until) await sleep(this.poll)
    return this.ctx.store.state.threads[index]?.id
  }

  announce(index, announcement, block) {
    // Every channel waits on the same thread, so waits overlap rather than add up
    const links = this.threadOf(index).then((thread) =>
      announcementLinks({
        explorer: `${this.ctx.explorer}/referendum/${index}`,
        vote: announcement.over ? undefined : voteLink(this.ctx.wallet, index, this.ctx.chain.genesis),
        discussion: thread && discussionLink(this.ctx.discord.guild, thread),
      }),
    )
    for (const outbox of this.outboxes) outbox.push({ index, announcement, block, links })
    console.log(`announcing ${announcement.headline}`)
  }
}
