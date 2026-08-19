// The trade seam - canonical Uniswap on Base, nothing of ours.
//
// Every agent has two hookless standard v4 pools, and both are filled through the same public
// infrastructure any other trader uses: V4Quoter for the number, UniversalRouter (+ Permit2) for
// the fill. That is the point of the pools being hookless, and it is why this file names no
// Kairence contract except the registry row that hands over the pool key.
//
// P13, the taker's bound: the swapper holds `amountOutMinimum` themselves. No oracle is consulted
// anywhere here and no protocol-side bound exists - the quote is read from the pool, the minimum
// is that quote less the caller's own tolerance, and a fill below it reverts.
//
// VERIFIED AGAINST THE DEPLOYED ROUTER: `ExactInputSingleParams` has FIVE fields here. The newer
// v4-periphery carries a sixth, and that encoding reverts on the router actually on Base.

import {encodeAbiParameters, parseAbi} from 'viem';

export const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const V4_QUOTER = '0x0d5e0F971ED27FBfF6c2837bf31316121532048D';

/** The registry's own Leg enum: 0 is the kDIEM pool, 1 the USDC one. */
export const LEG_KDIEM = 0;
export const LEG_USDC = 1;

const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';

export const tradeAbi = parseAbi([
  `function poolKey(address, uint8) view returns (${POOL_KEY})`,
  // Nonpayable on purpose: it unlocks the manager and reverts internally to report the fill, so
  // it must be SIMULATED, never read as a view.
  `function quoteExactInputSingle((${POOL_KEY} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  // Permit2's own two-part allowance: an amount that is a uint160 and an expiry that is a uint48.
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
  'error NotEnoughLiquidity(bytes32 poolId)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
]);

/** Permit2 ceilings, and how long an approval stays live. */
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const PERMIT2_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
const SWAP_DEADLINE_SECONDS = 20 * 60;

/**
 * Which way a swap runs through `key`, derived from the key the registry returned rather than
 * assumed from the leg: an agent token whose address sorts the other way flips currency0 and
 * currency1, and this is the only place that matters.
 */
export function direction(key, tokenIn) {
  const t = tokenIn.toLowerCase();
  if (t === key.currency0.toLowerCase()) {
    return {zeroForOne: true, currencyIn: key.currency0, currencyOut: key.currency1};
  }
  if (t === key.currency1.toLowerCase()) {
    return {zeroForOne: false, currencyIn: key.currency1, currencyOut: key.currency0};
  }
  return undefined;
}

const V4_SWAP = '0x10';
/** SWAP_EXACT_IN_SINGLE (0x06) -> SETTLE_ALL (0x0c) -> TAKE_ALL (0x0f). */
const ACTIONS_EXACT_IN_SINGLE = '0x060c0f';

const POOL_KEY_TUPLE = {
  name: 'poolKey',
  type: 'tuple',
  components: [
    {name: 'currency0', type: 'address'},
    {name: 'currency1', type: 'address'},
    {name: 'fee', type: 'uint24'},
    {name: 'tickSpacing', type: 'int24'},
    {name: 'hooks', type: 'address'},
  ],
};

const EXACT_IN_SINGLE_PARAMS = [
  {
    name: 'params',
    type: 'tuple',
    components: [
      POOL_KEY_TUPLE,
      {name: 'zeroForOne', type: 'bool'},
      {name: 'amountIn', type: 'uint128'},
      {name: 'amountOutMinimum', type: 'uint128'},
      {name: 'hookData', type: 'bytes'},
    ],
  },
];

const CURRENCY_AMOUNT = [
  {name: 'currency', type: 'address'},
  {name: 'amount', type: 'uint256'},
];

const V4_INPUT = [
  {name: 'actions', type: 'bytes'},
  {name: 'params', type: 'bytes[]'},
];

/** The one write: `UniversalRouter.execute` for a single-hop exact-input swap. */
export function swapRequest({key, dir, amountIn, minOut}, nowSeconds) {
  const swap = encodeAbiParameters(EXACT_IN_SINGLE_PARAMS, [
    {poolKey: key, zeroForOne: dir.zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x'},
  ]);
  // SETTLE_ALL caps what the router may pull from us; TAKE_ALL floors what we must be handed.
  // Both sides of the fill are bounded by numbers the taker chose.
  const settle = encodeAbiParameters(CURRENCY_AMOUNT, [dir.currencyIn, amountIn]);
  const take = encodeAbiParameters(CURRENCY_AMOUNT, [dir.currencyOut, minOut]);
  const input = encodeAbiParameters(V4_INPUT, [ACTIONS_EXACT_IN_SINGLE, [swap, settle, take]]);
  return {
    address: UNIVERSAL_ROUTER,
    abi: tradeAbi,
    functionName: 'execute',
    args: [V4_SWAP, [input], BigInt(nowSeconds + SWAP_DEADLINE_SECONDS)],
  };
}

/** The taker's bound: the live quote less their own tolerance. */
export function applySlippage(quote, bps) {
  return (quote * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * How far the realized rate lands below the FEE-ADJUSTED spot mid, in percent. The pool's own LP
 * fee comes out first, so what is left is depth - otherwise a 1% pool would read as a standing 1%
 * impact on every trade, however small.
 */
export function priceImpactPct(spotOutPerIn, feePips, amountInWhole, amountOutWhole) {
  if (spotOutPerIn <= 0 || amountInWhole <= 0 || amountOutWhole <= 0) return 0;
  const afterFee = spotOutPerIn * (1 - feePips / 1_000_000);
  if (afterFee <= 0) return 0;
  return Math.max(0, (1 - amountOutWhole / amountInWhole / afterFee) * 100);
}

/** Past this much depth-driven impact, a buy stops and says so rather than going through. */
export const IMPACT_STOP_PCT = 7;
