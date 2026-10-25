import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 200;
const file = (root) => path.join(root, '.offlimits', 'log.jsonl');

/** Append one entry and keep the last 200 lines. Never throws. */
export function appendLog(root, entry) {
  try {
    const f = file(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) fs.writeFileSync(f, lines.slice(-MAX_LINES).join('\n') + '\n');
  } catch {
    /* log failures are ignored */
  }
}

/** Read all parseable entries. Never throws. */
export function readLog(root) {
  try {
    return fs
      .readFileSync(file(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
