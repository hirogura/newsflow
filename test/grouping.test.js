'use strict';

/**
 * newsflow grouping テスト（依存追加なし・Node 標準 assert のみ）
 * 実行: node test/grouping.test.js（package.json の npm test からも呼ばれる）
 *
 * 参照名は実装のエクスポートに合わせている。
 * 指示書 §3.4 の関数名（similarity / clusterItems / bodyExcerpt / extractMeta）は
 * server.js 側に別名エクスポートとして用意し、両対応であることをここで検証する。
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

// ---------- 類似 2 タイトル → 同一グループ（青森3行地銀統合） ----------
check('類似タイトル(地銀統合)は同一グループになる', () => {
  const items = [
    { title: '青森秋田岩手の3銀行 統合協議へ', link: 'https://example.com/a1', source: 's', pubDate: null },
    { title: '東北3県地銀が経営統合協議へ、県またいだ3行の協議は珍しく　青森みちのく銀行・岩手銀行・秋田銀行', link: 'https://example.com/a2', source: 's', pubDate: null },
    { title: '京都・二条城 二重価格を導入へ', link: 'https://example.com/b1', source: 's', pubDate: null },
  ];
  const { items: out } = m.assignGroups(items);
  assert.strictEqual(out[0].groupId, out[1].groupId, '類似2件は同一 groupId であること');
  assert.notStrictEqual(out[0].groupId, out[2].groupId, '無関係な1件は別 groupId であること');
  assert.ok(out[0].groupSize >= 2, 'groupSize が 2 以上であること');
});

// 別名 clusterItems も同一関数であること
check('別名エクスポート clusterItems は assignGroups と同一', () => {
  assert.strictEqual(m.clusterItems, m.assignGroups);
  assert.strictEqual(m.similarity, m.titleSimilarity);
});

// ---------- 無関係タイトル → 別グループ ----------
check('無関係タイトル(京都 vs バレー)は別グループになる', () => {
  assert.strictEqual(
    m.areSimilarTitles('京都・二条城 二重価格を導入へ', 'バレー男子 カタールに勝ち準決へ'),
    false
  );
  const { items: out } = m.clusterItems([
    { title: '京都・二条城 二重価格を導入へ', link: 'https://example.com/c1', source: 's', pubDate: null },
    { title: 'バレー男子 カタールに勝ち準決へ', link: 'https://example.com/c2', source: 's', pubDate: null },
  ]);
  assert.notStrictEqual(out[0].groupId, out[1].groupId);
});

// ---------- 【A】回帰: 日付だけの一致では統合しない ----------
check('日付のみ共通の無関係ペアは統合しない（クマ vs 地震）', () => {
  assert.strictEqual(
    m.areSimilarTitles('青森県内クマ目撃情報（10月1日付紙面掲載分）', '［地震情報・新潟］南魚沼市で震度1（10月1日）'),
    false
  );
});

// ---------- 【A】回帰: 本来まとめるべき類似記事は維持 ----------
check('水俣病 大阪地裁判決系は同一グループのまま', () => {
  assert.strictEqual(
    m.areSimilarTitles(
      '【速報】大阪地裁が70代男性の水俣病認定を命じる',
      '74歳男性の水俣病患者認定命じる　大阪地裁、国への賠償請求は棄却'
    ),
    true
  );
});

check('長射程ミサイル 長崎・佐賀系は同一グループのまま', () => {
  assert.strictEqual(
    m.areSimilarTitles(
      '【速報】長射程ミサイル、長崎・佐賀の演習場へ展開',
      '「長射程」長崎、佐賀へ　日米演習、配備先から展開'
    ),
    true
  );
});

// ---------- similarity の相対評価（広島ペア > 無関係ペア） ----------
check('similarity: 類似ペアは無関係ペアより高い', () => {
  const sim = m.similarity('広島 小園・矢野ら4選手を戦力外', '小園海斗が謝罪 広島から戦力外');
  const nosim = m.similarity('京都・二条城 二重価格を導入へ', 'バレー男子 カタールに勝ち準決へ');
  assert.ok(sim > nosim, `類似(${sim}) > 無関係(${nosim}) であること`);
  assert.strictEqual(m.areSimilarTitles('広島 小園・矢野ら4選手を戦力外', '小園海斗が謝罪 広島から戦力外'), true);
});

// ---------- 要約（先頭3文相当・上限文字数・文末で終わる） ----------
check('bodyExcerpt: 上限以下で文末（。）で終わる', () => {
  const out = m.bodyExcerpt('あ。'.repeat(200), 140);
  assert.ok(out.length <= 140, `長さ ${out.length} は 140 以下であること`);
  assert.ok(/[。！？]$/.test(out), '文末（。！？）で終わること');
});

check('summarizeText: 先頭3文相当に丸める', () => {
  const out = m.summarizeText('一文目です。二文目です。三文目です。四文目です。五文目です。');
  assert.ok(out.includes('一文目です。'), '1文目を含むこと');
  assert.ok(out.includes('三文目です。'), '3文目を含むこと');
  assert.ok(!out.includes('四文目です。'), '4文目は含まないこと');
});

// ---------- 本文抽出（og:description） ----------
check('extractArticleDescription: og:description を返す', () => {
  const html = '<html><head><meta property="og:description" content="これはテスト用の記事本文です。十分な長さの要約文がここに入ります。"></head></html>';
  assert.strictEqual(
    m.extractArticleDescription(html),
    'これはテスト用の記事本文です。十分な長さの要約文がここに入ります。'
  );
});

check('別名エクスポート extractMeta も同一結果を返す', () => {
  const html = '<html><head><meta property="og:description" content="これはテスト用の記事本文です。十分な長さの要約文がここに入ります。"></head></html>';
  assert.strictEqual(m.extractMeta(html), m.extractArticleDescription(html));
});

check('extractArticleDescription: meta[name=description] にフォールバックする', () => {
  const html = '<html><head><meta name="description" content="こちらはメタ説明文による本文です。長さは十分に確保されています。"></head></html>';
  assert.strictEqual(
    m.extractArticleDescription(html),
    'こちらはメタ説明文による本文です。長さは十分に確保されています。'
  );
});

// ---------- エンティティ復号 ----------
check('decodeEntities: 既定エンティティを復号する', () => {
  assert.strictEqual(
    m.decodeEntities('&amp;&lt;&gt;&quot;&#39;&nbsp;&yen;&#65;&#x41;'),
    '&<>"\' ¥AA'
  );
});

// ---------- ID 生成（安定・12桁hex） ----------
check('feedId / articleId: 安定した12桁hexを返す', () => {
  const id1 = m.feedId('https://example.com/rss.xml');
  const id2 = m.feedId('https://example.com/rss.xml');
  assert.strictEqual(id1, id2);
  assert.ok(/^[0-9a-f]{12}$/.test(id1), `12桁hexであること (got ${id1})`);
  assert.ok(/^[0-9a-f]{12}$/.test(m.articleId('https://example.com/a', 'タイトル')));
});

// ---------- 日付トークン除外ヘルパー ----------
check('isDateNumericToken: 日付トークンを除外し内容語を残す', () => {
  assert.strictEqual(m.isDateNumericToken('10'), true);
  assert.strictEqual(m.isDateNumericToken('10月'), true);
  assert.strictEqual(m.isDateNumericToken('月1'), true);
  assert.strictEqual(m.isDateNumericToken('1日'), true);
  assert.strictEqual(m.isDateNumericToken('2026'), true);
  assert.strictEqual(m.isDateNumericToken('3銀'), false);
  assert.strictEqual(m.isDateNumericToken('統合'), false);
  assert.strictEqual(m.isDateNumericToken('銀行'), false);
});

if (process.exitCode) {
  console.error('FAIL: テストに失敗しました');
} else {
  console.log(`PASS: 全 ${n} 項目が成功しました`);
}
