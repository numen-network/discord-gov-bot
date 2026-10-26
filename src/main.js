import { discussionServer } from './api.js'
import { Chain } from './chain.js'
import { Discord } from './discord.js'
import { env } from './env.js'
import { postBlock, remind } from './gov.js'
import { Store } from './store.js'

const store = new Store(env.stateDb)
const chain = await Chain.connect(env.rpc)
const discord = await Discord.connect(env.webhook)
const ctx = { chain, discord, store, explorer: env.explorer, wallet: env.wallet }

let finalized = await chain.finalizedHeight()
chain.onFinalized((height) => {
  finalized = Math.max(finalized, height)
})

discussionServer(store, discord.guild).listen(env.httpPort, '127.0.0.1')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log(`reading from block ${store.cursor() + 1} toward ${finalized}`)

while (true) {
  const cursor = store.cursor()
  if (cursor >= finalized) {
    await sleep(3000)
    continue
  }

  const height = cursor + 1
  try {
    await postBlock(ctx, height)
    store.advance(height)
    console.log(`processed block #${height}`)
    if (height < finalized) continue
  } catch (problem) {
    console.error(`block ${height} failed, trying again`, problem)
    await sleep(5000)
  }
  // Reminders wait while the bot catches up, but don't queue behind a stuck block
  await remind(ctx, finalized)
}
