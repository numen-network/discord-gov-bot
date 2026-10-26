// Discord refuses posts into a thread for good once it is deleted (10003) or
// locked (160005, or 50083 when it is archived too)
const CLOSED_THREAD = [10003, 50083, 160005]

export class Discord {
  constructor(webhook, guild) {
    this.webhook = webhook
    this.guild = guild
  }

  /** The server ID a thread link needs. The webhook URL alone is enough to ask for it. */
  static async connect(webhook) {
    const res = await fetch(webhook)
    if (!res.ok) throw new Error(`webhook lookup refused with ${res.status} ${await res.text()}`)
    return new Discord(webhook, (await res.json()).guild_id)
  }

  /** Posts as the webhook, into a thread of its forum when one is named. */
  async post(payload, thread) {
    const url = new URL(this.webhook)
    url.searchParams.set('wait', 'true')
    if (thread) url.searchParams.set('thread_id', thread)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw await refusal(res)
    return res.json()
  }
}

export function threadClosed(error) {
  return CLOSED_THREAD.includes(error.code)
}

/** A refused post as an error, with Discord's JSON error code when the body carries one. */
async function refusal(res) {
  const body = await res.text()
  return Object.assign(new Error(`webhook refused with ${res.status} ${body}`), { code: errorCode(body) })
}

function errorCode(body) {
  try {
    return JSON.parse(body).code
  } catch {
    return undefined
  }
}
