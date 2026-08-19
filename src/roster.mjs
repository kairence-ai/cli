// Every agent the registry knows - the launchpad's own list, read from the birth records.
//
// This is what makes a ticker usable as an argument. An agent told "buy COPY" should not have to
// be handed an address, and it must never guess one: the only COPY is the row the registry has
// under that symbol, and anything else with the same three letters is a different token entirely.

import {ADDRESSES as A, ADDRESS, abi, client} from './chain.mjs';

/** Every registered agent, with the ticker and name its own token reports. */
export async function roster(c = client()) {
  const count = await c.readContract({address: A.registry, abi, functionName: 'agentCount'});
  const n = Number(count);
  if (n === 0) return [];
  const rows = await c.multicall({
    allowFailure: false,
    contracts: Array.from({length: n}, (_, i) => ({
      address: A.registry,
      abi,
      functionName: 'agentAt',
      args: [BigInt(i)],
    })),
  });
  const tokens = rows.map((r) => r[0]);
  const meta = await c.multicall({
    allowFailure: true,
    contracts: tokens.flatMap((t) => [
      {address: t, abi, functionName: 'symbol'},
      {address: t, abi, functionName: 'name'},
    ]),
  });
  return tokens.map((token, i) => ({
    token,
    vault: rows[i][1],
    ticker: meta[i * 2].status === 'success' ? meta[i * 2].result : '?',
    name: meta[i * 2 + 1].status === 'success' ? meta[i * 2 + 1].result : '',
  }));
}

/**
 * An address, straight through; a ticker, looked up. Ambiguity is refused rather than resolved:
 * two agents may carry the same symbol, and picking one of them silently would spend money on a
 * token nobody asked for.
 */
export async function resolveToken(given, c = client()) {
  if (ADDRESS.test(given)) return given;
  const all = await roster(c);
  const hits = all.filter((a) => a.ticker.toLowerCase() === given.toLowerCase());
  if (hits.length === 1) return hits[0].token;
  if (hits.length > 1) {
    throw new Error(
      `${hits.length} agents call themselves ${given} - name the address: ${hits.map((h) => h.token).join(', ')}`,
    );
  }
  const known = all.map((a) => a.ticker).join(', ');
  throw new Error(`no agent called "${given}" - the launchpad has ${known || 'none yet'}`);
}
