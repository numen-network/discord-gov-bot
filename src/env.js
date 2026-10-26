const need = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name} in the environment`)
  return value
}

export const env = {
  rpc: need('NUMEN_RPC'),
  webhook: need('DISCORD_WEBHOOK_URL'),
  explorer: need('EXPLORER_URL'),
  wallet: need('WALLET_URL'),
  stateDb: need('DB_PATH'),
  httpPort: Number(need('HTTP_PORT')),
}
