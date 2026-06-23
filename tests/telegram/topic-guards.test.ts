import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canAutoCreateTopic,
  formatForumTopicLabel,
  formatMappingForumLabel,
  formatMappingForumTopicDisplay,
  getAutoCreateBlockReason,
  isPlaceholderTabTitle,
  isStableComposerId,
  isPersistableComposerId,
  isSyntheticComposerId,
  normalizeComposerId,
  normalizeTopicLabelInput,
  normalizeTopicMode,
  modeTopicPrefix,
  activeTabMatchesMapping,
  shouldAllowMappingTitleUpdate,
  WINDOW_TOPIC_WARMUP_MS,
} from '../../src/telegram/topics/guards.js';

describe('topic-guards', () => {
  it('detects placeholder tab titles', () => {
    assert.equal(isPlaceholderTabTitle('New Agent'), true);
    assert.equal(isPlaceholderTabTitle('  new chat  '), true);
    assert.equal(isPlaceholderTabTitle('Изменение конфигурации в проекте'), false);
  });

  it('rejects unstable composer ids', () => {
    assert.equal(isStableComposerId('tab-2'), false);
    assert.equal(isStableComposerId(''), false);
    assert.equal(isStableComposerId('b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b'), true);
    assert.equal(normalizeComposerId('tab-2'), undefined);
    assert.equal(normalizeComposerId('b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b'), 'b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b');
  });

  it('blocks auto-create for placeholders and warmup', () => {
    const composer = 'b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b';
    assert.equal(getAutoCreateBlockReason({
      tabTitle: 'New Agent',
      composerId: composer,
      hasMessages: true,
      windowFirstSeenAt: Date.now(),
    }), 'placeholder_title');

    assert.equal(getAutoCreateBlockReason({
      tabTitle: 'Real chat',
      composerId: 'tab-2',
      hasMessages: true,
      windowFirstSeenAt: Date.now() - WINDOW_TOPIC_WARMUP_MS - 1,
    }), 'no_stable_composer');

    assert.equal(getAutoCreateBlockReason({
      tabTitle: 'Real chat',
      composerId: composer,
      hasMessages: true,
      windowFirstSeenAt: Date.now(),
    }), 'window_warming_up');

    assert.ok(canAutoCreateTopic({
      tabTitle: 'Real chat',
      composerId: composer,
      hasMessages: true,
      windowFirstSeenAt: Date.now() - WINDOW_TOPIC_WARMUP_MS - 1,
      workspacePath: 'C:\\Projects\\foo',
    }));
  });

  it('formats forum topic label for placeholder tabs', () => {
    assert.equal(
      formatForumTopicLabel('test-layout', 'New Agent'),
      'test-layout — new chat',
    );
    assert.equal(
      formatForumTopicLabel('myproj', 'Обсуждение'),
      'myproj — Обсуждение',
    );
  });

  it('uses custom topicLabel for mapping display', () => {
    assert.equal(
      formatMappingForumLabel({
        windowTitle: 'myproj',
        tabTitle: 'Old tab',
        topicLabel: 'релиз 0.2',
      }),
      'myproj — релиз 0.2',
    );
  });

  it('normalizes topic rename input', () => {
    assert.equal(normalizeTopicLabelInput('  релиз   0.2  '), 'релиз 0.2');
    assert.equal(normalizeTopicLabelInput('   '), undefined);
  });

  it('adds mode emoji prefix without changing base label', () => {
    const mapping = {
      windowTitle: 'myproj',
      tabTitle: 'Old tab',
      topicLabel: 'релиз 0.2',
      topicMode: 'plan',
    };
    assert.equal(formatMappingForumLabel(mapping), 'myproj — релиз 0.2');
    assert.equal(formatMappingForumTopicDisplay(mapping), '📋 myproj — релиз 0.2');
    assert.equal(formatMappingForumTopicDisplay(mapping, 'agent'), '🤖 myproj — релиз 0.2');
    assert.equal(modeTopicPrefix('debug'), '🐛 ');
    assert.equal(normalizeTopicMode('ASK'), 'ask');
  });

  it('matches active tab to mapping for inbound binding', () => {
    assert.equal(
      activeTabMatchesMapping('Обсуждение изменений за итерации', 'Тестовое сообщение'),
      false,
    );
    assert.equal(
      activeTabMatchesMapping('Обсуждение изменений за итерации', 'Обсуждение изменений за итерации'),
      true,
    );
  });

  it('allows mapping title updates only for related titles', () => {
    assert.equal(
      shouldAllowMappingTitleUpdate('Обсуждение изменений за итерации', 'Тестовое сообщение'),
      false,
    );
    assert.equal(shouldAllowMappingTitleUpdate('New Agent', 'Реальный чат'), true);
    assert.equal(
      shouldAllowMappingTitleUpdate('Проблема с вейком', 'Проблема с вейком после перезапуска'),
      true,
    );
    assert.equal(shouldAllowMappingTitleUpdate('Same', 'same'), true);
  });

  it('distinguishes synthetic glass composer ids', () => {
    assert.equal(isSyntheticComposerId('glass:New Agent'), true);
    assert.equal(isPersistableComposerId('glass:New Agent'), false);
    assert.equal(isPersistableComposerId('b5a0c31f-d68f-4ef9-a4e4-f95be3b4930b'), true);
  });
});
