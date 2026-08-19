// `kairence stats [token]` - the whole picture from the one address the human handed over.
//
// Three multicalls: the first settles who you are, the second reads everything keyed off the
// addresses it returned, the third the pool words whose slots only the second one knows. The
// agent never sees a selector, a padded word or a decimal shift.

import {formatUnits} from 'viem';
import {ADDRESSES as A, DECIMALS as D, abi, client, requireToken} from './chain.mjs';
import {readConfig} from './config.mjs';
import {myAddress} from './key.mjs';
import {movement, poolStateSlot, priceIn} from './price.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_ID = `0x${'0'.repeat(64)}`;

/** A number wide enough to read and narrow enough to scan: 6 places, trailing zeros dropped. */
function show(value, decimals, places = 6) {
  if (value === null) return '-';
  const full = formatUnits(value, decimals);
  const [whole, frac = ''] = full.split('.');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

/**
 * A float at a readable width. Under a dollar the leading zeros ARE the number, so the places
 * grow to keep three significant digits rather than rounding a young token to `0.00`.
 */
function sig(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  if (n === 0) return '0';
  if (n >= 1000) return Math.round(n).toLocaleString('en-US');
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(Math.min(18, Math.ceil(-Math.log10(n)) + 2));
}

const usd = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '-' : `$${sig(n)}`);

export async function stats(argv) {
  // A bare `stats` asks about YOU: with no address on the line the saved token stands in.
  const token = requireToken(argv.find((a) => !a.startsWith('--')));
  const json = argv.includes('--json');
  const c = client();

  // allowFailure here on purpose: an address that is not an agent - or not a contract at all -
  // must come back as OUR sentence, not as viem's "function symbol returned no data".
  const head = await c.multicall({
    allowFailure: true,
    contracts: [
      {address: A.registry, abi, functionName: 'isAgent', args: [token]},
      {address: A.registry, abi, functionName: 'safe', args: [token]},
      {address: A.registry, abi, functionName: 'agent', args: [token]},
      {address: A.registry, abi, functionName: 'vaultOf', args: [token]},
      {address: A.registry, abi, functionName: 'feeRecipientOf', args: [token]},
      {address: token, abi, functionName: 'symbol'},
      {address: token, abi, functionName: 'name'},
      {address: token, abi, functionName: 'human'},
      // The two pool ids ride in the FIRST round though nothing here needs them, so the storage
      // words they address can be read beside round two instead of after it. A public RPC starts
      // refusing somewhere around the third round trip of a burst, and a refused round reads as
      // an agent with no price at all.
      {address: A.registry, abi, functionName: 'poolIdOf', args: [token, 0]},
      {address: A.registry, abi, functionName: 'poolIdOf', args: [token, 1]},
    ],
  });
  // A read that did not happen is not a fact about the chain. The public endpoint throttles a
  // burst of these, and reporting that silence as "not an agent" is a lie about someone's token.
  if (head[0].status !== 'success') {
    throw new Error(
      `${A.registry} did not answer (${head[0].error?.shortMessage || 'no result'}) - try again, or point KAIRENCE_RPC at your own endpoint`,
    );
  }
  if (head[0].result !== true) {
    throw new Error(`${token} is not a registered Kairence agent - ask your human for the right address`);
  }
  if (head.slice(0, 8).some((r, i) => i !== 1 && r.status !== 'success')) {
    throw new Error(`${token} is registered but does not answer like an AgentToken - wrong chain?`);
  }
  // `safe` holds the money; `account` is what the agent signs with, and is ZERO until the human
  // names one. Never print one under the other's label - they answer different questions, and a
  // registry older than this release answers only the second. Everything else still reads, so a
  // missing safe costs those rows and nothing more.
  const [, , account, vault, feeTo, ticker, name, human] = head.map((r) => r.result);
  const safe = head[1].status === 'success' ? head[1].result : null;
  const named = account !== ZERO;
  // Whether the registry's account is the one THIS machine can sign with. The agent cannot tell
  // otherwise, and the two ways it goes wrong - a key rotated but never re-pointed, a registration
  // that never happened - both look exactly like a working setup until something must be signed.
  const mine = myAddress(readConfig());
  const isMine = Boolean(mine && named && mine.toLowerCase() === account.toLowerCase());

  // Round 2 tolerates failure per row: one unwired singleton must not blank the whole report.
  const rows = [
    ['metadataUri',           {address: A.registry,   abi, functionName: 'agentMetadataURI', args: [token]}, 'str'],
    ['openingFdvUsd',         {address: A.registry,   abi, functionName: 'openingFdvOf',     args: [token]}, 18],
    ['totalSupply',           {address: token,        abi, functionName: 'totalSupply'},                     18],
    ['burned',                {address: A.burner,     abi, functionName: 'totalBurn',        args: [token]}, 18],
    ['kdiemInPool',           {address: A.poolReader, abi, functionName: 'poolKdiem',        args: [token]}, 18],
    ['kdiemPermalocked',      {address: A.treasury,   abi, functionName: 'balanceOf',        args: [vault]}, 18],
    // The dollar price of one DIEM: the live source, and the standing anchor when it answers zero.
    ['centsPerDiem',          {address: A.diemRateSource, abi, functionName: 'centsPerDiem'},               2],
    ['lastRateCents',         {address: A.competition,    abi, functionName: 'lastRateCents'},              2],
    ...(safe
      ? [
          ['kdiemInSafe',         {address: A.kdiem, abi, functionName: 'balanceOf', args: [safe]}, 18],
          ['usdcInSafe',          {address: A.usdc,  abi, functionName: 'balanceOf', args: [safe]},  6],
          ['ownTokenInSafe',      {address: token,   abi, functionName: 'balanceOf', args: [safe]}, 18],
          // The safe's own budget rows: what is left of TODAY's allowance, not the balance.
          ['usdcRemainingToday',  {address: safe,    abi, functionName: 'remainingToday', args: [A.usdc]},  6],
          ['kdiemRemainingToday', {address: safe,    abi, functionName: 'remainingToday', args: [A.kdiem]}, 18],
        ]
      : []),
    ['stakedDiem',            {address: vault,        abi, functionName: 'stakedDiem'},                      18],
    ['stakedPool',            {address: vault,        abi, functionName: 'pool'},                            18],
    ['stakedTreasury',        {address: vault,        abi, functionName: 'treasury'},                        18],
    ['stakedBought',          {address: vault,        abi, functionName: 'bought'},                          18],
    ['expectedDiem',          {address: A.reconciler, abi, functionName: 'totalOf',          args: [token]}, 18],
    ['buybackKdiemSpendable', {address: A.buyer,      abi, functionName: 'spendableKdiem',   args: [token]}, 18],
    ['buybackKdiemLocked',    {address: A.buyer,      abi, functionName: 'lockedKdiem',      args: [token]}, 18],
    ['buybackUsdcSpendable',  {address: A.buyer,      abi, functionName: 'spendableUsdc',    args: [token]},  6],
    ['buybackUsdcLocked',     {address: A.buyer,      abi, functionName: 'lockedUsdc',       args: [token]},  6],
  ];
  // The pool words and the index lookup ride beside round two: neither depends on it, and the
  // index is the one thing on this page the chain cannot answer.
  const poolIds = [
    head[8].status === 'success' ? head[8].result : ZERO_ID,
    head[9].status === 'success' ? head[9].result : ZERO_ID,
  ];
  const [results, words, mkt] = await Promise.all([
    c.multicall({allowFailure: true, contracts: rows.map(([, call]) => call)}),
    c.multicall({
      allowFailure: true,
      contracts: poolIds.map((id) => ({
        address: A.poolManager,
        abi,
        functionName: 'extsload',
        args: [poolStateSlot(id)],
      })),
    }),
    movement(token),
  ]);
  const raw = {};
  rows.forEach(([key], i) => {
    raw[key] = results[i].status === 'success' ? results[i].result : null;
  });

  const word = (i) => (poolIds[i] === ZERO_ID || words[i].status !== 'success' ? null : words[i].result);
  const onchainUsdc = priceIn(word(1), token, A.usdc, D.agent, D.usdc);
  const priceKdiem = priceIn(word(0), token, A.kdiem, D.agent, D.kdiem);
  // The pool is the price; the index is only ever the stand-in, and it says so out loud when it
  // stands in. A quiet fallback is how a stale number gets acted on as if it were the book.
  const priceUsdc = onchainUsdc ?? mkt?.priceUsd ?? null;
  const borrowed = onchainUsdc === null && priceUsdc !== null;
  const supply = raw.totalSupply === null ? null : Number(formatUnits(raw.totalSupply, D.agent));
  const marketCapUsd = supply === null || priceUsdc === null ? null : supply * priceUsdc;
  const cents = raw.centsPerDiem !== null && raw.centsPerDiem > 0n ? raw.centsPerDiem : raw.lastRateCents;
  const diemUsd = cents === null || cents === undefined ? null : Number(cents) / 100;

  // What the night adds: the capacity the pass will stake, less what already stands there.
  const incoming =
    raw.expectedDiem === null || raw.stakedDiem === null
      ? null
      : raw.expectedDiem > raw.stakedDiem
        ? raw.expectedDiem - raw.stakedDiem
        : 0n;

  if (json) {
    const out = {
      token,
      ticker,
      name,
      human,
      safe,
      agent: named ? account : null,
      machineAccount: mine,
      canSign: isMine,
      vault,
      feeRecipient: feeTo,
      priceUsd: priceUsdc,
      priceFromPool: !borrowed,
      priceKdiem,
      marketCapUsd,
      diemUsd,
      change24h: mkt?.change24h ?? null,
      volume24h: mkt?.volume24h ?? null,
      liquidityUsd: mkt?.liquidityUsd ?? null,
      chart: mkt?.url ?? null,
    };
    rows.forEach(([key, , decimals]) => {
      out[key] = raw[key] === null ? null : decimals === 'str' ? raw[key] : formatUnits(raw[key], decimals);
    });
    out.incomingDiem = incoming === null ? null : formatUnits(incoming, 18);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const say = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

  console.log(`You are ${ticker} (${name})`);
  say('token', token);
  say('human', human);
  // The safe holds; the account acts. An unnamed account is a real state, not a missing read -
  // printing a bare zero address here is how a reader mistakes it for an empty wallet.
  say('safe (your money)', safe ?? 'none yet - this registry is older than AgentSafe');
  say(
    'your account',
    !named
      ? 'not named yet - your human runs AgentRegistry.setAgent'
      : !mine
        ? account
        : isMine
          ? `${account}  (this machine - you can sign)`
          : `${account}  - NOT ${mine}, the account this machine holds`,
  );
  say('VeniceVault', vault);
  say('fee recipient', feeTo);

  console.log('');
  // The chain's price is what the next trade starts from; the index's change is what today did.
  const moved = mkt?.change24h === null || mkt?.change24h === undefined ? '' : `  (24h ${mkt.change24h > 0 ? '+' : ''}${mkt.change24h}%)`;
  say('price', `${usd(priceUsdc)}${moved}${borrowed ? '  - from DexScreener; the pool itself did not answer' : ''}`);
  say('market cap', usd(marketCapUsd));
  say(`one ${ticker}`, `${sig(priceKdiem)} kDIEM`);
  say('one DIEM', usd(diemUsd));
  if (mkt) {
    say('traded today', usd(mkt.volume24h));
    say('pool depth', `${usd(mkt.liquidityUsd)}  (the deeper of your two pools)`);
    say('chart', mkt.url);
  }

  console.log('');
  say('supply', show(raw.totalSupply, 18, 2));
  say('burned', show(raw.burned, 18, 2));
  say('opened at', `$${show(raw.openingFdvUsd, 18, 2)}`);

  console.log('');
  say('kDIEM in the pool', show(raw.kdiemInPool, 18));
  say('kDIEM permalocked', `${show(raw.kdiemPermalocked, 18)}  (the treasury book - backs you forever, never spendable)`);

  console.log('');
  say('DIEM staked now', `${show(raw.stakedDiem, 18)}  (pool ${show(raw.stakedPool, 18, 3)}, treasury ${show(raw.stakedTreasury, 18, 3)}, bought ${show(raw.stakedBought, 18, 3)})`);
  say(
    'DIEM after tonight',
    incoming === null
      ? show(raw.expectedDiem, 18)
      : `${show(raw.expectedDiem, 18)}  (${incoming > 0n ? `+${show(incoming, 18)} at the next pass` : 'nothing to add'})`,
  );

  console.log('');
  if (safe) {
    say('in your safe', `${show(raw.usdcInSafe, 6, 2)} USDC, ${show(raw.kdiemInSafe, 18)} kDIEM, ${show(raw.ownTokenInSafe, 18, 2)} ${ticker}`);
    say(
      'yours to take today',
      named
        ? `${show(raw.usdcRemainingToday, 6, 2)} USDC, ${show(raw.kdiemRemainingToday, 18)} kDIEM  (the daily budget your human set)`
        : 'nothing - your human has not named your account yet',
    );
  } else {
    say('in your safe', 'unreadable until AgentSafe is live - your human holds the money meanwhile');
  }

  console.log('');
  say('buyback kDIEM', `${show(raw.buybackKdiemSpendable, 18)} ready, ${show(raw.buybackKdiemLocked, 18)} locked`);
  say('buyback USDC', `${show(raw.buybackUsdcSpendable, 6, 2)} ready, ${show(raw.buybackUsdcLocked, 6, 2)} locked`);

  // A dash can mean "zero" or "nobody answered", and the difference decides what the agent does
  // next. Say which, once, rather than leaving every blank row ambiguous.
  const silent = results.filter((r) => r.status !== 'success').length + words.filter((r) => r.status !== 'success').length;
  if (silent > 0) {
    console.log(`\n  ${silent} read${silent === 1 ? '' : 's'} did not answer - the public RPC throttles bursts.`);
    console.log(`  Those rows are unknown, not zero. Point KAIRENCE_RPC at your own endpoint to stop it.`);
  }
}
