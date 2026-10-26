import { ApiPromise, WsProvider } from '@polkadot/api'
import { collectSpends, identityName, palletName, readableTrack, splitText } from './message.js'

export class Chain {
  constructor(api) {
    this.api = api
  }

  static async connect(rpc) {
    return new Chain(await ApiPromise.create({ provider: new WsProvider(rpc), noInitWarn: true }))
  }

  get genesis() {
    return this.api.genesisHash.toHex()
  }

  get token() {
    return { decimals: this.api.registry.chainDecimals[0], symbol: this.api.registry.chainTokens[0] }
  }

  /**
   * The newest finalized height. The bot reads no block past it, since an
   * unfinalized block can still be replaced and the bot only moves forward.
   */
  async finalizedHeight() {
    const hash = await this.api.rpc.chain.getFinalizedHead()
    return (await this.api.rpc.chain.getHeader(hash)).number.toNumber()
  }

  onFinalized(listener) {
    void this.api.rpc.chain.subscribeFinalizedHeads((header) => listener(header.number.toNumber()))
  }

  async at(height) {
    return this.api.at(await this.api.rpc.chain.getBlockHash(height))
  }
}

export function eventsAt(api) {
  return api.query.system.events()
}

/** The time a block carries, in seconds. */
export async function timeAt(api) {
  return Number((await api.query.timestamp.now()).toBigInt() / 1000n)
}

async function proposalBytes(api, proposal) {
  switch (proposal.type) {
    case 'Inline':
      return proposal.asInline
    case 'Lookup':
      return (await api.query.preimage.preimageFor([proposal.asLookup.hash, proposal.asLookup.len])).unwrapOr(null)
    case 'Legacy':
      return null
  }
}

export async function readProposal(api, proposal) {
  const bytes = await proposalBytes(api, proposal)
  if (!bytes) return { kind: 'other', label: 'a preimage the chain does not hold' }

  try {
    const call = api.registry.createType('Call', bytes)
    const spends = collectSpends(call)
    return spends.length > 0
      ? { kind: 'spend', spends }
      : { kind: 'other', label: `${palletName(api.registry, call.callIndex[0])}.${call.meta.name}` }
  } catch {
    return { kind: 'other', label: 'a call this build cannot read' }
  }
}

const NO_TEXT = { title: '', description: '' }

/**
 * The metadata names a preimage rather than holding the text, so the text is
 * two more reads away. Its hash comes along to tell one text from another.
 */
export async function readText(api, index) {
  const hash = (await api.query.referenda.metadataOf(index)).unwrapOr(null)?.toHex() ?? null
  if (!hash) return { hash, ...NO_TEXT }

  const status = (await api.query.preimage.requestStatusFor(hash)).unwrapOr(null)
  const len = status?.isUnrequested ? status.asUnrequested.len : status?.asRequested.maybeLen.unwrapOr(null)
  if (!len) return { hash, ...NO_TEXT }

  const bytes = (await api.query.preimage.preimageFor([hash, len])).unwrapOr(null)
  return { hash, ...(bytes ? splitText(new TextDecoder().decode(bytes)) : NO_TEXT) }
}

/** The verified name an account went by at a block, null when it had none. */
export async function nameAt(api, address) {
  const own = (await api.query.identity.identityOf(address)).unwrapOr(null)
  const sub = own ? null : (await api.query.identity.superOf(address)).unwrapOr(null)
  const parent = sub && (await api.query.identity.identityOf(sub[0])).unwrapOr(null)
  return identityName(own, sub, parent)
}

export async function namesAt(api, addresses) {
  const unique = [...new Set(addresses.filter(Boolean))]
  return Object.fromEntries(await Promise.all(unique.map(async (address) => [address, await nameAt(api, address)])))
}

/** The referendum tracks as plain values, each `[id, { name, decisionPeriod, … }]`. */
export function tracksOf(api) {
  return api.consts.referenda.tracks.toPrimitive()
}

export function trackName(api, id) {
  const track = tracksOf(api).find(([trackId]) => trackId === id)
  return track ? readableTrack(track[1].name) : `Track ${id}`
}

/** A referendum as it stood at the end of a block, null once it was over. */
export async function ongoingAt(api, index) {
  const info = (await api.query.referenda.referendumInfoFor(index)).unwrap()
  return info.isOngoing ? info.asOngoing.toPrimitive() : null
}

export function undecidingTimeout(api) {
  return api.consts.referenda.undecidingTimeout.toNumber()
}

export function blockSeconds(api) {
  return api.consts.difficulty.targetBlockTime.toNumber()
}
