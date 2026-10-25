import fs from 'node:fs';

/** Read one JSON object from stdin synchronously. Null on empty, invalid or unreadable input. */
export function readStdin() {
  try {
    const text = fs.readFileSync(0, 'utf8').replace(/^﻿/, '');
    if (!text.trim()) return null;
    const data = JSON.parse(text);
    return data !== null && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}
