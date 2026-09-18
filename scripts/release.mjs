/**
 * Cuts a release: bump the version and open the pull request that lands it.
 *
 * Releasing is a consequence of merging, not a separate ceremony. The `package`
 * job in `.github/workflows/verify.yml` runs on every push to main; when it
 * finds a version in `package.json` that has never been tagged, it builds the
 * installers from that commit — after the harnesses pass — creates the tag
 * itself, and attaches them to a draft release. So the only thing that ships
 * anything is a version bump arriving on main, and there is no tag to remember.
 *
 * That is also why nothing here builds, tags or uploads. The installers are
 * ~1.3 GB each; they are produced and uploaded by the runner that built them,
 * never from a developer's working tree.
 *
 * What is left is a bump, a commit, and the checks that make it safe: a dirty
 * tree means the released commit would not be what was tested, a stale branch
 * means shipping code someone has already moved past, and a version that is
 * already tagged has already shipped. Each is cheap to catch here and expensive
 * to discover afterwards.
 *
 *   node scripts/release.mjs 0.1.6
 *   node scripts/release.mjs patch --dry-run
 *   node scripts/release.mjs minor --no-push     (commits, leaves the push and PR to you)
 *   node scripts/release.mjs 0.2.0 --verify      (full harness suite first)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const target = argv.find((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const noPush = flags.has('--no-push') || dryRun;
const runVerify = flags.has('--verify');
/**
 * Hard-coded, because the workflow only releases from main: a bump landing on
 * any other branch builds nothing. Making this configurable here would let the
 * script promise something the pipeline will not honour.
 */
const RELEASE_BRANCH = 'main';

const USAGE = `
Usage: node scripts/release.mjs <version|patch|minor|major> [options]

  --dry-run     print every step, change nothing
  --no-push     commit locally, leave the push and the PR to you
  --verify      run the full harness suite first (slow, thorough)

Releases happen when a new version lands on ${RELEASE_BRANCH}, which requires a
pull request. This opens it; merging it is what ships.
`;

function die(message, detail) {
  console.error(`\n  release: ${message}`);
  if (detail) console.error(`           ${detail}`);
  process.exit(1);
}

/** Something that happens in a dry run too, because it only reads. */
function step(message) {
  console.log(`  · ${message}`);
}

function git(args, { capture = true } = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })?.trim();
}

/**
 * Mutating commands are the only ones a dry run has to skip, so they are the
 * only ones labelled "would" — a dry run that printed "would fetch" next to a
 * fetch it actually performed would be lying about which half is real.
 */
function mutate(describe, run) {
  console.log(`  ${dryRun ? 'would' : '·'} ${describe}`);
  if (!dryRun) run();
}

/**
 * npm's own JS entry point, so it can be run without a shell.
 *
 * On Windows npm is `npm.cmd`, and Node refuses to spawn .cmd/.bat directly
 * (the CVE-2024-27980 hardening). Going through `shell: true` works but
 * concatenates arguments unescaped, which Node now warns about — so find the
 * script npm.cmd would have run and hand it to node instead.
 */
function npmCli() {
  const fromEnv = process.env.npm_execpath;
  const dir = path.dirname(process.execPath);
  const candidates = [
    fromEnv && fromEnv.endsWith('.js') ? fromEnv : null,
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function npm(args) {
  const cli = npmCli();
  const win = process.platform === 'win32';
  try {
    if (cli) {
      execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit' });
    } else {
      // No npm-cli.js where we expected it. Fall back to the shell; the only
      // argument that is not a literal is the version, matched against SEMVER.
      execFileSync(win ? 'npm.cmd' : 'npm', args, { cwd: root, stdio: 'inherit', shell: win });
    }
  } catch (err) {
    die(
      `npm ${args.join(' ')} failed`,
      err?.status ? `Exit code ${err.status}.` : String(err?.message ?? err),
    );
  }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function bump(current, how) {
  const m = SEMVER.exec(current);
  if (!m) die(`package.json version "${current}" is not x.y.z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  return how;
}

/** Positive when a is newer than b. */
function compare(a, b) {
  const pa = SEMVER.exec(a).slice(1).map(Number);
  const pb = SEMVER.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

if (!target) {
  console.log(USAGE);
  process.exit(1);
}

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const version = bump(current, target);

if (!SEMVER.test(version)) die(`"${version}" is not a version or a bump keyword`, USAGE.trim());
if (compare(version, current) <= 0) {
  die(`${version} is not newer than the current ${current}`, 'Releases only move forward.');
}

const tag = `v${version}`;

console.log(`\n  Nabsun ${current} → ${version}${dryRun ? '   (dry run)' : ''}\n`);

/* ------------------------------------------------------------- preflight -- */

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== RELEASE_BRANCH) {
  die(
    `on "${branch}", but releases only happen on "${RELEASE_BRANCH}"`,
    `CI releases a new version when it lands on ${RELEASE_BRANCH}. A bump pushed anywhere else builds nothing.`,
  );
}

const dirty = git(['status', '--porcelain']);
if (dirty) {
  die(
    'the working tree has uncommitted changes',
    `The released commit would not be what you tested.\n${dirty
      .split('\n')
      .map((l) => `             ${l.trim()}`)
      .join('\n')}`,
  );
}

step('fetching origin');
try {
  git(['fetch', 'origin', '--tags', '--quiet']);
} catch {
  die('could not reach origin', 'Check the network, then run this again.');
}

const [behind, ahead] = git(['rev-list', '--left-right', '--count', `origin/${RELEASE_BRANCH}...HEAD`])
  .split(/\s+/)
  .map(Number);
if (behind > 0) {
  die(
    `${RELEASE_BRANCH} is ${behind} commit(s) behind origin`,
    'Pull first — otherwise this releases code someone has already moved past.',
  );
}
if (ahead > 0) {
  die(
    `${RELEASE_BRANCH} is ${ahead} commit(s) ahead of origin`,
    'Push them first, so the release is cut from a commit the remote already has.',
  );
}

// CI tags each released version, so an existing tag means this one has shipped.
const existsLocally = git(['tag', '--list', tag]);
const existsRemotely = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
if (existsLocally || existsRemotely) {
  die(`${version} has already been released`, `The tag ${tag} exists. Pick the next version.`);
}

/* ----------------------------------------------------------------- gates -- */

mutate('run typecheck', () => npm(['run', 'typecheck']));

if (runVerify) {
  mutate('run the full harness suite', () => npm(['run', 'verify']));
} else {
  console.log('    (skipping the harnesses — CI runs them before it builds; --verify to run them here)');
}

/* ------------------------------------------------------------- the branch -- */

// The bump goes on its own branch and arrives through a pull request, because
// main requires one. That is not only a rule to satisfy: it means every release
// has a reviewable diff and a green `verify` behind it before anything ships.
const prBranch = `release/${tag}`;

if (git(['branch', '--list', prBranch])) {
  die(`branch ${prBranch} already exists locally`, 'Delete it, or finish the release it belongs to.');
}
if (git(['ls-remote', '--heads', 'origin', prBranch])) {
  die(`branch ${prBranch} already exists on origin`, 'Its pull request is probably still open.');
}

mutate(`branch ${prBranch}`, () => git(['checkout', '-b', prBranch]));

/* ------------------------------------------------------------- the bump -- */

// `npm version` keeps package-lock.json in step, which hand-editing does not.
mutate(`set package.json to ${version}`, () =>
  npm(['version', version, '--no-git-tag-version', '--allow-same-version']),
);

const touched = ['package.json'];
if (fs.existsSync(path.join(root, 'package-lock.json'))) touched.push('package-lock.json');

mutate(`commit "chore(release): ${tag}"`, () => {
  git(['add', ...touched]);
  git(['commit', '-m', `chore(release): ${tag}`]);
});

/* -------------------------------------------------------------------- pr -- */

// No tag is created here. CI tags the commit it actually built, which is the
// only way the tag and the installers cannot disagree.

if (noPush) {
  console.log(`\n  Committed on ${prBranch}, not pushed. When you are ready:\n`);
  console.log(`    git push -u origin ${prBranch}`);
  console.log(`    gh pr create --base ${RELEASE_BRANCH} --fill\n`);
  if (dryRun) console.log('  Nothing was changed.\n');
  process.exit(0);
}

mutate(`push ${prBranch}`, () =>
  git(['push', '--set-upstream', 'origin', prBranch], { capture: false }),
);

const PR_BODY = `Bumps the version to \`${version}\`.

Merging this is what ships it: the \`package\` job sees a version on ${RELEASE_BRANCH} that has
never been tagged, builds the Windows installers from the merge commit, tags
\`${tag}\`, and attaches them to a draft release.

Nothing is public until that draft is published.`;

let prUrl = null;
mutate(`open a pull request into ${RELEASE_BRANCH}`, () => {
  try {
    prUrl = execFileSync(
      process.platform === 'win32' ? 'gh.exe' : 'gh',
      ['pr', 'create', '--base', RELEASE_BRANCH, '--head', prBranch,
       '--title', `chore(release): ${tag}`, '--body', PR_BODY],
      // gh writes its own diagnostics to stderr; let those through rather than
      // reprinting the whole failed command on top of them.
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ).trim().split(/\s+/).pop();
  } catch {
    // The branch is pushed either way, so a missing or unauthenticated gh is a
    // detour rather than a dead end.
    console.log('\n  Could not open the pull request automatically — the branch is pushed.');
  }
});

/* ---------------------------------------------------------------- what now */

const remote = git(['remote', 'get-url', 'origin']);
const slug = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)?.[1];

if (prUrl) {
  console.log(`\n  Pull request open:\n\n    ${prUrl}\n`);
} else if (slug) {
  console.log(`\n  Open it here:\n\n    https://github.com/${slug}/compare/${RELEASE_BRANCH}...${prBranch}?expand=1\n`);
}

console.log(`  Merge it once \`verify\` is green. That is what releases ${version}:`);
console.log(`  CI tags ${tag}, builds the installers, and drafts the release.\n`);
console.log(`  You are on ${prBranch}. \`git checkout ${RELEASE_BRANCH} && git pull\` after it merges.\n`);
