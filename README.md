## How it works

The bot follows the chain's finalized blocks as they come and reads each one in order from genesis. It posts what every referendum event in them means through a Discord webhook. No bot token and no extra permissions are involved, the webhook URL is the only credential.

A submission opens the referendum's thread. The post carries a `thread_name`, which makes Discord create a forum post. It shows the referendum as it stood at the end of the block it was submitted in, with its title, description, track, proposer and what it spends. Instalments show as a single total, with the schedule a click away on the explorer. The title and description are whatever the proposer wrote, so they are clipped to Discord's limits and shown with markdown escaped.

Every later step lands in the same thread. That covers a new or removed text while the referendum runs, the decision deposit, the decision and its confirmation starting or falling through, the outcome, and whether the passed call ran once its enactment came due. The scheduler reports that last step under a task name hashed from the referendum's index. A text the thread already shows isn't posted twice, which covers the one a proposer sets in the same block as the submission. Refunded and slashed deposits get no notice. Each notice names the block it reports on and that block's time, since it may go out long after.

Accounts in a post go by the name of their verified identity at the block it reports on, labelled the way the explorer labels them, and by a short address when they have none. A name counts only with a Reasonable or KnownGood judgement and no Erroneous or LowQuality one, since Discord has no badge to set it apart from one anybody could claim.

While a referendum runs, the bot also posts in its thread when 7, 3 and 1 days are left. A confirming referendum counts down to the end of its confirmation, when it passes unless approval or support falls short. One deciding but not confirming counts down to the end of its decision period. One that has not started deciding counts down to `UndecidingTimeout`, when it times out. One queued for a decision slot can't time out and gets no reminder. A countdown starts over whenever its end moves, as when confirmation starts or falls through. Blocks turn into time at the chain's target block time. A bot that was down posts only the nearest reminder it missed.

`DB_PATH`, a SQLite database, holds how far the bot has read, down to the event within a block. It also keeps every thread ID and the reminders already sent, so a restart picks up where it left off. The bot moves past an event only once Discord has taken its post, so a crash at the wrong moment can repeat that one post but never drop one. A post that fails goes out again 5 seconds later. A post Discord turns down for good, because a moderator deleted or locked its thread, is dropped rather than holding up the rest.

## API

The bot answers which thread discusses a referendum, so the explorer and any wallet can link to it. It listens on `127.0.0.1` at `HTTP_PORT`.

| network | base URL |
| ------- | -------- |
| mainnet | `https://discussions.numen-network.org` |
| testnet | `https://testnet.discussions.numen-network.org` |

`GET /discussions/<index>` returns `{"url":"https://discord.com/channels/<server>/<thread>"}`.

| status | meaning | cache |
| ------ | ------- | ----- |
| 200 | the referendum's thread | one day |
| 404 | no thread yet | none |
| 400 | the index isn't a non-negative integer | none |

Every answer carries `Access-Control-Allow-Origin: *`, so a web page can call it straight from the browser. A thread's URL never changes once it opens. The server ID comes from the webhook itself. Check the URL is a Discord thread before turning it into a link.

## Requirements

- Node 24.4+ and pnpm
- An archive node, for state at every block since genesis
- A Discord server where you can add a forum channel and a webhook

## Run

1. Create a channel of type Forum in the Discord server and leave tags optional, or the bot can't open threads.
2. Add a webhook to that channel under channel settings, Integrations, Webhooks, and copy its URL.
3. Copy `.env.example` to `.env` and fill in the webhook URL.

```bash
pnpm install
pnpm build
pnpm test
node --env-file=.env src/main.js
```

### Run it as a service

numen-discord-gov-bot.service

```ini
[Unit]
Description=Numen Discord Gov Bot
After=network-online.target numen.service
Wants=network-online.target

[Service]
WorkingDirectory=/opt/discord-gov-bot
ExecStart=/usr/bin/node --env-file=/opt/discord-gov-bot/.env /opt/discord-gov-bot/src/main.js
Restart=always
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

### Put it behind a reverse proxy

Point the API's hostname at the server and let the proxy handle TLS.

```caddy
discussions.example.com {
	reverse_proxy 127.0.0.1:<HTTP_PORT>
}
```

## Updating

```bash
git pull && pnpm install --frozen-lockfile
systemctl restart numen-discord-gov-bot
```
