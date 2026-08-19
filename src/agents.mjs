// `kairence agents` - everything the launchpad has launched, and what a dollar buys of it.
//
// The list exists so `buy` can take a ticker: an agent asked to buy COPY needs somewhere to learn
// that COPY is a real row and not a name someone said in chat. Prices come from the pools
// themselves, the same storage word `stats` reads, so the two commands never disagree.

import {formatUnits} from 'viem';
import {ADDRESSES as A, DECIMALS as D, abi, client, requireToken} from './chain.mjs';
import {poolStateSlot, priceIn} from './price.mjs';
import {roster} from './roster.mjs';

function usd(n) {
  if (n === null || !Number.isFinite(n) || n === 0) return '-';
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(Math.min(18, Math.ceil(-Math.log10(n)) + 2))}`;
}

export async function agents(argv) {
  const json = argv.includes('--json');
  const c = client();
  const all = await roster(c);
  if (all.length === 0) {
    console.log('The launchpad has no agents yet.');
    return;
  }

  // Pool ids first, then the words they address: the second round cannot be named until the first
  // answers, and neither depends on anything the caller supplied.
  const ids = await c.multicall({
    allowFailure: true,
    contracts: all.map((a) => ({address: A.registry, abi, functionName: 'poolIdOf', args: [a.token, 1]})),
  });
  const words = await c.multicall({
    allowFailure: true,
    contracts: ids.map((r) => ({
      address: A.poolManager,
      abi,
      functionName: 'extsload',
      args: [poolStateSlot(r.status === 'success' ? r.result : `0x${'0'.repeat(64)}`)],
    })),
  });
  const supplies = await c.multicall({
    allowFailure: true,
    contracts: all.map((a) => ({address: a.token, abi, functionName: 'totalSupply'})),
  });

  const mine = (() => {
    try {
      return requireToken().toLowerCase();
    } catch {
      return null;
    }
  })();

  const rows = all.map((a, i) => {
    const price = words[i].status === 'success' ? priceIn(words[i].result, a.token, A.usdc, D.agent, D.usdc) : null;
    const supply = supplies[i].status === 'success' ? Number(formatUnits(supplies[i].result, D.agent)) : null;
    return {...a, priceUsd: price, marketCapUsd: price !== null && supply !== null ? price * supply : null};
  });

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`${rows.length} agent${rows.length === 1 ? '' : 's'} on the launchpad:\n`);
  console.log(`  ${'ticker'.padEnd(8)} ${'price'.padEnd(12)} ${'mcap'.padEnd(10)} token`);
  for (const r of rows) {
    const you = mine && r.token.toLowerCase() === mine ? '  <- you' : '';
    console.log(`  ${r.ticker.padEnd(8)} ${usd(r.priceUsd).padEnd(12)} ${usd(r.marketCapUsd).padEnd(10)} ${r.token}${you}`);
  }
  console.log(`\n\`kairence buy 5 ${rows[0].ticker}\` buys that one. \`kairence stats <ticker or address>\` reads it.`);
}
