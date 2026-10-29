import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} Team
 * @property {string} language
 * @property {{coordinator: string, worker: string}} models
 * @property {number} maxWorkers
 * @property {string | null} base
 * @property {string} worktreeDir
 * @property {string[]} checks
 * @property {{steps: string[], healthUrl: string | null}} deploy
 * @property {string[]} rules
 * @property {Record<string, {scan: string, pattern: string, width: number}>} reservations
 * @property {'auto'|'none'} terminal
 */

/** @type {Team} */
export const TEAM_DEFAULTS = Object.freeze({
  language: 'en',
  models: Object.freeze({ coordinator: 'opus', worker: 'sonnet' }),
  maxWorkers: 4,
  base: null,
  worktreeDir: '..',
  checks: Object.freeze([]),
  deploy: Object.freeze({ steps: Object.freeze([]), healthUrl: null }),
  rules: Object.freeze([]),
  reservations: Object.freeze({}),
  terminal: 'auto',
});

const TERMINAL = ['auto', 'none'];

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function cloneDefaults() {
  return {
    language: TEAM_DEFAULTS.language,
    models: { ...TEAM_DEFAULTS.models },
    maxWorkers: TEAM_DEFAULTS.maxWorkers,
    base: TEAM_DEFAULTS.base,
    worktreeDir: TEAM_DEFAULTS.worktreeDir,
    checks: [],
    deploy: { steps: [], healthUrl: null },
    rules: [],
    reservations: {},
    terminal: TEAM_DEFAULTS.terminal,
  };
}

/** A reservation pattern must compile and hold exactly one capture group. */
function captureGroups(pattern) {
  try {
    return new RegExp(`${pattern}|`).exec('').length - 1;
  } catch {
    return -1;
  }
}

/**
 * Load and validate the `team` block of `<root>/offlimits.json`. Never throws.
 * Gate-policy problems belong to loadPolicy; this reports team problems only.
 * @param {string | null} root
 * @param {(p: string, enc: string) => string} [readFile]
 * @returns {{team: Team, problems: string[], enabled: boolean}}
 */
export function loadTeam(root, readFile = fs.readFileSync) {
  const team = cloneDefaults();
  const problems = [];
  const none = { team, problems, enabled: false };
  if (!root) return none;

  let data;
  try {
    const text = String(readFile(path.resolve(root, 'offlimits.json'), 'utf8')).replace(/^﻿/, '');
    data = JSON.parse(text);
  } catch {
    return none;
  }
  if (!isObject(data) || !('team' in data)) return none;

  const value = data.team;
  const bad = (key, want) => problems.push(`offlimits.json: "team.${key}" must be ${want}`);
  if (!isObject(value)) {
    problems.push('offlimits.json: "team" must be an object');
    return { team, problems, enabled: true };
  }

  for (const [key, v] of Object.entries(value)) {
    switch (key) {
      case 'language':
      case 'worktreeDir':
        if (nonEmpty(v)) team[key] = v.trim();
        else bad(key, 'a non-empty string');
        break;
      case 'base':
        if (v === null) team.base = null;
        else if (nonEmpty(v)) team.base = v.trim();
        else bad(key, 'a non-empty string or null');
        break;
      case 'maxWorkers':
        if (intIn(v, 1, 16)) team.maxWorkers = v;
        else bad(key, 'an integer from 1 to 16');
        break;
      case 'checks':
      case 'rules':
        if (isStringArray(v)) team[key] = [...v];
        else bad(key, 'an array of strings');
        break;
      case 'terminal':
        if (TERMINAL.includes(v)) team.terminal = v;
        else bad(key, 'one of auto, none');
        break;
      case 'models':
        if (!isObject(v)) {
          bad(key, 'an object');
          break;
        }
        for (const [mk, mv] of Object.entries(v)) {
          if (mk !== 'coordinator' && mk !== 'worker') problems.push(`offlimits.json: unknown key "team.models.${mk}"`);
          else if (nonEmpty(mv)) team.models[mk] = mv.trim();
          else bad(`models.${mk}`, 'a non-empty string');
        }
        break;
      case 'deploy':
        if (!isObject(v)) {
          bad(key, 'an object');
          break;
        }
        for (const [dk, dv] of Object.entries(v)) {
          if (dk === 'steps') {
            if (isStringArray(dv)) team.deploy.steps = [...dv];
            else bad('deploy.steps', 'an array of strings');
          } else if (dk === 'healthUrl') {
            if (dv === null) team.deploy.healthUrl = null;
            else if (nonEmpty(dv)) team.deploy.healthUrl = dv.trim();
            else bad('deploy.healthUrl', 'a non-empty string or null');
          } else {
            problems.push(`offlimits.json: unknown key "team.deploy.${dk}"`);
          }
        }
        break;
      case 'reservations':
        if (!isObject(v)) {
          bad(key, 'an object of {scan, pattern, width}');
          break;
        }
        for (const [name, r] of Object.entries(v)) {
          const k = `reservations.${name}`;
          if (!isObject(r) || !nonEmpty(r.scan) || typeof r.pattern !== 'string') {
            bad(k, '{scan: string, pattern: string, width?: number}');
          } else if (captureGroups(r.pattern) !== 1) {
            bad(`${k}.pattern`, 'a valid regex with exactly one capture group');
          } else if (r.width !== undefined && !intIn(r.width, 1, 12)) {
            bad(`${k}.width`, 'an integer from 1 to 12');
          } else {
            team.reservations[name] = { scan: r.scan, pattern: r.pattern, width: r.width ?? 4 };
          }
        }
        break;
      default:
        problems.push(`offlimits.json: unknown key "team.${key}"`);
    }
  }

  return { team, problems, enabled: true };
}
