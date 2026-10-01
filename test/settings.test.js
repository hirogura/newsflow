'use strict';

/**
 * newsflow settings テスト（依存追加なし・Node 標準 assert のみ）
 * 実行: node test/settings.test.js（package.json の npm test からも呼ばれる）
 */

const assert = require('node:assert');
const m = require('../server.js');

let n = 0;
function check(name, fn) {
  n += 1;
  try {
    fn();
    console.log(`ok ${n} - ${name}`);
  } catch (e) {
    console.error(`not ok ${n} - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

check('VERSION は 0.1.0', () => {
  assert.strictEqual(m.VERSION, '0.1.0');
});

check('getDefaultSettings: 既定値（15分/24時間/On/1.2）', () => {
  const d = m.getDefaultSettings();
  assert.strictEqual(d.fetchIntervalMinutes, 15);
  assert.strictEqual(d.maxAgeHours, 24);
  assert.strictEqual(d.ttsEnabled, true);
  assert.strictEqual(d.ttsRate, 1.2);
});

check('normalizeSettings: 範囲外は丸める（下限5分・上限180分）', () => {
  assert.strictEqual(m.normalizeSettings({ fetchIntervalMinutes: 3 }).fetchIntervalMinutes, 5);
  assert.strictEqual(m.normalizeSettings({ fetchIntervalMinutes: 999 }).fetchIntervalMinutes, 180);
  assert.strictEqual(m.normalizeSettings({ fetchIntervalMinutes: 'abc' }).fetchIntervalMinutes, 15);
});

check('normalizeSettings: maxAgeHours は 1〜168 に丸める', () => {
  assert.strictEqual(m.normalizeSettings({ maxAgeHours: 0 }).maxAgeHours, 1);
  assert.strictEqual(m.normalizeSettings({ maxAgeHours: 1000 }).maxAgeHours, 168);
  assert.strictEqual(m.normalizeSettings({ maxAgeHours: 48 }).maxAgeHours, 48);
});

check('normalizeSettings: ttsEnabled の真偽値化', () => {
  assert.strictEqual(m.normalizeSettings({ ttsEnabled: false }).ttsEnabled, false);
  assert.strictEqual(m.normalizeSettings({ ttsEnabled: 'false' }).ttsEnabled, false);
  assert.strictEqual(m.normalizeSettings({ ttsEnabled: true }).ttsEnabled, true);
  assert.strictEqual(m.normalizeSettings({ ttsEnabled: 'on' }).ttsEnabled, true);
});

check('normalizeSettings: ttsRate は5段階に寄せる', () => {
  assert.strictEqual(m.normalizeSettings({ ttsRate: 1.2 }).ttsRate, 1.2);
  assert.strictEqual(m.normalizeSettings({ ttsRate: 9 }).ttsRate, 1.6);
  assert.strictEqual(m.normalizeSettings({ ttsRate: 'abc' }).ttsRate, 1.2);
  assert.ok(m.ALLOWED_RATES.includes(m.normalizeSettings({ ttsRate: 1.35 }).ttsRate));
});

check('isValidRate / snapRate', () => {
  assert.strictEqual(m.isValidRate(1.2), true);
  assert.strictEqual(m.isValidRate(9), false);
  assert.strictEqual(m.snapRate(1.39), 1.4);
});

check('normalizeSettings: 部分更新は既存値を維持する', () => {
  const base = { fetchIntervalMinutes: 30, maxAgeHours: 48, ttsEnabled: false, ttsRate: 1.0 };
  const out = m.normalizeSettings({ ttsRate: 1.4 }, base);
  assert.strictEqual(out.fetchIntervalMinutes, 30);
  assert.strictEqual(out.maxAgeHours, 48);
  assert.strictEqual(out.ttsEnabled, false);
  assert.strictEqual(out.ttsRate, 1.4);
});

check('isWithinHours: 古い記事は除外・新しい記事は保持', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const fresh = { pubDate: '2026-10-01T10:00:00Z', fetchedAt: '2026-10-01T10:00:00Z' };
  const old = { pubDate: '2026-09-28T10:00:00Z', fetchedAt: '2026-09-28T10:00:00Z' };
  assert.strictEqual(m.isWithinHours(fresh, 24, now), true);
  assert.strictEqual(m.isWithinHours(old, 24, now), false);
});

check('isWithinHours: 日付無しは保持する', () => {
  const now = Date.now();
  assert.strictEqual(m.isWithinHours({}, 24, now), true);
  assert.strictEqual(m.isWithinHours({ pubDate: 'invalid' }, 24, now), true);
});

check('filterByAge: N時間以内のみ残す', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const items = [
    { title: 'a', pubDate: '2026-10-01T11:00:00Z' },
    { title: 'b', pubDate: '2026-09-01T11:00:00Z' },
  ];
  const out = m.filterByAge(items, 24, now);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'a');
});

if (process.exitCode) {
  console.error('FAIL: テストに失敗しました');
} else {
  console.log(`PASS: 全 ${n} 項目が成功しました`);
}
