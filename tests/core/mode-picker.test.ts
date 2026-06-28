import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_ITEM_COLLECTOR_JS,
  MODEL_MENU_LOOKUP_JS,
  MODEL_SNAPSHOT_READ_JS,
} from '../../src/ide/actions/navigation.js';

describe('MODE_ITEM_COLLECTOR_JS', () => {
  it('exports collectModeItems and pickModeById helpers', () => {
    assert.match(MODE_ITEM_COLLECTOR_JS, /pickModeById/);
    assert.match(MODE_ITEM_COLLECTOR_JS, /collectModeItems/);
    assert.match(MODE_ITEM_COLLECTOR_JS, /composer-mode-/);
  });
});

describe('MODEL_SNAPSHOT_READ_JS', () => {
  it('exports readModelMenuSnapshot and references findModelMenu', () => {
    assert.match(MODEL_SNAPSHOT_READ_JS, /readModelMenuSnapshot/);
    assert.match(MODEL_SNAPSHOT_READ_JS, /findModelMenu/);
    assert.match(MODEL_MENU_LOOKUP_JS, /model-picker-menu/);
    assert.match(MODEL_SNAPSHOT_READ_JS, /autoOn/);
  });
});
