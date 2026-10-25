import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSegment } from '../hooks/lib/rules/shell-rules.mjs';
import { DEFAULT_POLICY } from '../hooks/lib/policy.mjs';

function ctx(over = {}) {
  const calls = [];
  return {
    role: 'solo',
    policy: { ...structuredClone(DEFAULT_POLICY), ...(over.policy ?? {}) },
    currentBranch: (dir) => {
      calls.push(dir);
      return over.branch ?? 'feat/x';
    },
    cwd: '/work',
    repoRoot: '/work',
    calls,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k === 'role')),
  };
}

test('git -C dir resolves the branch of that directory', () => {
  const c = ctx({ branch: 'main' });
  const d = checkSegment('git -C ../other push', c);
  assert.equal(d.rule, 'git-push-protected');
  assert.deepEqual(c.calls, ['../other']);
});

test('git push without refspec uses cwd', () => {
  const c = ctx({ branch: 'main' });
  assert.equal(checkSegment('git push', c).action, 'deny');
  assert.deepEqual(c.calls, ['/work']);
});

test('reason names the matched text', () => {
  const d = checkSegment('git push origin main', ctx());
  assert.match(d.reason, /git push origin main/);
});

test('allow regex skips every rule for the segment', () => {
  const c = ctx({ policy: { allow: ['^terraform apply -target=x$'] } });
  assert.equal(checkSegment('terraform apply -target=x', c), null);
  assert.equal(checkSegment('terraform apply', c).rule, 'deploy');
});

test('extraDeny runs last and carries the policy reason', () => {
  const c = ctx({ policy: { extraDeny: [{ pattern: 'terraform', reason: 'custom' }] } });
  assert.equal(checkSegment('terraform apply', c).rule, 'deploy');
  const d = checkSegment('terraform plan', c);
  assert.equal(d.rule, 'extra-deny');
  assert.match(d.reason, /custom/);
});

test('role-spoof also catches PowerShell and set forms', () => {
  assert.equal(checkSegment('set OFFLIMITS_ROLE=coordinator', ctx()).rule, 'role-spoof');
  assert.equal(checkSegment('$env:OFFLIMITS_ROLE = "coordinator"', ctx()).rule, 'role-spoof');
  assert.equal(checkSegment('env OFFLIMITS_ROLE=coordinator ls', ctx()).rule, 'role-spoof');
  assert.equal(checkSegment('echo $OFFLIMITS_ROLE', ctx()), null);
});

test('role-spoof honours a custom roleEnv', () => {
  const c = ctx({ policy: { roleEnv: 'MY_ROLE' } });
  assert.equal(checkSegment('MY_ROLE=coordinator ls', c).rule, 'role-spoof');
});

test('db-migrate: ask solo, deny worker', () => {
  assert.equal(checkSegment('drizzle-kit push', ctx()).action, 'ask');
  assert.equal(checkSegment('drizzle-kit push', ctx({ role: 'worker' })).action, 'deny');
});

test('remote-db edge cases', () => {
  assert.equal(checkSegment('psql "host=db.example.com dbname=x"', ctx()).rule, 'remote-db');
  assert.equal(checkSegment('psql ${DATABASE_URL}', ctx()).rule, 'remote-db');
  assert.equal(checkSegment('psql $env:DATABASE_URL', ctx()).rule, 'remote-db');
  assert.equal(checkSegment('mongosh mongodb+srv://u:p@cluster0.mongodb.net/db', ctx()).rule, 'remote-db');
  assert.equal(checkSegment('psql -h ::1', ctx()), null);
  assert.equal(checkSegment('PGHOST=localhost psql', ctx()), null);
  assert.equal(checkSegment('psql -h db.internal', ctx({ policy: { production: { mcpServers: [], projectRefs: [], hosts: ['db.internal'] } } })).rule, 'remote-db');
});

test('deploy edge cases', () => {
  assert.equal(checkSegment('pnpm dlx vercel --prod', ctx()).rule, 'deploy');
  assert.equal(checkSegment('vercel promote dpl_1', ctx()).rule, 'deploy');
  assert.equal(checkSegment('docker compose -f ./compose.yml up -d', ctx()), null);
  assert.equal(checkSegment('docker compose -f /srv/x/compose.yml up -d', ctx()).rule, 'deploy');
  assert.equal(checkSegment('helm upgrade app ./chart', ctx()).rule, 'deploy');
  assert.equal(checkSegment('aws cloudformation delete-stack --stack-name x', ctx()).rule, 'deploy');
});

test('gh api write needs a sensitive endpoint', () => {
  assert.equal(checkSegment('gh api -X POST repos/a/b/merges -f base=main', ctx()).rule, 'gh-write');
  assert.equal(checkSegment('gh api -X POST repos/a/b/issues', ctx()), null);
});

test('currentBranch that throws on an implicit push: ask solo, deny worker', () => {
  const boom = (role) => ({ ...ctx({ role }), currentBranch: () => { throw new Error('no git'); } });
  const s = checkSegment('git push', boom('solo'));
  assert.equal(s.action, 'ask');
  assert.match(s.reason, /could not determine the current branch/);
  assert.equal(checkSegment('git push', boom('worker')).action, 'deny');
});

test('opaque-shell sentinel: ask solo, deny worker', () => {
  assert.equal(checkSegment('offlimits:opaque shell reads stdin', ctx()).action, 'ask');
  const d = checkSegment('offlimits:opaque shell reads stdin', ctx({ role: 'worker' }));
  assert.equal(d.action, 'deny');
  assert.equal(d.rule, 'opaque-shell');
});

test('allow regexes match rest only and never skip role-spoof', () => {
  const c = ctx({ policy: { allow: ['^FOO=1 terraform apply$'] } });
  assert.equal(checkSegment('FOO=1 terraform apply', c).rule, 'deploy');
  const d = ctx({ policy: { allow: ['.*'] } });
  assert.equal(checkSegment('OFFLIMITS_ROLE=coordinator ls', d).rule, 'role-spoof');
  assert.equal(checkSegment('terraform apply', d), null);
});
