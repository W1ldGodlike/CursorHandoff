/**
 * Prune telegram-messages.json and pending-telegram-queue.json to match
 * live thread ids in telegram-topics.json. Run after server stop (redeploy).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = process.cwd();
const dataDir = process.env.DATA_DIR?.trim()
  ? process.env.DATA_DIR
  : join(root, 'data');

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

const topicsPath = join(dataDir, 'telegram-topics.json');
const topics = readJson(topicsPath, { mappings: [] });
const liveThreads = new Set(
  (topics.mappings ?? []).map((m) => m.threadId).filter((id) => typeof id === 'number'),
);

const messagesPath = join(dataDir, 'telegram-messages.json');
const tracker = readJson(messagesPath, { messages: {}, selectorHashes: {} });
const messages = tracker.messages ?? {};
const beforeMsgs = Object.keys(messages).length;
const pruned = {};
for (const [key, row] of Object.entries(messages)) {
  if (liveThreads.has(row.threadId)) pruned[key] = row;
}
tracker.messages = pruned;
writeFileSync(messagesPath, JSON.stringify(tracker));
console.log(`[prune] telegram-messages: ${beforeMsgs} -> ${Object.keys(pruned).length} (threads: ${[...liveThreads].join(', ') || 'none'})`);

const queuePath = join(dataDir, 'pending-telegram-queue.json');
const queue = readJson(queuePath, { version: 2, items: [] });
const beforeQ = queue.items?.length ?? 0;
queue.items = (queue.items ?? []).filter(
  (item) =>
    item.status === 'pending'
    || item.status === 'processing'
    || (typeof item.threadId === 'number' && liveThreads.has(item.threadId)),
);
writeFileSync(queuePath, JSON.stringify(queue, null, 2));
console.log(`[prune] pending-telegram-queue: ${beforeQ} -> ${queue.items.length}`);
