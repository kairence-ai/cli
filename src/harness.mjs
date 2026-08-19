// The harness side of setup: where an agent's system prompt lives, and - when the harness has
// profiles - making sure each agent gets one of its own.
//
// Hermes keeps a profile per personality: `~/.hermes` is `default`, and every other lives in
// `~/.hermes/profiles/<name>` with its own SOUL.md, its own `.env` and its own wrapper command.
// That is exactly one agent's worth of separation, so a machine running five agents runs five
// profiles rather than five identities crammed into one prompt.
//
// A profile is claimed by writing KAIRENCE_TOKEN into its `.env`. That line is what makes every
// later command inside that profile know which agent it is - and it is also how this file knows
// which profile it may write to, without ever guessing from a name alone.

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

const HOME = process.env.HOME;

export function hermesRoot() {
  return process.env.HERMES_HOME || join(HOME, '.hermes');
}

/** Every Hermes profile on this machine: `default` is the root itself, the rest live under it. */
export function hermesProfiles() {
  const root = hermesRoot();
  if (!existsSync(join(root, 'SOUL.md'))) return [];
  const out = [{name: 'default', path: root}];
  const dir = join(root, 'profiles');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (existsSync(join(path, 'SOUL.md'))) out.push({name, path});
    }
  }
  return out.map((p) => ({...p, soul: join(p.path, 'SOUL.md'), env: join(p.path, '.env')}));
}

/** The token a profile has been claimed by, or null when nobody has claimed it. */
export function claimOf(profile) {
  if (!existsSync(profile.env)) return null;
  const line = readFileSync(profile.env, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('KAIRENCE_TOKEN='));
  const value = line?.slice('KAIRENCE_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  return value || null;
}

/** Set one variable in a `.env`, replacing the line rather than adding a second one. */
export function setEnv(path, key, value) {
  // The trailing newline every well-formed file ends with becomes an empty last element, and
  // appending after it puts a blank line in the middle of someone's config.
  const lines = existsSync(path) ? readFileSync(path, 'utf8').replace(/\n+$/, '').split('\n') : [];
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at === -1) lines.push(`${key}=${value}`);
  else lines[at] = `${key}=${value}`;
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop()))));
  });
}

/** A profile name Hermes accepts: lowercase and alphanumeric. */
export function profileName(ticker) {
  return ticker.toLowerCase().replace(/[^a-z0-9]/g, '') || 'agent';
}

/**
 * The profile this agent should own, creating one when it has none.
 *
 * Order matters. A profile that already names this token is its home, whatever it is called. An
 * unclaimed profile under the agent's own name is adopted rather than duplicated. Only then is a
 * new one made - and a profile claimed by a DIFFERENT agent is never touched, because two agents
 * sharing one prompt is exactly the thing profiles exist to prevent.
 */
export async function profileFor(token, ticker, wanted) {
  const profiles = hermesProfiles();
  if (profiles.length === 0) return null;

  const mine = profiles.find((p) => claimOf(p)?.toLowerCase() === token.toLowerCase());
  if (mine) return {profile: mine, created: false};

  const name = wanted || profileName(ticker);
  const existing = profiles.find((p) => p.name === name);
  if (existing) {
    const claim = claimOf(existing);
    if (claim) {
      throw new Error(
        `the Hermes profile "${name}" already belongs to ${claim} - pass --profile <name> for this one`,
      );
    }
    return {profile: existing, created: false};
  }

  // The default profile, still stock and unclaimed, is a perfectly good first home: a machine
  // with one agent should not be made to carry a second profile for no reason.
  const fallback = profiles.find((p) => p.name === 'default');
  if (fallback && !claimOf(fallback) && profiles.length === 1) {
    return {profile: fallback, created: false};
  }

  try {
    await run('hermes', ['profile', 'create', name, '--clone', '--description', `${ticker}, a Kairence agent`]);
  } catch (e) {
    if (e.code === 'ENOENT') return {profile: fallback ?? profiles[0], created: false};
    throw new Error(`could not create the Hermes profile "${name}" - ${e.message}`);
  }
  const made = hermesProfiles().find((p) => p.name === name);
  if (!made) throw new Error(`Hermes reported no profile "${name}" after creating it`);
  return {profile: made, created: true};
}

/** Whatever was in the prompt is kept, timestamped. This is someone's agent. */
export function backup(path) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const to = `${path}.bak-${stamp}`;
  renameSync(path, to);
  return to;
}
