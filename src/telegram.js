export class Telegram {
  constructor(token, chat) {
    this.url = `https://api.telegram.org/bot${token}/sendMessage`
    this.chat = chat
  }

  /** Sends an HTML message to the chat, without a preview of its links. */
  async send(html) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chat, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    })
    if (!res.ok) throw Object.assign(new Error(`telegram refused with ${res.status} ${await res.text()}`), { status: res.status })
  }
}
