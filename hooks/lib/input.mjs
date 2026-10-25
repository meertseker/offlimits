import fs from 'node:fs';

/** Read one JSON object from stdin synchronously. Null on empty, invalid or unreadable input. */
export function readStdin() {
  if (process.stdin.isTTY) return null;
  try {
    const text = fs.readFileSync(0, 'utf8').replace(/^﻿/, '');
    if (!text.trim()) return null;
    const data = JSON.parse(text);
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}
