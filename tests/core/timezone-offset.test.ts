import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listTimezoneOffsetOptions,
  normalizeTimezoneOffset,
  offsetHoursToId,
  timezoneOffsetToIntl,
} from '../../src/state/timezone-offset.js';

describe('timezone-offset', () => {
  it('lists UTC-12 … UTC+12', () => {
    const opts = listTimezoneOffsetOptions();
    assert.equal(opts.length, 25);
    assert.equal(opts[0].id, 'UTC-12');
    assert.equal(opts[opts.length - 1].id, 'UTC+12');
    assert.equal(opts.find((o) => o.id === 'UTC')?.label, 'UTC ±0');
  });

  it('normalizes legacy IANA to offset id', () => {
    assert.equal(normalizeTimezoneOffset('Europe/Moscow'), 'UTC+3');
    assert.equal(normalizeTimezoneOffset('UTC+5'), 'UTC+5');
    assert.equal(normalizeTimezoneOffset('UTC+99'), 'UTC+12');
  });

  it('maps offset to Etc/GMT for Intl', () => {
    assert.equal(timezoneOffsetToIntl('UTC+3'), 'Etc/GMT-3');
    assert.equal(timezoneOffsetToIntl('UTC-5'), 'Etc/GMT+5');
    assert.equal(timezoneOffsetToIntl('UTC'), 'UTC');
    assert.equal(offsetHoursToId(0), 'UTC');
  });
});
