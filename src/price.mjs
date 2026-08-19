// What one agent token is worth - read from the pool, not from a service.
//
// v4 keeps every pool inside the PoolManager singleton, so there is no pair contract to call: the
// pool's first state word packs lpFee | protocolFee | tick | sqrtPriceX96 bottom-up, and one
// `extsload` of that word IS the price. It is exact and cannot be stale - it is where the next
// trade starts.
//
// Everything an index adds on top - what moved today, what traded, how deep the book is - is
// history, and history is what DexScreener is for. It never overrides the number above, and a bad
// minute on their side must never fail a report about the agent itself.

import {encodeAbiParameters, keccak256} from 'viem';

/** StateLibrary: `pools[poolId]` lives at keccak256(abi.encode(poolId, 6)). */
const POOLS_SLOT = 6n;

export function poolStateSlot(poolId) {
  return keccak256(encodeAbiParameters([{type: 'bytes32'}, {type: 'uint256'}], [poolId, POOLS_SLOT]));
}

/**
 * How many WHOLE `other` one WHOLE `token` costs, or null when that pool holds no price yet.
 *
 * Which side is token0 is decided by address order, never by which one the caller cares about.
 * Reading it the wrong way round does not fail - it returns the reciprocal, which is a perfectly
 * plausible-looking number and wrong by orders of magnitude.
 */
export function priceIn(word, token, other, decToken, decOther) {
  if (!word) return null;
  const sqrt = BigInt(word) & ((1n << 160n) - 1n);
  if (sqrt === 0n) return null;
  const tokenIsZero = BigInt(token) < BigInt(other);
  const [dec0, dec1] = tokenIsZero ? [decToken, decOther] : [decOther, decToken];
  const root = Number(sqrt) / 2 ** 96;
  const oneZeroInOne = root * root * 10 ** (dec0 - dec1);
  return tokenIsZero ? oneZeroInOne : 1 / oneZeroInOne;
}

/** Today's movement, from the index a human would open. Null on any hiccup, never a throw. */
export async function movement(token) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const {pairs} = await res.json();
    if (!Array.isArray(pairs)) return null;
    // The deepest pool of the two, because a price is only as real as what it can be traded in.
    const best = pairs
      .filter((p) => p?.baseToken?.address?.toLowerCase() === token.toLowerCase())
      .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    if (!best) return null;
    return {
      priceUsd: Number(best.priceUsd) || null,
      change24h: best.priceChange?.h24 ?? null,
      volume24h: best.volume?.h24 ?? null,
      liquidityUsd: best.liquidity?.usd ?? null,
      quote: best.quoteToken?.symbol ?? null,
      url: best.url ?? null,
    };
  } catch {
    return null;
  }
}
