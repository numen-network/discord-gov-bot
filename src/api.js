import { createServer } from 'node:http'
import { discussionLink } from './message.js'

const ROUTE = /^\/discussions\/([^/]+)$/

function reply(res, status, body, cache) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cache,
    'Content-Type': 'application/json',
  })
  res.end(JSON.stringify(body))
}

/** Answers which Discord thread discusses a referendum, read live from the bot's state. */
export function discussionServer(store, guild) {
  return createServer((req, res) => {
    const route = ROUTE.exec(new URL(req.url, 'http://localhost').pathname)
    if (!route) return reply(res, 404, { error: 'not found' }, 'no-store')
    if (!/^\d+$/.test(route[1])) return reply(res, 400, { error: "referendum index isn't a non-negative integer" }, 'no-store')
    const thread = store.state.threads[Number(route[1])]
    // A link never changes, but a missing thread may open any block
    if (!thread) return reply(res, 404, { error: 'no thread for this referendum' }, 'no-cache')
    reply(res, 200, { url: discussionLink(guild, thread.id) }, 'public, max-age=86400')
  })
}
