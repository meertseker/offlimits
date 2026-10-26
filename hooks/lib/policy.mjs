import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Policy
 * @property {string[]} protectedBranches
 * @property {string[]} protectedPaths
 * @property {{mcpServers: string[], projectRefs: string[], hosts: string[]}} production
 * @property {{pattern: string, reason: string}[]} extraDeny
 * @property {string[]} allow
 * @property {string[]} trustedAgentTypes
 * @property {string} roleEnv
 * @property {'solo'|'worker'} defaultRole
 * @property {'auto'|'block'|'allow'} onError
 */

/** @type {Policy} */
export const DEFAULT_POLICY = Object.freeze({
  protectedBranches: ['main', 'master'],
  protectedPaths: [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/**',
    'offlimits.json',
    '.github/workflows/**',
  ],
  production: { mcpServers: [], projectRefs: [], hosts: [] },
  extraDeny: [],
  allow: [],
  trustedAgentTypes: [],
  roleEnv: 'OFFLIMITS_ROLE',
  defaultRole: 'solo',
  onError: 'auto',
});

const FAIL_CLOSED = 'defaultRole falls back to worker until offlimits.json is fixed';
const ON_ERROR = ['auto', 'block', 'allow'];
const PRODUCTION_KEYS = ['mcpServers', 'projectRefs', 'hosts'];

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function regexOk(pattern, key, problems) {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch (e) {
    problems.push(`offlimits.json: invalid regex in ${key}: ${e.message}`);
    return false;
  }
}

function cloneDefaults() {
  return {
    protectedBranches: [...DEFAULT_POLICY.protectedBranches],
    protectedPaths: [...DEFAULT_POLICY.protectedPaths],
    production: { mcpServers: [], projectRefs: [], hosts: [] },
    extraDeny: [],
    allow: [],
    trustedAgentTypes: [],
    roleEnv: DEFAULT_POLICY.roleEnv,
    defaultRole: DEFAULT_POLICY.defaultRole,
    onError: DEFAULT_POLICY.onError,
  };
}

/**
 * Load `<root>/offlimits.json`. Never throws.
 * @param {string | null} root
 * @param {(p: string, enc: string) => string} [readFile]
 * @returns {{policy: Policy, source: 'default' | string, problems: string[]}}
 */
export function loadPolicy(root, readFile = fs.readFileSync) {
  const policy = cloneDefaults();
  const problems = [];
  if (!root) return { policy, source: 'default', problems };

  const file = path.resolve(root, 'offlimits.json');
  let text;
  try {
    text = String(readFile(file, 'utf8')).replace(/^﻿/, '');
  } catch {
    return { policy, source: 'default', problems };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    problems.push(`offlimits.json: invalid JSON (${e.message}). ${FAIL_CLOSED}`);
    policy.defaultRole = 'worker';
    return { policy, source: file, problems };
  }
  if (!isObject(data)) {
    problems.push(`offlimits.json: invalid JSON (top level must be an object). ${FAIL_CLOSED}`);
    policy.defaultRole = 'worker';
    return { policy, source: file, problems };
  }

  const bad = (key, want) => problems.push(`offlimits.json: "${key}" must be ${want}`);

  for (const [key, value] of Object.entries(data)) {
    switch (key) {
      case 'allow':
        if (isStringArray(value)) policy.allow = value.filter((v) => regexOk(v, key, problems));
        else bad(key, 'an array of strings');
        break;
      case 'protectedBranches':
      case 'protectedPaths':
      case 'trustedAgentTypes':
        if (isStringArray(value)) policy[key] = [...value];
        else bad(key, 'an array of strings');
        break;
      case 'roleEnv':
        if (typeof value === 'string' && value.trim()) policy.roleEnv = value.trim();
        else bad(key, 'a non-empty string');
        break;
      case 'defaultRole':
        if (value === 'solo' || value === 'worker') policy.defaultRole = value;
        else problems.push('offlimits.json: defaultRole must be "solo" or "worker"');
        break;
      case 'onError':
        if (ON_ERROR.includes(value)) policy.onError = value;
        else bad(key, 'one of auto, block, allow');
        break;
      case 'extraDeny':
        if (!Array.isArray(value)) {
          bad(key, 'an array of {pattern, reason}');
          break;
        }
        for (const entry of value) {
          if (isObject(entry) && typeof entry.pattern === 'string' && typeof entry.reason === 'string') {
            if (regexOk(entry.pattern, key, problems)) {
              policy.extraDeny.push({ pattern: entry.pattern, reason: entry.reason });
            }
          } else {
            bad('extraDeny[]', '{pattern: string, reason: string}');
          }
        }
        break;
      case 'production':
        if (!isObject(value)) {
          bad(key, 'an object');
          break;
        }
        for (const [pk, pv] of Object.entries(value)) {
          if (!PRODUCTION_KEYS.includes(pk)) {
            problems.push(`offlimits.json: unknown key "production.${pk}"`);
          } else if (isStringArray(pv)) {
            policy.production[pk] = [...new Set([...policy.production[pk], ...pv])];
          } else {
            bad(`production.${pk}`, 'an array of strings');
          }
        }
        break;
      default:
        problems.push(`offlimits.json: unknown key "${key}"`);
    }
  }

  return { policy, source: file, problems };
}

/** True when offlimits.json defines any production server, project ref or host. */
export function productionConfigured(policy) {
  const p = policy?.production ?? {};
  return Boolean(p.mcpServers?.length || p.projectRefs?.length || p.hosts?.length);
}
