// Which agent a command is about, when a machine holds several.
//
// The dangerous answer is not "no agent" - that is loud. It is picking one of five, quietly, and
// signing with a neighbour's key. Every case below is about refusing to do that.

import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const KAI = '0xca18A528Ea897040f715edC92e6e4572780c5ca1';
const WOOF = '0xd193604529Ac73f252C8c9e1b8BbC45db260Dca1';

/** A fresh KAIRENCE_HOME, and the module reloaded so it reads the new one. */
async function home(setUp = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kairence-home-'));
  process.env.KAIRENCE_HOME = dir;
  delete process.env.KAIRENCE_TOKEN;
  setUp(dir);
  // Cache-busted: the module reads env at call time, but a fresh instance keeps the tests honest.
  const mod = await import(`../src/home.mjs?${Math.random()}`);
  return {dir, ...mod};
}

function room(dir, token) {
  const path = join(dir, 'agents', token.toLowerCase());
  mkdirSync(path, {recursive: true});
  writeFileSync(join(path, 'agent.pk'), `0x${'11'.repeat(32)}\n`);
  return path;
}

test('one agent needs nothing said', async () => {
  const h = await home((dir) => room(dir, KAI));
  assert.equal(h.whoAmI().toLowerCase(), KAI.toLowerCase());
});

test('several agents refuse to be guessed at, and name themselves', async () => {
  const h = await home((dir) => {
    room(dir, KAI);
    room(dir, WOOF);
  });
  assert.throws(() => h.whoAmI(), (e) => {
    assert.match(e.message, /2 agents/);
    assert.match(e.message, new RegExp(KAI.toLowerCase()));
    assert.match(e.message, new RegExp(WOOF.toLowerCase()));
    return true;
  });
});

test('KAIRENCE_TOKEN picks one out of several', async () => {
  const h = await home((dir) => {
    room(dir, KAI);
    room(dir, WOOF);
  });
  process.env.KAIRENCE_TOKEN = WOOF;
  assert.equal(h.whoAmI(), WOOF);
  delete process.env.KAIRENCE_TOKEN;
});

test('a KAIRENCE_TOKEN that is not an address is refused, not passed along', async () => {
  const h = await home((dir) => room(dir, KAI));
  process.env.KAIRENCE_TOKEN = 'WOOF';
  assert.throws(() => h.whoAmI(), /not an address/);
  delete process.env.KAIRENCE_TOKEN;
});

test('the flat layout still answers, so an agent set up before rooms keeps its key', async () => {
  const h = await home((dir) => {
    writeFileSync(join(dir, 'agent.pk'), `0x${'22'.repeat(32)}\n`);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({token: KAI}));
  });
  assert.equal(h.whoAmI(), KAI);
});

test('a room is named in one case, so one token never gets two of them', async () => {
  const h = await home();
  assert.equal(h.dirFor(KAI), h.dirFor(KAI.toLowerCase()));
});

test('an empty machine says so instead of inventing an agent', async () => {
  const h = await home();
  assert.throws(() => h.whoAmI(), /run `kairence init`/);
});
