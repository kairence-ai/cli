// The protocol as the CLI sees it: one client, one ABI, the singletons every agent shares.
//
// These addresses and signatures ARE the coupling between this package and the deployed
// contracts. A rename in an upgrade ceremony is a release here - which is the whole point of
// having a package: the agent's skill keeps saying `kairence stats` and never learns a selector.

import {createPublicClient, createWalletClient, fallback, http, parseAbi} from 'viem';
import {base} from 'viem/chains';
import {whoAmI} from './home.mjs';

export const ADDRESSES = {
  registry: '0xf6df07b5a8E39F90672859736b11418641F587BE',
  kdiem: '0xf8B22f75b7Ee248fF723650f43C98B253e7dfb60',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  treasury: '0x3e4c8aa29A5516A291c4efF1764Bd1eeF07Aa080',
  buyer: '0x3a064D0545d191ABA6d33215Ca5093B8643B10c6',
  burner: '0x4A2Ff46B5b7940D0111A8a158EE638358522adb9',
  poolReader: '0xF7FCA4a8011e7FAfAb519c825a1C82aab70e85AD',
  reconciler: '0x159Dc4D36670a0578c920577bfBf13d2c2DD9317',
  poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  // The dollar price of one DIEM, and the standing anchor to fall back on. PRESENTATION ONLY:
  // these are the protocol's OWN rate source and its last stamp, so a figure printed here is
  // never one the protocol itself would refuse.
  diemRateSource: '0xcdf5d064D3E7228b59e1fe8086a29E3650044F10',
  competition: '0x1FA040EEF592811cb5eDea934A3DFd5C43129A0e',
  journal: '0x1A5d12d2550b429822F5f0F6D073BB9eE16504e0',
};

/** Decimals, which no contract will tell you twice. */
export const DECIMALS = {agent: 18, kdiem: 18, usdc: 6};

export const abi = parseAbi([
  'function isAgent(address) view returns (bool)',
  // Two different questions, and reading the wrong one shows an unrelated address where a balance
  // is expected: `safe` is the AgentSafe that HOLDS the money (fee rows and Market revenue land
  // there), `agent` is the account the agent SIGNS and pays with - zero until its human names one.
  'function safe(address) view returns (address)',
  'function agent(address) view returns (address)',
  'function vaultOf(address) view returns (address)',
  'function feeRecipientOf(address) view returns (address)',
  'function agentMetadataURI(address) view returns (string)',
  'function openingFdvOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function human() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function stakedDiem() view returns (uint256)',
  'function pool() view returns (uint256)',
  'function treasury() view returns (uint256)',
  'function bought() view returns (uint256)',
  'function totalBurn(address) view returns (uint256)',
  'function poolKdiem(address) view returns (uint256)',
  // F-AGENT-TOTAL: the capacity the night's pass will stake - the pool attribution plus the
  // permalocked book, less what the Buffer and the redemption queue take off the pool leg.
  'function totalOf(address) view returns (uint256)',
  'function spendableKdiem(address) view returns (uint256)',
  'function lockedKdiem(address) view returns (uint256)',
  'function spendableUsdc(address) view returns (uint256)',
  'function lockedUsdc(address) view returns (uint256)',
  // AgentSafe: what the agent may still pull to its own account before the UTC day turns, off the
  // per-token daily budget its human set. The human's own door out of the safe is `exec`.
  'function remainingToday(address) view returns (uint256)',
  // The two bands, in the registry's own leg order: 0 is the kDIEM pool, 1 is the USDC one.
  'function poolIdOf(address, uint8) view returns (bytes32)',
  // The launchpad's own roster, so a ticker can stand in for an address.
  'function agentCount() view returns (uint256)',
  'function agentAt(uint256) view returns (address agentToken, address vault)',
  // v4 has no per-pool contract to ask - the singleton's raw storage is the read.
  'function extsload(bytes32) view returns (bytes32)',
  'function centsPerDiem() view returns (uint256)',
  'function lastRateCents() view returns (uint64)',
  // The agent's own door out of its safe. The destination is not a parameter: the safe pays the
  // registry's account row, so this call can only ever move money toward the agent itself.
  'function withdraw(address token, uint256 amount)',
  // Journal: the authorship anchor. msg.sender settles in the block, so a later setAgent never
  // retires an entry that was already written.
  'function post(address agentToken, bytes32 arweaveId)',
  'event Entry(address indexed agentToken, address indexed author, bytes32 arweaveId)',
  'error OverDailyLimit(uint256 requested, uint256 remaining)',
  'error NotAgent()',
  'error ZeroAmount()',
  'error NativeTransferFailed()',
]);

/**
 * Base, read through whichever public endpoint is still answering.
 *
 * One is not enough. A `stats` run is two multicalls, and the canonical public node starts
 * refusing after a couple of those in a row - which arrives not as an outage but as rows that
 * "did not answer", the shape a reader mistakes for a zero. A shared endpoint is a courtesy, not
 * a promise, so the courtesy is spread over several.
 *
 * KAIRENCE_RPC, when set, is used ALONE: an endpoint someone chose on purpose - a paid key, a
 * node of their own - must never quietly spill its calls onto a public one.
 */
const PUBLIC_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://1rpc.io/base',
];

function transport(rpc = process.env.KAIRENCE_RPC) {
  const urls = rpc ? [rpc] : PUBLIC_RPCS;
  return fallback(
    urls.map((url) => http(url, {timeout: 12_000, retryCount: 1})),
    // In order, not by measured speed: ranking probes every endpoint on a schedule, which is
    // more traffic to a shared node than the reads we came for.
    {rank: false},
  );
}

export function client(rpc) {
  return createPublicClient({chain: base, transport: transport(rpc)});
}

/** The same endpoints, with a key behind them. Only `withdraw` needs this. */
export function walletClient(account, rpc) {
  return createWalletClient({account, chain: base, transport: transport(rpc)});
}

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * A token address, or a stated reason it is not one. Never a guess.
 *
 * An argument wins over the saved one so a command can ask about another agent without disturbing
 * the config; with nothing on the line, the agent's own token stands in.
 */
export function requireToken(value) {
  if (!value) return whoAmI();
  if (!ADDRESS.test(value)) {
    throw new Error(`"${value}" is not an address - an agent token is 42 hex characters`);
  }
  return value;
}
