'use strict';

/**
 * newsflow server.js
 * - 47都道府県のローカルニュースを RSS から15分ごとに定期収集・仕分け
 * - GET /api/news で仕分け済み最新ニュースを JSON 配信（§4.2.2 固定契約 + 拡張キー）
 * - public/ を静的配信（サイネージ画面 + RSS管理画面）
 * - PORT: 3364（127.0.0.1 で待受。外部公開は Tailscale Serve の HTTPS 経由）
 * - 拡張: 記事本文抽出(og:description優先) / 3行要約 / 類似グループ化・分散配置 /
 *         RSSフィード追加削除API (data/feeds.json 永続化)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
const Parser = require('rss-parser');

const PORT = process.env.PORT || 3364;
// アプリバージョン（画面表記は「v.」+ この値）
const VERSION = '1.6.0';
const DEFAULT_INTERVAL_MINUTES = 15;
let FETCH_INTERVAL_MS = DEFAULT_INTERVAL_MINUTES * 60 * 1000; // 設定で動的に更新
let INTERVAL_MINUTES = DEFAULT_INTERVAL_MINUTES; // /api/news 互換キー（設定で動的に更新）
const MAX_PER_PREF = 10;
// 読み上げ本文の最大文字数（3行相当の目安。現行 220 を維持）
const BODY_READ_CHARS = parseInt(process.env.BODY_READ_CHARS || '220', 10) || 220;

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 newsflow/1.1 (+local signage)';

// 既定フィード（空 = 初期状態は未登録。利用者が管理画面/APIで追加する。
// data/feeds.json が存在すればそちらが正。登録フィードをリポジトリに同梱しない）
const DEFAULT_FEEDS = [];

// 可変フィード一覧（参照を維持したまま loadFeeds() で中身を置換する）
const FEEDS = DEFAULT_FEEDS.map((f) => ({ ...f }));

const DATA_FILE = path.join(__dirname, 'data', 'news.json');
const FEEDS_FILE = path.join(__dirname, 'data', 'feeds.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

// ---------- 設定ストア（RSS管理画面で変更。data/settings.json に永続化） ----------
const ALLOWED_RATES = [0.8, 1.0, 1.2, 1.4, 1.6];
const DEFAULT_SETTINGS = {
  fetchIntervalMinutes: 15, // RSS取得間隔（分）
  maxAgeHours: 24, // この時間以内のニュースのみ表示
  ttsEnabled: true, // 読み上げ On/Off
  ttsRate: 1.2, // 読み上げ速度（ALLOWED_RATES のいずれか）
  theme: 'dark', // 画面テーマ（'dark' / 'light'）
  weatherArea: '130000', // 天気の地域（気象庁の予報区コード。既定は東京）
};

function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

/** 読み上げ速度を ALLOWED_RATES のいずれかに寄せる（数値以外は既定 1.2） */
function snapRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.ttsRate;
  let best = ALLOWED_RATES[0];
  let bestDiff = Math.abs(n - best);
  for (const r of ALLOWED_RATES) {
    const d = Math.abs(n - r);
    if (d < bestDiff) {
      best = r;
      bestDiff = d;
    }
  }
  return best;
}

function isValidRate(v) {
  return ALLOWED_RATES.includes(Number(v));
}

/**
 * 設定の正規化（純粋関数。未知キー無視・範囲外は丸め/既定値）
 * @param {object} input 部分設定でも可
 * @param {object} base マージ元（省略時は既定値）
 */
function normalizeSettings(input, base) {
  const b = { ...DEFAULT_SETTINGS, ...(base || {}) };
  const s = { ...b };
  const src = input && typeof input === 'object' ? input : {};
  if (src.fetchIntervalMinutes !== undefined) {
    let n = parseInt(src.fetchIntervalMinutes, 10);
    if (!Number.isFinite(n)) n = b.fetchIntervalMinutes;
    n = Math.max(5, Math.min(180, n));
    s.fetchIntervalMinutes = n;
  }
  if (src.maxAgeHours !== undefined) {
    let n = Number(src.maxAgeHours);
    if (!Number.isFinite(n)) n = b.maxAgeHours;
    n = Math.max(1, Math.min(168, n));
    s.maxAgeHours = n;
  }
  if (src.ttsEnabled !== undefined) {
    const v = src.ttsEnabled;
    s.ttsEnabled = !(v === false || v === 0 || v === 'false' || v === '0' || v === 'off');
  }
  if (src.ttsRate !== undefined) {
    s.ttsRate = snapRate(src.ttsRate);
  }
  if (src.theme !== undefined) {
    const t = String(src.theme).toLowerCase();
    s.theme = t === 'light' ? 'light' : t === 'dark' ? 'dark' : b.theme;
  }
  if (src.weatherArea !== undefined) {
    // 気象庁の予報区コードのみ受け付ける（未知値は維持/既定に寄せる）
    const c = String(src.weatherArea).trim();
    if (WEATHER_AREAS[c]) {
      s.weatherArea = c;
    } else if (!WEATHER_AREAS[b.weatherArea]) {
      s.weatherArea = DEFAULT_SETTINGS.weatherArea;
    }
  }
  return s;
}

/** 記事が表示対象の時間内か（pubDate 優先・無ければ fetchedAt・日付無しは保持） */
function isWithinHours(entry, maxAgeHours, nowMs) {
  const hours = Number(maxAgeHours);
  if (!Number.isFinite(hours) || hours <= 0) return true;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const src = (entry && (entry.pubDate || entry.fetchedAt)) || null;
  if (!src) return true;
  const t = Date.parse(src);
  if (Number.isNaN(t)) return true;
  return now - t <= hours * 3600 * 1000;
}

/** 配列を時間フィルタで絞る（純粋関数） */
function filterByAge(items, maxAgeHours, nowMs) {
  if (!Array.isArray(items)) return [];
  return items.filter((e) => isWithinHours(e, maxAgeHours, nowMs));
}

let settings = getDefaultSettings();

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return settings;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    const src = raw && raw.settings ? raw.settings : raw;
    settings = normalizeSettings(src, getDefaultSettings());
    return settings;
  } catch (e) {
    console.error('settings load failed (既定を使用):', String((e && e.message) || e));
    return settings;
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ savedAt: now, updatedAt: now, settings }, null, 2),
      'utf-8'
    );
  } catch (e) {
    console.error('settings save failed:', String((e && e.message) || e));
  }
}

/** 設定変更を取得タイマーに反映する */
let fetchTimer = null;
function applyIntervalSettings() {
  INTERVAL_MINUTES = settings.fetchIntervalMinutes || DEFAULT_INTERVAL_MINUTES;
  FETCH_INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;
}

function scheduleFetch() {
  if (fetchTimer) clearInterval(fetchTimer);
  fetchTimer = setInterval(() => {
    fetchAllFeeds().catch((e) => console.error('periodic fetch failed:', e));
  }, FETCH_INTERVAL_MS);
  if (fetchTimer.unref) fetchTimer.unref();
}

/** 制御系 API（update/restart）の有効判定。DISABLE_CONTROL=1 で無効化 */
function controlEnabled() {
  const v = process.env.DISABLE_CONTROL;
  return !(v === '1' || v === 'true');
}

// 47都道府県（北→南の順序。HTTP応答の順序にも使用）
const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

// 判定用キーワード: 正式名 + 短縮形（「県/府/都」を落とした形）
function shortName(pref) {
  if (pref === '北海道') return '北海道';
  if (pref === '東京都') return '東京';
  if (pref === '大阪府') return '大阪';
  if (pref === '京都府') return '京都';
  return pref.replace(/(県|府|都)$/, '');
}

const PREF_KEYWORDS = PREFECTURES.map((pref) => ({
  pref,
  keywords: pref === shortName(pref) ? [pref] : [pref, shortName(pref)],
}));

// ---------- 話題別フィード（地域判定をせず、URL で話題バケットに振り分ける） ----------
// Yahoo!ニュース・トピックス RSS 等、地域以外のニュースを混ぜたい場合に登録する。
// ここに載せた URL のフィードから来た記事は、タイトル中の地名にかかわらず話題バケット行きになる。
const TOPIC_FEEDS = {
  'https://news.yahoo.co.jp/rss/topics/world.xml': '国際',
  'https://news.yahoo.co.jp/rss/topics/it.xml': 'IT',
  'https://news.yahoo.co.jp/rss/topics/science.xml': '科学',
  'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml': 'IT',
  'https://feeds.cnn.co.jp/rss/cnn/cnn.rdf': '海外',
  'http://feeds.afpbb.com/rss/afpbb/afpbbnews': '海外',
};
// 話題バケット名の一覧（北→南のような固定順序。playlist では「全国」の後に配置）
const TOPIC_CATEGORIES = [...new Set(Object.values(TOPIC_FEEDS))];
const TOPIC_FEED_MAP = new Map(
  Object.entries(TOPIC_FEEDS).map(([u, c]) => [normalizeFeedUrl(u), c])
);

/** フィードURLから話題カテゴリを返す。該当なしは null（通常の都道府県判定へ） */
function topicCategoryForFeed(url) {
  return TOPIC_FEED_MAP.get(normalizeFeedUrl(url)) || null;
}

/**
 * タイトル＋本文から都道府県を判定（複数ヒット可）
 * @returns {string[]} ヒットした都道府県名配列（なければ空配列）
 */
function detectPrefectures(title, body) {
  const text = `${title || ''} ${body || ''}`;
  if (!text.trim()) return [];
  const hit = [];
  for (const { pref, keywords } of PREF_KEYWORDS) {
    if (pref === '京都府') {
      // §4.2.1 必須例外: 「東京都」を「京都府」と誤判定しない。
      // 正式名「京都府」は通常判定、短縮形「京都」は負の後読みで判定。
      if (text.includes('京都府') || /(?<!東)京都/.test(text)) {
        hit.push(pref);
      }
      continue;
    }
    if (keywords.some((kw) => kw && text.includes(kw))) {
      hit.push(pref);
    }
  }
  return hit;
}

// メモリ内ストア: { [pref]: Array<{prefecture,title,link,source,pubDate,fetchedAt,body,summary}> }
// 「全国」は都道府県名を含まないニュースの受け皿バケット（内部保持のみ。/api/news の prefectures には含めない）
const store = new Map();
for (const p of PREFECTURES) store.set(p, []);
store.set('全国', []);
for (const c of TOPIC_CATEGORIES) store.set(c, []);

// 記事本文キャッシュ: url -> body（store と二重保持。オンデマンド解決用）
const bodyCache = new Map();
// 記事写真キャッシュ: url -> imageUrl（og:image 等。store と二重保持）
const imageCache = new Map();

// フィード状態（/api/news の sources[]・/api/feeds の feeds[] として返却）
function freshFeedState(f) {
  return {
    id: feedId(f.url),
    name: f.name,
    url: f.url,
    enabled: f.enabled !== false,
    ok: false,
    items: 0,
    error: null,
  };
}

let feedStates = FEEDS.map(freshFeedState);

let lastUpdatedAt = null;
let lastFetchResult = { ok: 0, ng: 0, items: 0, errors: [] };

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': BROWSER_UA },
  // 写真抽出用: media:content / media:thumbnail を配列のまま保持する
  customFields: {
    feed: [],
    item: [
      ['media:content', 'media:content', { keepArray: true }],
      ['media:thumbnail', 'media:thumbnail', { keepArray: true }],
      'media:group',
    ],
  },
});

/** タイトル正規化: 前後trim・連続する半角/全角空白を1つに圧縮（§4.2.1 重複排除用） */
function normalizeTitle(t) {
  return (t || '').trim().replace(/[ \t\u3000]+/g, ' ');
}

function normalizeItem(raw, sourceName) {
  const title = (raw.title || '').trim();
  if (!title) return null;
  const link = (raw.link || raw.guid || '').trim();
  const pubDate =
    raw.isoDate || raw.pubDate || (raw['dc:date'] || raw['dcterms:date'] || null);
  const body = (raw.contentSnippet || raw.content || raw.summary || raw.description || '').toString();
  let ts = null;
  if (pubDate) {
    const t = Date.parse(pubDate);
    if (!Number.isNaN(t)) ts = new Date(t).toISOString();
  }
  return { title, link, pubDate: ts, body, source: sourceName, image: extractFeedImage(raw) };
}

/** http(s) の画像URLか（data: URI や空文字を除外） */
function isImageUrl(u) {
  return typeof u === 'string' && /^https?:\/\//.test(u.trim());
}

/**
 * RSS アイテムから写真URLを抜き出す。優先度:
 * 1. enclosure（画像タイプ） 2. media:content（medium="image"） 3. media:thumbnail
 * 4. media:group 配下の media:content 5. 本文HTML内の最初の <img>
 */
function extractFeedImage(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const attrsOf = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.$ && typeof node.$ === 'object') return node.$;
    if (typeof node.url === 'string') return node;
    return null;
  };
  const pickMedia = (nodes) => {
    for (const node of asList(nodes)) {
      const a = attrsOf(node);
      if (!a || !isImageUrl(a.url)) continue;
      const medium = String(a.medium || '').toLowerCase();
      const type = String(a.type || '').toLowerCase();
      if (medium === 'image' || type.startsWith('image/')) return a.url.trim();
      // medium/type 無記載でも拡張子が画像なら採用（video の誤採用は拡張子で回避）
      if (!medium && !type && /\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i.test(a.url)) {
        return a.url.trim();
      }
    }
    return '';
  };
  // 1. enclosure
  const enc = raw.enclosure;
  if (enc && isImageUrl(enc.url)) {
    const t = String(enc.type || '').toLowerCase();
    if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i.test(enc.url)) {
      return enc.url.trim();
    }
  }
  // 2-3. media:content / media:thumbnail
  const mc = pickMedia(raw['media:content']);
  if (mc) return mc;
  const mt = pickMedia(raw['media:thumbnail']);
  if (mt) return mt;
  // 4. media:group 配下
  const groups = asList(raw['media:group']);
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const inner = pickMedia(g['media:content']) || pickMedia(g['media:thumbnail']);
    if (inner) return inner;
  }
  // 5. 本文HTML内の最初の <img>（トラッキングピクセル等の data: URI は除外）
  const html = (raw.content && raw.content.toString()) || '';
  if (html) {
    const m = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
    if (m && m[1] && isImageUrl(m[1])) return m[1].trim();
  }
  return '';
}

/**
 * 読み上げ用に【...】で囲まれた部分（媒体名など）を除去する。
 * 表示用の原文（title/body）は保持し、TTS に渡す直前・要約生成時にのみ適用する。
 */
function stripSpeakBrackets(s) {
  return (s || '').replace(/【[^】]*】/g, '');
}

/**
 * 読み上げ文を組み立てる（タイトル + 本文要約）。【...】は読み上げない。
 * 空白の連続は1つにたたみ、前後の空白を除去する。
 */
function buildSpeakText(title, extra) {
  const t = stripSpeakBrackets(title).replace(/[ \t\u3000]+/g, ' ').trim();
  const b = stripSpeakBrackets(extra || '').replace(/\s+/g, ' ').trim();
  if (!t) return b;
  return t + (b ? '。' + b : '');
}

// ---------- 要約（3行程度） ----------
/**
 * 本文を3文程度に要約して読み上げ用テキストを作る。
 * - 文区切り（。！？) で分割し先頭から最大3文
 * - 全体は最大 220 文字で丸める（TTS が長くなりすぎないように）
 */
function summarizeText(text, maxSentences = 3, maxChars = 220) {
  const src = stripSpeakBrackets(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const parts = src.match(/[^。！？\n]+[。！？\n]?/g) || [src];
  const sents = parts.map((s) => s.trim()).filter(Boolean).slice(0, maxSentences);
  let out = sents.join('');
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/…?$/, '…');
  return out;
}

/**
 * 読み上げ用の 3 行相当テキスト（指示書 §3.2 の bodyExcerpt）。
 * summarizeText の別名（先頭3文・上限文字数で文末丸め）。現行 summary と同値。
 * 【...】は読み上げないため除去する（表示用の body 原文は保持）。
 */
function bodyExcerpt(body, max) {
  return summarizeText(stripSpeakBrackets(body), 3, max == null ? BODY_READ_CHARS : max);
}

/**
 * 記事 ID: link（無ければ title）の SHA-1 先頭 12 桁（crypto 使用・依存追加なし）
 */
function articleId(link, title) {
  const src = (link && String(link)) || (title && String(title)) || '';
  return crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
}

/**
 * フィード ID: URL の SHA-1 先頭 12 桁（URL に対して安定）
 */
function feedId(url) {
  return crypto.createHash('sha1').update(String(url || '').trim()).digest('hex').slice(0, 12);
}

// ---------- 類似記事グループ化 ----------
function stripBrackets(s) {
  return (s || '').replace(/【[^】]*】/g, '').replace(/［[^］]*］/g, '').replace(/\[[^\]]*\]/g, '');
}

function titleTokens(title) {
  const t = stripBrackets(normalizeTitle(title))
    .replace(/[、。！？「」『』（）()・―—\-:：;；\/|｜@＠#＃★☆※・]/g, ' ')
    .trim();
  if (!t) return new Set();
  const tokens = new Set();
  // 長い語の部分一致に効くよう、文字バイグラムも併用する
  const compact = t.replace(/\s+/g, '');
  for (let i = 0; i + 1 < compact.length; i++) {
    tokens.add(compact.slice(i, i + 2));
  }
  for (const w of t.split(/\s+/)) {
    if (w.length >= 2) tokens.add(w);
  }
  return tokens;
}

/**
 * 日付・時刻・数字のみのトークンかどうかを判定する。
 * 例: "10", "0月", "月1", "1日", "2026", "10/1" → true（類似度計算から除外）
 * 数字を含み、かつ数字・日付単位・記号のみで構成される場合に true。
 * "3銀"（銀は内容語）や "震度1" を含む語彙トークンは false（内容語として保持）。
 * 数字を含まないトークンは内容語とみなして保持する（再現率維持のため）。
 */
function isDateNumericToken(tok) {
  if (!tok) return true;
  if (!/[0-9０-９]/.test(tok)) return false;
  return /^[0-9０-９年月日時分秒曜週日号付紙面掲版載第／\/．\.\-\-―—:：,，、\s\(\)（）［］【\]()]+$/.test(tok);
}

/** titleTokens から日付・数字トークンを除いた内容語トークン集合を返す */
function contentTokens(title) {
  const all = titleTokens(title);
  const out = new Set();
  for (const t of all) {
    if (!isDateNumericToken(t)) out.add(t);
  }
  return out;
}
/** タイトル類似度（0..1。内容語トークンの Jaccard。デバッグ・表示用） */
function titleSimilarity(a, b) {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 2件のタイトルが「似た記事」かどうかを判定する。
 * - 完全一致・包含（8文字以上）・同一リンク級の近さ → true
 * - 内容語トークン（日付・数字トークンを除外）のバイグラム Jaccard + 包含率の複合ルール。
 *   日付表現（例: 10月1日）の共通バイグラムだけでは統合されないよう、
 *   数字を含む日付トークンを類似度計算から除外し、内容語の共通を必須とする。
 *   ※貪欲クラスタリングは代表との比較のみ行うため連鎖的な巨大クラスタは生じない
 */
function areSimilarTitles(a, b) {
  const na = stripBrackets(normalizeTitle(a)).replace(/\s+/g, '');
  const nb = stripBrackets(normalizeTitle(b)).replace(/\s+/g, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = Math.min(na.length, nb.length);
  if (short >= 8 && (na.includes(nb) || nb.includes(na))) return true;
  // 日付・数字トークンを除外した内容語トークンで類似度を計算する
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size < 4 || tb.size < 4) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // 内容語の共通が 2 件未満なら日付だけの一致とみなして統合しない
  if (inter < 2) return false;
  const union = ta.size + tb.size - inter;
  const j = union === 0 ? 0 : inter / union;
  const cont = inter / Math.min(ta.size, tb.size);
  if (j >= 0.3) return true;
  if (j >= 0.12 && cont >= 0.24 && inter >= 3) return true;
  return false;
}

/** 類似判定のしきい値説明は areSimilarTitles を参照 */

/**
 * フラットな記事配列に groupId を付与する（貪欲クラスタリング）。
 * @returns {{ items: Array, groups: Array<{groupId,size,titles}> }}
 */
function assignGroups(flatItems) {
  const reps = []; // [{groupId, title, link}]
  const groups = new Map(); // groupId -> indices
  let n = 0;
  const items = flatItems.map((item) => {
    let gid = null;
    for (const r of reps) {
      if (
        (item.link && r.link && item.link === r.link) ||
        areSimilarTitles(item.title, r.title)
      ) {
        gid = r.groupId;
        break;
      }
    }
    if (!gid) {
      n += 1;
      gid = `g${n}`;
      reps.push({ groupId: gid, title: item.title, link: item.link });
      groups.set(gid, []);
    }
    groups.get(gid).push(item);
    return { ...item, groupId: gid };
  });
  // groupSize を付与
  for (const it of items) {
    it.groupSize = (groups.get(it.groupId) || []).length;
  }
  const groupList = [...groups.entries()].map(([groupId, members]) => ({
    groupId,
    size: members.length,
    representative: members[0] ? members[0].title : '',
  }));
  return { items, groups: groupList };
}

/**
 * 同じ groupId が連続しないよう並べ替える（貪欲・元順序優先）。
 * 残り候補のうち直前と groupId が異なるものを元順序で最も早いものから選ぶ。
 */
function interleaveAvoidSameGroup(items) {
  const rest = items.slice();
  const out = [];
  let prevGid = null;
  while (rest.length > 0) {
    let pick = rest.findIndex((it) => it.groupId !== prevGid);
    if (pick === -1) pick = 0; // 残り全部が同グループの場合は許容
    const [one] = rest.splice(pick, 1);
    out.push(one);
    prevGid = one.groupId;
  }
  return out;
}

// ---------- 記事本文抽出 ----------
function decodeEntities(s) {
  return (s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&yen;/gi, '¥')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return '';
      }
    });
}

function extractMetaContent(html, attr, value) {
  // <meta property="og:description" content="..."> / <meta name="description" content="...">
  // 属性順序が逆の場合にも対応するため2パターン試す
  const patterns = [
    new RegExp(
      `<meta[^>]*${attr}\\s*=\\s*["']${value}["'][^>]*content\\s*=\\s*["']([\\s\\S]*?)["'][^>]*>`,
      'i'
    ),
    new RegExp(
      `<meta[^>]*content\\s*=\\s*["']([\\s\\S]*?)["'][^>]*${attr}\\s*=\\s*["']${value}["'][^>]*>`,
      'i'
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]).trim();
  }
  return '';
}

/**
 * 記事HTMLから本文要約文を抽出する。優先度:
 * 1. og:description 2. meta[name=description] 3. JSON-LD NewsArticle の description 4. 長めの <p>
 */
function extractArticleDescription(html) {
  if (!html) return '';
  const og = extractMetaContent(html, 'property', 'og:description');
  if (og && og.length >= 10) return og;
  const meta = extractMetaContent(html, 'name', 'description');
  if (meta && meta.length >= 10) return meta;
  const ldMatch = html.match(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (ldMatch) {
    for (const tag of ldMatch) {
      const inner = tag.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
      const dm = inner.match(/"description"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (dm && dm[1]) {
        const desc = decodeEntities(dm[1].replace(/\\n/g, ' ').replace(/\\"/g, '"')).trim();
        if (desc.length >= 10) return desc;
      }
    }
  }
  // フォールバック: 30文字以上の <p> の先頭
  const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 30);
  if (ps.length > 0) return decodeEntities(ps[0]).slice(0, 500);
  return '';
}

/** 記事HTMLから og:image（無ければ twitter:image）を抜き出す */
function extractOgImage(html) {
  if (!html) return '';
  const og = extractMetaContent(html, 'property', 'og:image');
  if (isImageUrl(og)) return og.trim();
  const tw = extractMetaContent(html, 'name', 'twitter:image');
  if (isImageUrl(tw)) return tw.trim();
  return '';
}

/**
 * 記事ページを1回取得して本文と写真URLを返す（og:image 優先）。
 * キャッシュ済みの片方だけが無い場合も再取得せず、ある分だけ返す。
 */
async function fetchArticlePage(url, timeoutMs = 10000) {
  if (!url || !/^https?:\/\//.test(url)) return { body: '', image: '' };
  if (bodyCache.has(url) && imageCache.has(url)) {
    return { body: bodyCache.get(url) || '', image: imageCache.get(url) || '' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) {
      return { body: bodyCache.get(url) || '', image: imageCache.get(url) || '' };
    }
    const html = await res.text();
    const body = extractArticleDescription(html);
    const image = extractOgImage(html);
    bodyCache.set(url, body);
    imageCache.set(url, image);
    if (bodyCache.size > 1000) {
      const first = bodyCache.keys().next().value;
      bodyCache.delete(first);
    }
    if (imageCache.size > 1000) {
      const first = imageCache.keys().next().value;
      imageCache.delete(first);
    }
    return { body, image };
  } catch {
    return { body: bodyCache.get(url) || '', image: imageCache.get(url) || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArticleBody(url, timeoutMs = 10000) {
  if (!url || !/^https?:\/\//.test(url)) return '';
  if (bodyCache.has(url)) return bodyCache.get(url) || '';
  const { body } = await fetchArticlePage(url, timeoutMs);
  return body;
}

/** body・image 未取得の記事に本文・写真を付与する（並列数制限・上限付き・ベストエフォート） */
async function fillMissingBodies(items, { concurrency = 5, limit = 60 } = {}) {
  const targets = items.filter((it) => it.link && (!it.body || !it.image)).slice(0, limit);
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const it = targets[i++];
      // 両方キャッシュ済みなら取得不要（store 反映のみ）
      let body = it.body || '';
      let image = it.image || '';
      if (!body || !image) {
        const page = await fetchArticlePage(it.link);
        if (!body && page.body) body = page.body;
        if (!image && page.image) image = page.image;
      }
      if (body && !it.body) {
        it.body = body;
        it.summary = summarizeText(body);
        bodyCache.set(it.link, body);
      }
      if (image) {
        if (!it.image) it.image = image;
        imageCache.set(it.link, image);
      }
      // store 側の同一 link にも反映
      for (const [, list] of store) {
        for (const e of list) {
          if (e.link === it.link) {
            if (body && !e.body) {
              e.body = body;
              e.summary = it.summary || summarizeText(body);
            }
            if (image && !e.image) e.image = image;
          }
        }
      }
    }
  }
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
  );
}

// ---------- 永続化 ----------
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const data = {
      savedAt: new Date().toISOString(),
      lastUpdatedAt,
      feedStates,
      lastFetchResult,
      store: Object.fromEntries(store.entries()),
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('persist save failed:', String((e && e.message) || e));
  }
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    if (raw && raw.store) {
      for (const p of [...PREFECTURES, '全国', ...TOPIC_CATEGORIES]) {
        if (Array.isArray(raw.store[p])) {
          store.set(
            p,
            raw.store[p].map((e) => ({
              prefecture: e.prefecture,
              title: e.title,
              link: e.link,
              source: e.source,
              pubDate: e.pubDate || null,
              fetchedAt: e.fetchedAt,
              body: e.body || '',
              summary: e.summary || (e.body ? summarizeText(e.body) : ''),
              image: e.image || '',
            }))
          );
          for (const e of store.get(p)) {
            if (e.link && e.body) bodyCache.set(e.link, e.body);
            if (e.link && e.image) imageCache.set(e.link, e.image);
          }
        }
      }
    }
    if (raw && raw.lastUpdatedAt) lastUpdatedAt = raw.lastUpdatedAt;
    // feedStates は件数が FEEDS と一致する場合のみ復元（フィード構成変更時は現状を優先）
    if (Array.isArray(raw.feedStates)) {
      // id / url ベースで突き合わせ（フィード数変更に耐える。旧形式 {name,url} も url で復元）
      const byUrl = new Map();
      const byId = new Map();
      for (const s of raw.feedStates) {
        if (!s || !s.url) continue;
        byUrl.set(s.url, s);
        if (s.id) byId.set(s.id, s);
      }
      feedStates = FEEDS.map((f) => {
        const saved = byId.get(feedId(f.url)) || byUrl.get(f.url);
        const base = freshFeedState(f);
        if (saved) {
          base.ok = !!saved.ok;
          base.items = saved.items || 0;
          base.error = saved.error || null;
        }
        return base;
      });
    }
    if (raw && raw.lastFetchResult) lastFetchResult = raw.lastFetchResult;
    console.log(`[起動] キャッシュ ${DATA_FILE} を読み込みました`);
  } catch (e) {
    console.error('persist load failed (続行):', String((e && e.message) || e));
  }
}

// ---------- フィード管理 ----------
function loadFeeds() {
  try {
    if (!fs.existsSync(FEEDS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : raw.feeds;
    if (!Array.isArray(arr) || arr.length === 0) return;
    const cleaned = arr
      .filter((f) => f && typeof f.url === 'string' && /^https?:\/\//.test(f.url.trim()))
      .map((f) => ({
        name: (f.name || f.url).toString().slice(0, 100),
        url: f.url.trim(),
        enabled: f.enabled !== false,
      }));
    if (cleaned.length === 0) return;
    FEEDS.length = 0;
    for (const f of cleaned) FEEDS.push(f);
    feedStates = FEEDS.map(freshFeedState);
    console.log(`[起動] フィード定義 ${FEEDS_FILE} を読み込みました (${FEEDS.length}件)`);
  } catch (e) {
    console.error('feeds load failed (既定を使用):', String((e && e.message) || e));
  }
}

function saveFeeds() {
  try {
    fs.mkdirSync(path.dirname(FEEDS_FILE), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      FEEDS_FILE,
      JSON.stringify(
        {
          savedAt: now,
          updatedAt: now,
          feeds: FEEDS.map((f) => ({
            id: feedId(f.url),
            name: f.name,
            url: f.url,
            enabled: f.enabled !== false,
          })),
        },
        null,
        2
      ),
      'utf-8'
    );
  } catch (e) {
    console.error('feeds save failed:', String((e && e.message) || e));
  }
}

/** 全 store を空にして永続化する（フィード削除時の古い記事残存を防ぐ） */
function clearStore() {
  for (const p of [...PREFECTURES, '全国', ...TOPIC_CATEGORIES]) store.set(p, []);
  saveStore();
}

/**
 * 1フィード分の取得アイテムを store に取り込む（一括・個別取得で共用）。
 * 戻り値は新規追加件数。
 */
function ingestFeedItems(feed, items, fetchedAt) {
  let added = 0;
  // 話題別フィードは都道府県判定をせず、話題バケットに直行させる
  const topic = topicCategoryForFeed(feed.url);
  for (const raw of items || []) {
    const n = normalizeItem(raw, feed.name);
    if (!n) continue;
    const prefs = topic ? [] : detectPrefectures(n.title, n.body);
    const buckets = topic ? [topic] : prefs.length > 0 ? prefs : ['全国'];
    for (const pref of buckets) {
      const list = store.get(pref) || [];
      // 重複排除: 正規化タイトル or link をキーに同一県内の重複を除外
      const normT = normalizeTitle(n.title);
      const dup = list.find(
        (e) => normalizeTitle(e.title) === normT || (n.link && e.link === n.link && n.link !== '')
      );
      if (dup) {
        // 既存記事に写真が無く、今回の取得にあれば補完する
        if (!dup.image && n.image) {
          dup.image = n.image;
          if (dup.link) imageCache.set(dup.link, n.image);
        }
        continue;
      }
      list.unshift({
        prefecture: pref,
        title: n.title,
        link: n.link,
        source: n.source,
        pubDate: n.pubDate,
        fetchedAt,
        body: '',
        summary: '',
        image: n.image || '',
      });
      if (n.image && n.link) imageCache.set(n.link, n.image);
      // pubDate 新しい順に並べ替え（pubDateなしは後ろ）→ 最新10件に trims
      list.sort((a, b) => {
        if (a.pubDate && b.pubDate) return b.pubDate.localeCompare(a.pubDate);
        if (a.pubDate) return -1;
        if (b.pubDate) return 1;
        return b.fetchedAt.localeCompare(a.fetchedAt);
      });
      if (list.length > MAX_PER_PREF) list.length = MAX_PER_PREF;
      store.set(pref, list);
      added++;
    }
  }
  return added;
}

async function fetchAllFeeds() {
  const fetchedAt = new Date().toISOString();
  // §4.2.1: Promise.allSettled で全 FEEDS を並列取得（無効フィードはスキップ）
  const targets = [];
  FEEDS.forEach((feed, i) => {
    if (feed.enabled !== false) targets.push({ feed, index: i });
  });
  const results = await Promise.allSettled(
    targets.map(({ feed }) => parser.parseURL(feed.url))
  );

  let ok = 0;
  let ng = 0;
  let itemCount = 0;
  const errors = [];
  const nextStates = FEEDS.map((f) => freshFeedState(f));

  results.forEach((r, k) => {
    const { feed, index } = targets[k];
    if (r.status === 'fulfilled') {
      const items = (r.value && r.value.items) || [];
      ok++;
      itemCount += items.length;
      nextStates[index] = {
        id: feedId(feed.url),
        name: feed.name,
        url: feed.url,
        enabled: true,
        ok: true,
        items: items.length,
        error: null,
      };
      console.log(`[取得] ${feed.name}: ${items.length}件`);
      ingestFeedItems(feed, items, fetchedAt);
    } else {
      ng++;
      const msg = String((r.reason && r.reason.message) || r.reason);
      errors.push({ feed: feed.name, url: feed.url, error: msg });
      nextStates[index] = {
        id: feedId(feed.url),
        name: feed.name,
        url: feed.url,
        enabled: true,
        ok: false,
        items: 0,
        error: msg,
      };
      console.warn(`[取得失敗] ${feed.name}: ${msg}`);
    }
  });

  feedStates = nextStates;
  lastUpdatedAt = fetchedAt;
  lastFetchResult = { ok, ng, items: itemCount, errors };
  const totalKept = [...store.values()].reduce((s, l) => s + l.length, 0);
  console.log(
    `[${fetchedAt}] fetch done: ok=${ok} ng=${ng} rawItems=${itemCount} kept=${totalKept}`
  );
  saveStore();

  // 本文抽出はベストエフォートで追いかけ取得（RSS取得自体はブロックしない設計だが、
  // 起動直後の1回はクライアントが本文付きで受け取れるよう待機する)
  try {
    const all = [];
    for (const [, list] of store) for (const e of list) all.push(e);
    // 新しい順に上限付きで取得
    all.sort((a, b) => (b.fetchedAt || '').localeCompare(a.fetchedAt || ''));
    await fillMissingBodies(all);
    saveStore();
  } catch (e) {
    console.warn('body fill failed (続行):', String((e && e.message) || e));
  }
}

/** 全 store をフラット化（北→南順・県内は pubDate 新しい順のまま・時間フィルタ適用） */
function flatItems() {
  const out = [];
  const nowMs = Date.now();
  for (const pref of [...PREFECTURES, '全国', ...TOPIC_CATEGORIES]) {
    const list = store.get(pref) || [];
    for (const e of list) {
      if (!isWithinHours(e, settings.maxAgeHours, nowMs)) continue;
      out.push({
        prefecture: e.prefecture || pref,
        title: e.title,
        link: e.link,
        source: e.source,
        pubDate: e.pubDate || null,
        fetchedAt: e.fetchedAt,
        body: e.body || bodyCache.get(e.link) || '',
        summary: e.summary || summarizeText(e.body || bodyCache.get(e.link) || ''),
        image: e.image || imageCache.get(e.link) || '',
      });
    }
  }
  return out;
}

/** グループメンバーのキー（prefecture+title+link。他県の同一link重複を区別する） */
function memberKey(m, fallbackPref) {
  return `${m.prefecture || fallbackPref || ''}\u0000${m.title}\u0000${m.link}`;
}

/**
 * related 配列を作る: 同グループの self 以外のメンバーを
 * [{ prefecture, title, link, source, pubDate }] 形で返す。単独グループは []。
 * （prefecture は表示用。旧クライアントは無視する）
 */
function relatedOf(members, selfKey) {
  return (members || [])
    .filter((m) => memberKey(m) !== selfKey)
    .map((m) => ({
      prefecture: m.prefecture || '',
      title: m.title,
      link: m.link,
      source: m.source,
      pubDate: m.pubDate || null,
    }));
}

/**
 * 同一 groupId は最初の1件だけ残す（順序保持）。
 * 類似ニュースの重複再生を防ぐための分散配置後の仕上げ用。
 * 残った代表の groupSize / related は呼び出し側で付け直す。
 */
function dedupeByGroup(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const gid = it && it.groupId != null ? it.groupId : null;
    if (gid == null) {
      out.push(it);
      continue;
    }
    if (seen.has(gid)) continue;
    seen.add(gid);
    out.push(it);
  }
  return out;
}

/** §4.2.2 固定契約の prefectures 配列を構築（北→南順・非空県のみ）+ 拡張キー付き */
function buildPrefectures() {
  const flat = flatItems();
  const { items: grouped } = assignGroups(flat);
  const byKey = new Map(grouped.map((g) => [memberKey(g), g]));
  const membersByGroup = new Map();
  for (const g of grouped) {
    if (!membersByGroup.has(g.groupId)) membersByGroup.set(g.groupId, []);
    membersByGroup.get(g.groupId).push(g);
  }
  const out = [];
  const nowMs = Date.now();
  for (const pref of PREFECTURES) {
    const list = (store.get(pref) || []).filter((e) => isWithinHours(e, settings.maxAgeHours, nowMs));
    if (list.length === 0) continue;
    out.push({
      prefecture: pref,
      news: list.map((e) => {
        const g = byKey.get(memberKey(e, pref));
        const body = e.body || bodyCache.get(e.link) || '';
        const summary = e.summary || summarizeText(body);
        const image = e.image || imageCache.get(e.link) || '';
        const members = (g && membersByGroup.get(g.groupId)) || [];
        return {
          title: e.title,
          link: e.link,
          source: e.source,
          pubDate: e.pubDate,
          fetchedAt: e.fetchedAt,
          body,
          summary,
          image,
          groupId: g ? g.groupId : null,
          groupSize: g ? g.groupSize : 1,
          id: articleId(e.link, e.title),
          bodyExcerpt: summary,
          related: g ? relatedOf(members, memberKey(e, pref)) : [],
        };
      }),
    });
  }
  return out;
}

/**
 * サイネージ再生用の全体プレイリストを構築する。
 * - 全体で類似グループを割り当てた上で、同一 groupId が連続しないよう分散配置する。
 * - 同一グループは最初の1件だけ残し、残りは related に格納する（重複再生しない）。
 *   県を跨いだ類似記事（青森→数件後に岩手など）もここで1件にまとまる。
 * - 「全国」バケットは末尾に回す（ローカル優先）。話題バケット（国際/IT/科学/海外）はさらに後ろ。
 */
function buildPlaylist() {
  const flat = flatItems();
  // 全体でグループ化する（県・バケットを跨いだ類似も同一 groupId になる）
  const { items: grouped } = assignGroups(flat);
  const membersByGroup = new Map();
  for (const g of grouped) {
    if (!membersByGroup.has(g.groupId)) membersByGroup.set(g.groupId, []);
    membersByGroup.get(g.groupId).push(g);
  }
  const isLocal = (e) => PREFECTURES.includes(e.prefecture);
  const local = grouped.filter(isLocal);
  const national = grouped.filter((e) => e.prefecture === '全国');
  const topical = grouped.filter((e) => TOPIC_CATEGORIES.includes(e.prefecture));
  const ordered = [
    ...interleaveAvoidSameGroup(local),
    ...interleaveAvoidSameGroup(national),
    ...interleaveAvoidSameGroup(topical),
  ];
  // 同一グループの2件目以降は再生しない（最初の表示だけにする）
  const deduped = dedupeByGroup(ordered);
  // playlist 要素にも id / bodyExcerpt / related を付与（追加のみ。既存キーは不変）
  return deduped.map((it) => {
    const summary = it.summary || summarizeText(it.body || '');
    return {
      ...it,
      summary,
      id: articleId(it.link, it.title),
      bodyExcerpt: summary,
      related: relatedOf(membersByGroup.get(it.groupId) || [], memberKey(it)),
    };
  });
}

/** グループ一覧（表示用: ひとまとめ表示のため） */
function buildGroups() {
  const flat = flatItems();
  const { groups } = assignGroups(flat);
  const membersById = new Map(groups.map((g) => [g.groupId, []]));
  const { items } = assignGroups(flat);
  for (const it of items) membersById.get(it.groupId).push(it);
  return groups.map((g) => ({
    groupId: g.groupId,
    size: g.size,
    representative: g.representative,
    titles: membersById.get(g.groupId).map((m) => ({ prefecture: m.prefecture, title: m.title })),
  }));
}

function totalNewsCount() {
  const nowMs = Date.now();
  let n = 0;
  for (const p of [...PREFECTURES, ...TOPIC_CATEGORIES]) {
    const list = store.get(p) || [];
    for (const e of list) {
      if (isWithinHours(e, settings.maxAgeHours, nowMs)) n++;
    }
  }
  return n;
}

// ---- Express ----
const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 仕分け済み最新ニュース一式（§4.2.2 固定契約 + 拡張キー playlist/groups）
app.get('/api/news', (req, res) => {
  const prefectures = buildPrefectures();
  const totalNews = totalNewsCount();
  // 互換のため旧キー (news/count/fetch/updatedAt) も残す
  const news = {};
  for (const [k, v] of store.entries()) news[k] = v;
  const playlist = buildPlaylist();
  const groups = buildGroups();
  res.json({
    generatedAt: new Date().toISOString(),
    lastFetchAt: lastUpdatedAt,
    intervalMinutes: INTERVAL_MINUTES,
    totalNews,
    sources: feedStates,
    prefectures,
    // 旧キー（互換）
    updatedAt: lastUpdatedAt,
    count: [...store.values()].reduce((s, l) => s + l.length, 0),
    fetch: lastFetchResult,
    news,
    // 拡張キー（本タスク追加。既存キーの意味は不変）
    playlist,
    groups,
    groupsCount: groups.length,
    version: VERSION,
    settings,
  });
});

// 稼働確認用（§4.2.1 契約: ok/uptime/lastFetchAt/totalNews。updatedAt/port は互換で残す）
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    lastFetchAt: lastUpdatedAt,
    totalNews: totalNewsCount(),
    updatedAt: lastUpdatedAt,
    port: PORT,
    version: VERSION,
  });
});

app.get('/api/status', (req, res) => {
  const perPref = {};
  for (const [k, v] of store.entries()) perPref[k] = v.length;
  res.json({
    ok: true,
    updatedAt: lastUpdatedAt,
    feeds: FEEDS,
    fetch: lastFetchResult,
    perPref,
    version: VERSION,
    settings,
  });
});

// バージョン情報（トップページの小さな版表示用）
app.get('/api/version', (req, res) => {
  res.json({ ok: true, version: VERSION, display: `v.${VERSION}` });
});

// ---- 天気予報 API（気象庁API。設定の地域（都道府県→代表の一次細分区域）の今日/明日/明後日を返す） ----
const WEATHER_DEFAULT_AREA = '130000'; // 東京
// 予報区コード → { pref（都道府県）, area（一次細分区域コード）, areaName }。
// area は県庁所在地側の代表区域（原則として先頭区域）。
const WEATHER_AREAS = {
  '016000': { pref: '北海道', area: '016010', areaName: '石狩地方' },
  '020000': { pref: '青森県', area: '020010', areaName: '津軽' },
  '030000': { pref: '岩手県', area: '030010', areaName: '内陸' },
  '040000': { pref: '宮城県', area: '040010', areaName: '東部' },
  '050000': { pref: '秋田県', area: '050010', areaName: '沿岸' },
  '060000': { pref: '山形県', area: '060010', areaName: '村山' },
  '070000': { pref: '福島県', area: '070010', areaName: '中通り' },
  '080000': { pref: '茨城県', area: '080010', areaName: '北部' },
  '090000': { pref: '栃木県', area: '090010', areaName: '南部' },
  '100000': { pref: '群馬県', area: '100010', areaName: '南部' },
  '110000': { pref: '埼玉県', area: '110010', areaName: '南部' },
  '120000': { pref: '千葉県', area: '120010', areaName: '北西部' },
  '130000': { pref: '東京都', area: '130010', areaName: '東京地方' },
  '140000': { pref: '神奈川県', area: '140010', areaName: '東部' },
  '150000': { pref: '新潟県', area: '150010', areaName: '下越' },
  '160000': { pref: '富山県', area: '160010', areaName: '東部' },
  '170000': { pref: '石川県', area: '170010', areaName: '加賀' },
  '180000': { pref: '福井県', area: '180010', areaName: '嶺北' },
  '190000': { pref: '山梨県', area: '190010', areaName: '中・西部' },
  '200000': { pref: '長野県', area: '200010', areaName: '北部' },
  '210000': { pref: '岐阜県', area: '210010', areaName: '美濃地方' },
  '220000': { pref: '静岡県', area: '220010', areaName: '中部' },
  '230000': { pref: '愛知県', area: '230010', areaName: '西部' },
  '240000': { pref: '三重県', area: '240010', areaName: '北中部' },
  '250000': { pref: '滋賀県', area: '250010', areaName: '南部' },
  '260000': { pref: '京都府', area: '260010', areaName: '南部' },
  '270000': { pref: '大阪府', area: '270000', areaName: '大阪府' },
  '280000': { pref: '兵庫県', area: '280010', areaName: '南部' },
  '290000': { pref: '奈良県', area: '290010', areaName: '北部' },
  '300000': { pref: '和歌山県', area: '300010', areaName: '北部' },
  '310000': { pref: '鳥取県', area: '310010', areaName: '東部' },
  '320000': { pref: '島根県', area: '320010', areaName: '東部' },
  '330000': { pref: '岡山県', area: '330010', areaName: '南部' },
  '340000': { pref: '広島県', area: '340010', areaName: '南部' },
  '350000': { pref: '山口県', area: '350010', areaName: '西部' },
  '360000': { pref: '徳島県', area: '360010', areaName: '北部' },
  '370000': { pref: '香川県', area: '370000', areaName: '香川県' },
  '380000': { pref: '愛媛県', area: '380010', areaName: '中予' },
  '390000': { pref: '高知県', area: '390010', areaName: '中部' },
  '400000': { pref: '福岡県', area: '400010', areaName: '福岡地方' },
  '410000': { pref: '佐賀県', area: '410010', areaName: '南部' },
  '420000': { pref: '長崎県', area: '420010', areaName: '南部' },
  '430000': { pref: '熊本県', area: '430010', areaName: '熊本地方' },
  '440000': { pref: '大分県', area: '440010', areaName: '中部' },
  '450000': { pref: '宮崎県', area: '450010', areaName: '南部平野部' },
  '460100': { pref: '鹿児島県', area: '460010', areaName: '薩摩地方' },
  '471000': { pref: '沖縄県', area: '471010', areaName: '本島中南部' },
};

/** 設定値の予報区コードを正規化する（未知は既定の東京） */
function weatherAreaCode(code) {
  const c = String(code == null ? '' : code).trim();
  return WEATHER_AREAS[c] ? c : WEATHER_DEFAULT_AREA;
}

function weatherAreaInfo(code) {
  return WEATHER_AREAS[weatherAreaCode(code)];
}

const WEATHER_TTL_MS = 30 * 60 * 1000;
const weatherCache = new Map(); // officeCode -> { at, data }

/** Open-Meteo の weathercode → 日本語天気 + アイコン（旧版互換のため残す。現行は気象庁APIを使用） */
function describeWeather(code) {
  const n = Number(code);
  if (n === 0) return { text: '晴れ', icon: '☀' };
  if (n === 1) return { text: '晴れ', icon: '🌤' };
  if (n === 2) return { text: '曇り', icon: '⛅' };
  if (n === 3) return { text: '曇り', icon: '☁' };
  if (n === 45 || n === 48) return { text: '霧', icon: '🌫' };
  if (n === 51 || n === 53 || n === 55) return { text: '小雨', icon: '☂' };
  if (n === 56 || n === 57) return { text: '雨', icon: '☔' };
  if (n === 61 || n === 80) return { text: '雨', icon: '☔' };
  if (n === 63 || n === 81) return { text: '雨', icon: '☔' };
  if (n === 65 || n === 82) return { text: '大雨', icon: '☔' };
  if (n === 66 || n === 67) return { text: '雨', icon: '☔' };
  if (n === 71 || n === 77 || n === 85) return { text: '雪', icon: '☃' };
  if (n === 73 || n === 75 || n === 86) return { text: '大雪', icon: '☃' };
  if (n === 95 || n === 96 || n === 99) return { text: '雷雨', icon: '⛈' };
  return { text: '曇り', icon: '☁' };
}

/** 気象庁の天気コード・概況文 → 短い表示文 + アイコン（本文は気象庁の概況をそのまま使う） */
function describeJmaWeather(code, weathersText) {
  const wt = String(weathersText == null ? '' : weathersText);
  const c = String(code == null ? '' : code);
  if (/雷/.test(wt)) return { text: '雷雨', icon: '⛈' };
  const head = c.charAt(0);
  if (head === '1') return c === '100' ? { text: '晴れ', icon: '☀' } : { text: '晴れ', icon: '🌤' };
  if (head === '2') {
    if (/霧/.test(wt)) return { text: '霧', icon: '🌫' };
    return c === '200' ? { text: '曇り', icon: '☁' } : { text: '曇り', icon: '⛅' };
  }
  if (head === '3') {
    return /大雨|暴風/.test(wt) ? { text: '大雨', icon: '☔' } : { text: '雨', icon: '☔' };
  }
  if (head === '4') {
    return /大雪|暴風雪|風雪/.test(wt) ? { text: '大雪', icon: '☃' } : { text: '雪', icon: '☃' };
  }
  const short = wt.replace(/\u3000/g, '').slice(0, 6) || '曇り';
  return { text: short, icon: '☁' };
}

function jmaDateOf(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : null;
}

function jmaNum(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '--' || s === '‐') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** timeDefines と値配列から { 日付: [値...] } を作る */
function groupJmaByDate(timeDefines, values) {
  const map = new Map();
  (timeDefines || []).forEach((t, i) => {
    const d = jmaDateOf(t);
    if (!d) return;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(values ? values[i] : undefined);
  });
  return map;
}

/** エリア配列から対象区域を探す（無ければ先頭＝代表地点） */
function findJmaArea(areas, code) {
  if (!Array.isArray(areas) || areas.length === 0) return null;
  return areas.find((a) => a && a.area && a.area.code === code) || areas[0] || null;
}

/**
 * 気象庁の予報JSON（府県予報＋週間予報）から今日/明日/明後日の3日分を抜き出す。
 * - 天気: 府県予報の概況（3日分あり）
 * - 降水確率: 府県予報の時間帯別を日別最大に集約 → 無ければ週間予報
 * - 気温: 府県予報の気温（00時=最低・それ以外=最高）→ 無ければ週間予報の tempsMin/tempsMax
 */
function parseJmaForecast(json, areaCode) {
  const root = Array.isArray(json) ? json[0] : null;
  const ts = (root && root.timeSeries) || [];
  const weekly = (Array.isArray(json) && json[1] && json[1].timeSeries) || [];
  const reportDatetime = (root && root.reportDatetime) || null;
  const labels = ['今日', '明日', '明後日'];
  const base = ((ts[0] && ts[0].timeDefines) || []).slice(0, 3);
  const wArea = findJmaArea(ts[0] && ts[0].areas, areaCode);
  const pArea = findJmaArea(ts[1] && ts[1].areas, areaCode);
  const tArea = (ts[2] && ts[2].areas && ts[2].areas[0]) || null; // 気温は代表地点（先頭）
  const wPopArea = findJmaArea(weekly[0] && weekly[0].areas, areaCode);
  const wTempArea = (weekly[1] && weekly[1].areas && weekly[1].areas[0]) || null;
  const popByDate = groupJmaByDate(ts[1] && ts[1].timeDefines, pArea && pArea.pops);
  // 府県予報の気温を日別に振り分け
  const tempMinByDate = new Map();
  const tempMaxByDate = new Map();
  const tTd = (ts[2] && ts[2].timeDefines) || [];
  const tVals = (tArea && tArea.temps) || [];
  tTd.forEach((t, i) => {
    const d = jmaDateOf(t);
    const n = jmaNum(tVals[i]);
    if (!d || n == null) return;
    const hour = parseInt(String(t).slice(11, 13), 10);
    if (hour === 0) {
      if (!tempMinByDate.has(d)) tempMinByDate.set(d, n);
    } else if (!tempMaxByDate.has(d)) {
      tempMaxByDate.set(d, n);
    }
  });
  // 週間予報の日付→index
  const wPopDates = ((weekly[0] && weekly[0].timeDefines) || []).map(jmaDateOf);
  const wPops = (wPopArea && wPopArea.pops) || [];
  const wTempDates = ((weekly[1] && weekly[1].timeDefines) || []).map(jmaDateOf);
  const wMin = (wTempArea && wTempArea.tempsMin) || [];
  const wMax = (wTempArea && wTempArea.tempsMax) || [];
  const days = [0, 1, 2].map((i) => {
    const iso = base[i] || null;
    const date = jmaDateOf(iso);
    const code = wArea && wArea.weatherCodes ? wArea.weatherCodes[i] : null;
    const detailRaw = wArea && wArea.weathers ? wArea.weathers[i] : '';
    const w = describeJmaWeather(code, detailRaw);
    let precip = null;
    if (date && popByDate.has(date)) {
      let mx = null;
      for (const v of popByDate.get(date)) {
        const n = jmaNum(v);
        if (n != null && (mx == null || n > mx)) mx = n;
      }
      precip = mx;
    }
    if (precip == null && date) {
      const wi = wPopDates.indexOf(date);
      if (wi >= 0) precip = jmaNum(wPops[wi]);
    }
    let tmax = date && tempMaxByDate.has(date) ? tempMaxByDate.get(date) : null;
    let tmin = date && tempMinByDate.has(date) ? tempMinByDate.get(date) : null;
    if (date && (tmax == null || tmin == null)) {
      const wi = wTempDates.indexOf(date);
      if (wi >= 0) {
        if (tmax == null) tmax = jmaNum(wMax[wi]);
        if (tmin == null) tmin = jmaNum(wMin[wi]);
      }
    }
    return {
      label: labels[i],
      date,
      code: code != null ? String(code) : null,
      weather: w.text,
      icon: w.icon,
      detail: String(detailRaw == null ? '' : detailRaw).replace(/\u3000/g, ' '),
      precip,
      tmax,
      tmin,
    };
  });
  return { reportDatetime, days };
}

app.get('/api/weather', async (req, res) => {
  const office = weatherAreaCode(settings.weatherArea);
  const info = weatherAreaInfo(office);
  try {
    const hit = weatherCache.get(office);
    if (hit && Date.now() - hit.at < WEATHER_TTL_MS) {
      return res.json(hit.data);
    }
    const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${office}.json`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let apiJson = null;
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': BROWSER_UA } });
      if (!r.ok) throw new Error('weather HTTP ' + r.status);
      apiJson = await r.json();
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseJmaForecast(apiJson, info.area);
    const payload = {
      ok: true,
      pref: info.pref,
      area: info.areaName,
      officeCode: office,
      areaCode: info.area,
      reportDatetime: parsed.reportDatetime,
      updatedAt: new Date().toISOString(),
      days: parsed.days,
    };
    weatherCache.set(office, { at: Date.now(), data: payload });
    res.json(payload);
  } catch (e) {
    const hit = weatherCache.get(office);
    if (hit) return res.json(hit.data);
    res.status(502).json({ ok: false, error: '天気を取得できませんでした' });
  }
});

// ---- 設定 API ----
app.get('/api/settings', (req, res) => {
  res.json({ ok: true, settings, allowedRates: ALLOWED_RATES, version: VERSION });
});

function handleSettingsUpdate(req, res) {
  const next = normalizeSettings(req.body || {}, settings);
  const intervalChanged = next.fetchIntervalMinutes !== settings.fetchIntervalMinutes;
  settings = next;
  applyIntervalSettings();
  saveSettings();
  if (intervalChanged) scheduleFetch();
  res.json({ ok: true, settings, intervalMinutes: INTERVAL_MINUTES });
}
app.put('/api/settings', handleSettingsUpdate);
app.post('/api/settings', handleSettingsUpdate);

// ---- フィード エクスポート / インポート ----
app.get('/api/feeds/export', (req, res) => {
  res.json({
    ok: true,
    exportedAt: new Date().toISOString(),
    version: VERSION,
    feeds: FEEDS.map((f) => ({
      id: feedId(f.url),
      name: f.name,
      url: f.url,
      enabled: f.enabled !== false,
    })),
  });
});

function cleanFeedEntry(f) {
  if (!f || typeof f.url !== 'string' || !/^https?:\/\//.test(f.url.trim())) return null;
  return {
    name: ((f.name || f.url).toString().slice(0, 100)),
    url: f.url.trim(),
    enabled: f.enabled !== false,
  };
}

app.post('/api/feeds/import', (req, res) => {
  const body = req.body || {};
  const rawArr = Array.isArray(body) ? body : body.feeds;
  if (!Array.isArray(rawArr)) {
    return res.status(400).json({ ok: false, error: 'feeds 配列を指定してください' });
  }
  if (rawArr.length > 500) {
    return res.status(400).json({ ok: false, error: '一度に取り込めるのは500件までです' });
  }
  const mode = (body.mode || 'replace').toString();
  const cleaned = [];
  const seen = new Set();
  for (const f of rawArr) {
    const e = cleanFeedEntry(f);
    if (!e) continue;
    const k = normalizeFeedUrl(e.url);
    if (seen.has(k)) continue;
    seen.add(k);
    cleaned.push(e);
  }
  if (mode === 'merge') {
    let added = 0;
    for (const e of cleaned) {
      if (!FEEDS.some((f) => normalizeFeedUrl(f.url) === normalizeFeedUrl(e.url))) {
        FEEDS.push(e);
        added++;
      }
    }
    feedStates = FEEDS.map((f) => {
      const prev = feedStates.find((s) => s.url === f.url || s.id === feedId(f.url));
      return prev || freshFeedState(f);
    });
    saveFeeds();
    clearStore();
    fetchAllFeeds().catch((e) => console.error('fetch after import failed:', e));
    return res.json({ ok: true, imported: added, total: FEEDS.length, feeds: feedStates });
  }
  // 既定: replace（空配列は拒否して全消し事故を防ぐ）
  if (cleaned.length === 0) {
    return res.status(400).json({ ok: false, error: '有効なフィードがありません' });
  }
  FEEDS.length = 0;
  for (const e of cleaned) FEEDS.push(e);
  feedStates = FEEDS.map(freshFeedState);
  saveFeeds();
  clearStore();
  fetchAllFeeds().catch((e) => console.error('fetch after import failed:', e));
  res.json({ ok: true, imported: cleaned.length, total: FEEDS.length, feeds: feedStates });
});

// ---- 更新 / 再起動（制御系。DISABLE_CONTROL=1 で無効化） ----
function restartServiceDetached() {
  // 応答後に再起動するよう少し遅延させる（Restart=always のため復帰する）
  setTimeout(() => {
    exec('systemctl restart newsflow', (err) => {
      if (err) {
        console.error('systemctl restart failed, fallback to process exit:', String(err.message || err));
        // systemd が無い環境ではプロセス終了→親の再起動に委ねる
        setTimeout(() => process.exit(0), 500);
      }
    });
  }, 500);
}

app.post('/api/restart', (req, res) => {
  if (!controlEnabled()) {
    return res.status(403).json({ ok: false, error: '制御APIは無効化されています (DISABLE_CONTROL=1)' });
  }
  res.json({ ok: true, message: 'サービスを再起動します' });
  restartServiceDetached();
});

app.post('/api/update', (req, res) => {
  if (!controlEnabled()) {
    return res.status(403).json({ ok: false, error: '制御APIは無効化されています (DISABLE_CONTROL=1)' });
  }
  res.json({ ok: true, message: 'GitHub から更新を取得し、依存更新後に再起動します' });
  // 背景で git pull → npm install → restart（再起動時に自動再取得される）
  const cmd = 'git pull --ff-only && npm install --no-audit --no-fund && systemctl restart newsflow';
  exec(cmd, { cwd: __dirname, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('update failed:', String((err && err.message) || err), stdout, stderr);
      return;
    }
    console.log('update done:', stdout);
  });
});

// ---- RSS フィード管理 API ----
app.get('/api/feeds', (req, res) => {
  // 指示書 §手順4 の { ok:true, feeds:[{ id,name,url,enabled,ok,items,error }] } 形式。
  // 旧キー updatedAt は互換のため維持。
  res.json({ ok: true, feeds: feedStates, updatedAt: lastUpdatedAt });
});

/** URL の重複判定用正規化（trim・末尾スラッシュ・大文字小文字の揺れを吸収） */
function normalizeFeedUrl(url) {
  return (url || '').trim().replace(/\/+$/, '').toLowerCase();
}

app.post('/api/feeds', (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  const url = (req.body && req.body.url ? String(req.body.url) : '').trim();
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ ok: false, error: 'url は http(s) 形式で指定してください' });
  }
  const normUrl = normalizeFeedUrl(url);
  if (FEEDS.some((f) => normalizeFeedUrl(f.url) === normUrl)) {
    return res.status(409).json({ ok: false, error: 'その URL は既に登録されています' });
  }
  const entry = { name: (name || url).slice(0, 100), url, enabled: true };
  FEEDS.push(entry);
  feedStates.push(freshFeedState(entry));
  saveFeeds();
  // 背景で即時取得（応答は待たない）
  fetchAllFeeds().catch((e) => console.error('fetch after add failed:', e));
  // 旧キー feeds は維持しつつ、指示書どおり feed（追加分）も返す
  res.status(201).json({ ok: true, feed: freshFeedState(entry), feeds: feedStates });
});

app.delete('/api/feeds/:index', (req, res) => {
  // 後方互換: 数値なら index、そうでなければ id（URL の SHA-1 先頭12桁）として解決
  const idx = resolveFeedIndex(String(req.params.index || ''));
  if (!Number.isInteger(idx) || idx < 0 || idx >= FEEDS.length) {
    return res.status(404).json({ ok: false, error: '指定のフィードが見つかりません' });
  }
  const removed = FEEDS.splice(idx, 1)[0];
  const removedId = feedId(removed.url);
  feedStates = feedStates.filter((s) => s.url !== removed.url && s.id !== removedId);
  saveFeeds();
  // 削除したフィード由来の記事が残らないよう store をクリアして再取得する
  clearStore();
  fetchAllFeeds().catch((e) => console.error('fetch after delete failed:', e));
  res.json({ ok: true, removed, feeds: feedStates });
});

// ---- 記事本文オンデマンド API（フロントのフォールバック用） ----
app.get('/api/article', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ ok: false, error: 'url パラメータが必要です' });
  }
  // store に本文があればそれを返す
  for (const [, list] of store) {
    const hit = list.find((e) => e.link === url && e.body);
    if (hit) {
      const image = hit.image || imageCache.get(url) || '';
      return res.json({ ok: true, url, body: hit.body, summary: hit.summary || summarizeText(hit.body), image, cached: true });
    }
  }
  const { body, image } = await fetchArticlePage(url);
  if (!body && !image) return res.status(502).json({ ok: false, error: '本文を取得できませんでした' });
  // store 側にも反映して永続化
  for (const [, list] of store) {
    for (const e of list) {
      if (e.link === url) {
        if (body) {
          e.body = body;
          e.summary = summarizeText(body);
        }
        if (image) e.image = image;
      }
    }
  }
  saveStore();
  res.json({ ok: true, url, body, summary: summarizeText(body), image: image || '', cached: false });
});

// ---- 個別フィードの再取得（管理画面の「再取得」ボタン用） ----
/** 数値 index またはフィード id（URL の SHA-1 先頭12桁）から FEEDS の添字を解決する */
function resolveFeedIndex(raw) {
  if (/^\d+$/.test(raw || '')) return Number.parseInt(raw, 10);
  return FEEDS.findIndex((f) => feedId(f.url) === raw);
}

app.post('/api/feeds/:id/refresh', async (req, res) => {
  const idx = resolveFeedIndex(String(req.params.id || ''));
  if (!Number.isInteger(idx) || idx < 0 || idx >= FEEDS.length) {
    return res.status(404).json({ ok: false, error: '指定のフィードが見つかりません' });
  }
  const feed = FEEDS[idx];
  if (feed.enabled === false) {
    return res.status(400).json({ ok: false, error: '無効なフィードです' });
  }
  try {
    const parsed = await parser.parseURL(feed.url);
    const items = (parsed && parsed.items) || [];
    const fetchedAt = new Date().toISOString();
    const added = ingestFeedItems(feed, items, fetchedAt);
    feedStates[idx] = {
      id: feedId(feed.url),
      name: feed.name,
      url: feed.url,
      enabled: true,
      ok: true,
      items: items.length,
      error: null,
    };
    lastUpdatedAt = fetchedAt;
    saveStore();
    console.log(`[個別取得] ${feed.name}: ${items.length}件（新規${added}件）`);
    // 本文・写真の追いかけ取得は背景で行う（応答は待たない）
    fillMissingBodies(
      [...store.values()].flat().sort((a, b) => (b.fetchedAt || '').localeCompare(a.fetchedAt || '')),
      { limit: 30 }
    ).then(() => saveStore()).catch((e) => console.error('body fill after single refresh failed:', e));
    res.json({ ok: true, feed: feedStates[idx], added, lastFetchAt: fetchedAt });
  } catch (e) {
    const msg = String((e && e.message) || e);
    feedStates[idx] = {
      id: feedId(feed.url),
      name: feed.name,
      url: feed.url,
      enabled: true,
      ok: false,
      items: 0,
      error: msg,
    };
    saveStore();
    console.warn(`[個別取得失敗] ${feed.name}: ${msg}`);
    res.status(502).json({ ok: false, error: msg });
  }
});

// 手動再取得（管理画面用。指示書準拠の /api/feeds/refresh が正規。/api/refresh は後方互換の別名）
function handleRefresh(req, res) {
  fetchAllFeeds().catch((e) => console.error('manual refresh failed:', e));
  res.json({ ok: true, message: '再取得を開始しました', lastFetchAt: lastUpdatedAt, sources: feedStates });
}
app.post('/api/feeds/refresh', handleRefresh);
app.post('/api/refresh', handleRefresh);

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

async function main() {
  loadFeeds();
  loadSettings();
  applyIntervalSettings();
  loadStore();
  // 起動直後に1回取得（失敗してもサーバーは起動する）
  await fetchAllFeeds().catch((e) => console.error('initial fetch failed:', e));
  scheduleFetch();

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[起動] http://127.0.0.1:${PORT} で待受中`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  app,
  VERSION,
  DEFAULT_SETTINGS,
  ALLOWED_RATES,
  getDefaultSettings,
  normalizeSettings,
  snapRate,
  isValidRate,
  isWithinHours,
  filterByAge,
  loadSettings,
  saveSettings,
  applyIntervalSettings,
  controlEnabled,
  get settings() { return settings; },
  detectPrefectures,
  PREFECTURES,
  PREF_KEYWORDS,
  TOPIC_FEEDS,
  TOPIC_CATEGORIES,
  topicCategoryForFeed,
  FEEDS,
  store,
  buildPrefectures,
  buildPlaylist,
  buildGroups,
  dedupeByGroup,
  totalNewsCount,
  assignGroups,
  interleaveAvoidSameGroup,
  summarizeText,
  bodyExcerpt,
  stripSpeakBrackets,
  buildSpeakText,
  titleSimilarity,
  areSimilarTitles,
  titleTokens,
  isDateNumericToken,
  contentTokens,
  decodeEntities,
  extractMetaContent,
  extractArticleDescription,
  fetchArticleBody,
  fetchArticlePage,
  extractFeedImage,
  extractOgImage,
  ingestFeedItems,
  resolveFeedIndex,
  feedId,
  articleId,
  loadFeeds,
  saveFeeds,
  describeWeather,
  describeJmaWeather,
  parseJmaForecast,
  weatherAreaCode,
  weatherAreaInfo,
  WEATHER_AREAS,
  WEATHER_DEFAULT_AREA,
  // 指示書 §3.4 の関数名との両対応エイリアス（実装名が正規。テストはどちらでも参照可）
  similarity: titleSimilarity,
  clusterItems: assignGroups,
  extractMeta: extractArticleDescription,
};
