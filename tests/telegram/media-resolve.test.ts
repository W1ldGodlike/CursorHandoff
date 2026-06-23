import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectUnsupportedInboundType,
  resolveInboundMedia,
} from '../../src/telegram/inbound/media-resolve.js';
import type { BotMessage } from '../../src/telegram/types.js';

describe('inbound media-resolve', () => {
  it('resolves video as file', () => {
    const msg: BotMessage = {
      video: { file_id: 'v1', mime_type: 'video/mp4', file_name: 'clip.mp4' },
    };
    const r = resolveInboundMedia(msg);
    assert.equal(r?.kind, 'file');
    assert.equal(r?.fileId, 'v1');
  });

  it('resolves voice as file', () => {
    const msg: BotMessage = { voice: { file_id: 'vo1', mime_type: 'audio/ogg' } };
    assert.equal(resolveInboundMedia(msg)?.kind, 'file');
  });

  it('detects unsupported poll', () => {
    const msg: BotMessage = { poll: { id: 'x' } };
    assert.equal(detectUnsupportedInboundType(msg), 'poll');
    assert.equal(resolveInboundMedia(msg), null);
  });
});
