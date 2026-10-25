import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rules from '../hooks/lib/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function activeRules() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offlimits-status-')));
  try {
    execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: dir });
    const env = { ...process.env };
    delete env.OFFLIMITS_ROLE;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'status.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('active rules: '));
    assert.ok(line, r.stdout);
    return line.slice('active rules: '.length).trim().split(/,\s*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('status lists the rule ids exported by rules.mjs', () => {
  const printed = activeRules();
  if (Array.isArray(rules.RULE_IDS)) {
    assert.deepEqual([...printed].sort(), [...rules.RULE_IDS].sort());
  } else {
    // rules.mjs does not export RULE_IDS yet: the fallback list must carry the new ids
    for (const id of ['github-mcp', 'mcp-destructive', 'agent-spawn', 'protected-file', 'opaque-shell', 'extra-deny']) {
      assert.ok(printed.includes(id), `missing ${id}`);
    }
  }
});

test('every rule id the MCP and file rules can return is listed', () => {
  const printed = activeRules();
  for (const id of ['supabase-mcp', 'vercel-mcp', 'github-mcp', 'mcp-write', 'mcp-destructive', 'protected-file']) {
    assert.ok(printed.includes(id), `missing ${id}`);
  }
});
