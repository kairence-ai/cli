// `kairence buy <usdc> [token]` - buying any token on the launchpad, out of the agent's own
// account. With nothing named it buys the agent's own; a ticker or an address names another.
//
// It buys through the USDC pool, not the kDIEM one: USDC is what a withdrawal pays out, and the
// USDC pair is the leg aggregators route. Nothing here is Kairence infrastructure except the
// registry row that hands over the pool key - the fill is canonical Uniswap, the same path any
// other buyer takes.
//
// Only registered agents, and that is a guard rather than a limitation: the whole method here is
// reading a pool key out of the registry, so a token with no row has no key and would have to be
// priced off something this command cannot see.
//
// The bound is the agent's own. There is no oracle and no protocol-side floor: the quote comes
// from the pool, the minimum is that quote less a tolerance, and a fill under it reverts. Past a
// visible depth cost the command stops instead, because an agent buying a thin token can move its
// own price several percent without ever being told.

import {formatUnits, parseUnits} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ADDRESSES as A, DECIMALS as D, abi, client, requireToken, walletClient} from './chain.mjs';
import {readConfig} from './config.mjs';
import {keyPath, readKey} from './key.mjs';
import {flagValue} from './prompt.mjs';
import {resolveToken} from './roster.mjs';
import {poolStateSlot, priceIn} from './price.mjs';
import {
  IMPACT_STOP_PCT,
  LEG_USDC,
  MAX_UINT160,
  MAX_UINT256,
  PERMIT2,
  PERMIT2_EXPIRY_SECONDS,
  UNIVERSAL_ROUTER,
  V4_QUOTER,
  applySlippage,
  direction,
  priceImpactPct,
  swapRequest,
  tradeAbi,
} from './trade.mjs';

const DEFAULT_SLIPPAGE_PCT = 1;

/** keccak256("Transfer(address,address,uint256)") - the only log shape this needs to read. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** How much of `token` the receipt says landed on `to`. Authoritative: it IS the mined block. */
function received(receipt, token, to) {
  const want = to.toLowerCase();
  return receipt.logs
    .filter(
      (l) =>
        l.address.toLowerCase() === token.toLowerCase() &&
        l.topics[0] === TRANSFER &&
        l.topics[2] &&
        `0x${l.topics[2].slice(26)}`.toLowerCase() === want,
    )
    .reduce((sum, l) => sum + BigInt(l.data), 0n);
}

export async function buy(argv) {
  const bare = argv.filter((a) => !a.startsWith('--'));
  if (!bare[0]) throw new Error('how much? `kairence buy 5` spends 5 USDC on your own token');
  const json = argv.includes('--json');
  const force = argv.includes('--yes');

  const token = bare[1] ? await resolveToken(bare[1]) : requireToken();
  let amountIn;
  try {
    amountIn = parseUnits(bare[0], D.usdc);
  } catch {
    throw new Error(`"${bare[0]}" is not an amount - write it in whole USDC, like 5`);
  }
  if (amountIn === 0n) throw new Error('zero is not a purchase');

  const pct = Number(flagValue(argv, 'slippage') ?? DEFAULT_SLIPPAGE_PCT);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 50) {
    throw new Error('--slippage is a percent between 0 and 50, like 1');
  }
  const bps = Math.round(pct * 100);

  const key = readKey(token);
  if (key === null) {
    const external = readConfig(token).externalAccount;
    throw new Error(
      external
        ? `your account ${external} is held elsewhere - this machine cannot sign`
        : `no account key for ${token} here - run \`kairence init\` (expected ${keyPath(token)})`,
    );
  }
  const account = privateKeyToAccount(key);
  const c = client();

  const registered = await c.readContract({address: A.registry, abi, functionName: 'isAgent', args: [token]});
  if (!registered) {
    throw new Error(`${token} is not a token from this launchpad - \`kairence agents\` lists the ones that are`);
  }

  const [poolKey, held, gas] = await Promise.all([
    c.readContract({address: A.registry, abi: tradeAbi, functionName: 'poolKey', args: [token, LEG_USDC]}),
    c.readContract({address: A.usdc, abi, functionName: 'balanceOf', args: [account.address]}),
    c.getBalance({address: account.address}),
  ]);
  const dir = direction(poolKey, A.usdc);
  if (!dir) throw new Error(`the USDC pool of ${token} does not hold USDC - refusing to guess`);
  if (held < amountIn) {
    throw new Error(
      `your account holds ${formatUnits(held, D.usdc)} USDC - take more from your safe first with \`kairence withdraw\``,
    );
  }
  if (gas === 0n) {
    throw new Error(`${account.address} has no ETH for gas - ask your human for a few cents' worth on Base`);
  }

  // The quote unlocks the manager and reverts internally to report the fill, so it is simulated.
  let quoted;
  try {
    const sim = await c.simulateContract({
      account,
      address: V4_QUOTER,
      abi: tradeAbi,
      functionName: 'quoteExactInputSingle',
      args: [{poolKey, zeroForOne: dir.zeroForOne, exactAmount: amountIn, hookData: '0x'}],
    });
    quoted = sim.result[0];
  } catch (e) {
    throw new Error(`the pool could not quote that (${e.shortMessage || e.message}) - try a smaller size`);
  }
  if (quoted === 0n) throw new Error('the pool quotes nothing for that size - it has no depth to fill it');
  const minOut = applySlippage(quoted, bps);

  // What the trade costs in price, separated from what the pool's fee costs. Read from the same
  // storage word `stats` prices with, so the two commands can never disagree.
  const poolId = await c.readContract({address: A.registry, abi, functionName: 'poolIdOf', args: [token, LEG_USDC]});
  const word = await c.readContract({
    address: A.poolManager,
    abi,
    functionName: 'extsload',
    args: [poolStateSlot(poolId)],
  });
  const usdcPerToken = priceIn(word, token, A.usdc, D.agent, D.usdc);
  const spotOutPerIn = usdcPerToken ? 1 / usdcPerToken : 0;
  const inWhole = Number(formatUnits(amountIn, D.usdc));
  const outWhole = Number(formatUnits(quoted, D.agent));
  const impact = priceImpactPct(spotOutPerIn, poolKey.fee, inWhole, outWhole);
  if (impact > IMPACT_STOP_PCT && !force) {
    throw new Error(
      `that size moves your own price ${impact.toFixed(1)}% - the pool is too thin for it. Buy less, or pass --yes if you mean it`,
    );
  }

  // Two approvals, each granted once: the ERC-20 one lets Permit2 hold the token, the Permit2 one
  // lets the router spend it, and only the second expires.
  const w = walletClient(account);
  const steps = [];
  const erc20 = await c.readContract({
    address: A.usdc,
    abi: tradeAbi,
    functionName: 'allowance',
    args: [account.address, PERMIT2],
  });
  if (erc20 < amountIn) {
    const hash = await w.writeContract({
      address: A.usdc,
      abi: tradeAbi,
      functionName: 'approve',
      args: [PERMIT2, MAX_UINT256],
    });
    await c.waitForTransactionReceipt({hash});
    steps.push({what: 'let Permit2 hold your USDC', hash});
  }
  const [allowed, expiration] = await c.readContract({
    address: PERMIT2,
    abi: tradeAbi,
    functionName: 'allowance',
    args: [account.address, A.usdc, UNIVERSAL_ROUTER],
  });
  const now = Math.floor(Date.now() / 1000);
  if (allowed < amountIn || Number(expiration) <= now) {
    const hash = await w.writeContract({
      address: PERMIT2,
      abi: tradeAbi,
      functionName: 'approve',
      args: [A.usdc, UNIVERSAL_ROUTER, MAX_UINT160, now + PERMIT2_EXPIRY_SECONDS],
    });
    await c.waitForTransactionReceipt({hash});
    steps.push({what: 'let the router spend it', hash});
  }

  const hash = await w.writeContract(swapRequest({key: poolKey, dir, amountIn, minOut}, now));
  const receipt = await c.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') throw new Error(`the swap reverted on chain - ${hash}`);

  // What arrived is read from the receipt, never from a balance before and a balance after. Those
  // two reads can land on a node that has not caught up, and their difference is then zero - a
  // command reporting "you bought 0" about a fill that actually happened, which is the one wrong
  // answer that would make an agent buy again.
  const got = received(receipt, token, account.address);
  const ticker = await c.readContract({address: token, abi, functionName: 'symbol'});
  const paid = Number(formatUnits(amountIn, D.usdc)) / Number(formatUnits(got, D.agent));

  if (json) {
    console.log(
      JSON.stringify(
        {
          hash,
          spentUsdc: formatUnits(amountIn, D.usdc),
          received: formatUnits(got, D.agent),
          ticker,
          pricePaidUsd: paid,
          priceImpactPct: impact,
          approvals: steps,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`You bought ${formatUnits(got, D.agent)} ${ticker} for ${formatUnits(amountIn, D.usdc)} USDC.`);
  console.log('');
  for (const s of steps) console.log(`  first     ${s.what} - ${s.hash}`);
  console.log(`  tx        ${hash}`);
  console.log(`  paid      $${paid.toPrecision(3)} each`);
  console.log(`  impact    ${impact.toFixed(2)}%  (how far your own buy moved the price)`);
  console.log(`  holding   \`kairence stats\` counts what you hold now`);
}
