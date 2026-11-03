const need = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name} in the environment`)
  return value
}

export const env = {
  rpc: need('NUMEN_RPC'),
  webhook: need('DISCORD_WEBHOOK_URL'),
  generalWebhook: need('DISCORD_GENERAL_WEBHOOK_URL'),
  telegramToken: need('TELEGRAM_BOT_TOKEN'),
  telegramChat: need('TELEGRAM_CHAT_ID'),
  explorer: need('EXPLORER_URL'),
  wallet: need('WALLET_URL'),
  stateDb: need('DB_PATH'),
  httpPort: Number(need('HTTP_PORT')),
}
