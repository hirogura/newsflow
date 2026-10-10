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
const { execFile, exec, spawn } = require('child_process');
const Parser = require('rss-parser');

const PORT = process.env.PORT || 3364;
// アプリバージョン（画面表記は「v.」+ この値）
const VERSION = '3.1.4';
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
  ttsEngine: 'browser', // 読み上げエンジン（'browser' / 'voicevox'）
  voicevoxSpeaker: 3, // VOICEVOX 話者ID（既定: ずんだもん ノーマル=3。2=四国めたん / 52=雀松朱司 / 8=春日部つむぎ / 13=青山龍星 / 20=もち子さん / 29=No.7）
  voicevoxRotate: false, // true のとき1記事ごとに VOICEVOX_SPEAKERS の順で話者を切り替える（v2.9.0「順番」）
  theme: 'dark', // 画面テーマ（'dark' / 'light' / 'light-modern'）
  weatherArea: '130000', // 天気の地域（気象庁の予報区コード。既定は東京）
  freebuffFormat: false, // freebuff整形（ローカル整形関数。外部CLI/API呼び出しなし。v3.0.0）
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
  if (src.ttsEngine !== undefined) {
    const t = String(src.ttsEngine).trim().toLowerCase();
    // 'voicevox' / 'zundamon' / 'zunda' は VOICEVOX 扱い、それ以外は browser に寄せる
    s.ttsEngine = (t === 'voicevox' || t === 'zundamon' || t === 'zunda') ? 'voicevox' : 'browser';
  }
  if (src.voicevoxSpeaker !== undefined) {
    const n = parseInt(src.voicevoxSpeaker, 10);
    s.voicevoxSpeaker = Number.isFinite(n) && n >= 0 && n <= 100 ? n : b.voicevoxSpeaker;
  }
  if (src.voicevoxRotate !== undefined) {
    const v = src.voicevoxRotate;
    s.voicevoxRotate = !(v === false || v === 0 || v === 'false' || v === '0' || v === 'off');
  }
  if (src.freebuffFormat !== undefined) {
    const v = src.freebuffFormat;
    s.freebuffFormat = !(v === false || v === 0 || v === 'false' || v === '0' || v === 'off');
  }
  if (src.theme !== undefined) {
    const t = String(src.theme).toLowerCase();
    s.theme = t === 'light' ? 'light' : t === 'light-modern' ? 'light-modern' : t === 'dark' ? 'dark' : b.theme;
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

// ---------- VOICEVOX（読み上げ, v2.6.0） ----------
// Node サーバーが VOICEVOX ENGINE へプロキシする（CORS・公開ポート回避のため
// ブラウザから直接 127.0.0.1:50021 を叩かない。フロントは POST /api/tts のみ使う）。
// 環境変数: VOICEVOX_PORT（既定 50021）/ VOICEVOX_HOST（既定 127.0.0.1）/
//           VOICEVOX_DIR（既定 <repo>/voicevox）/ VOICEVOX_VERSION（固定したい場合）
const VOICEVOX_PORT = parseInt(process.env.VOICEVOX_PORT || '50021', 10) || 50021;
const VOICEVOX_HOST = process.env.VOICEVOX_HOST || '127.0.0.1';
const VOICEVOX_DIR = process.env.VOICEVOX_DIR || path.join(__dirname, 'voicevox');
const VOICEVOX_ENGINE_VERSION_FALLBACK = process.env.VOICEVOX_VERSION || '0.25.2';
// 既定話者: ずんだもん（ノーマル, speaker id = 3）
// 選択肢（管理画面のボタンと対応）:
// - ずんだもん（ノーマル）= 3 / - 四国めたん（ノーマル）= 2 / - 雀松朱司（ノーマル）= 52
// - 春日部つむぎ（ノーマル）= 8 / - 青山龍星（ノーマル）= 13
// - もち子さん（ノーマル）= 20 / - No.7（ノーマル）= 29
const VOICEVOX_SPEAKER_DEFAULT = 3;
const VOICEVOX_SPEAKERS = [
  { id: 3, name: 'ずんだもん' },
  { id: 2, name: '四国めたん' },
  { id: 52, name: '雀松朱司' },
  { id: 8, name: '春日部つむぎ' },
  { id: 13, name: '青山龍星' },
  { id: 20, name: 'もち子さん' },
  { id: 29, name: 'No.7' },
];
const VOICEVOX_SPEAKER_IDS = VOICEVOX_SPEAKERS.map((s) => s.id);
/** 話者IDから表示名を返す（未知IDは `ID <n>` 表記。メッセージ表示用） */
function voicevoxSpeakerName(speaker) {
  const n = Number(speaker);
  const hit = VOICEVOX_SPEAKERS.find((s) => s.id === n);
  if (hit) return hit.name;
  return Number.isFinite(n) ? `ID ${n}` : 'ずんだもん';
}
/**
 * 順番モード（v2.9.0）で再生順 pos に対応する話者IDを返す（純粋関数）。
 * VOICEVOX_SPEAKERS の並びを1記事ごとに巡回する。負数・巨大数でも破綻しない。
 */
function voicevoxSpeakerForIndex(pos) {
  const len = VOICEVOX_SPEAKERS.length;
  if (len === 0) return VOICEVOX_SPEAKER_DEFAULT;
  const i = Number.isFinite(Number(pos)) ? Math.trunc(Number(pos)) : 0;
  return VOICEVOX_SPEAKERS[((i % len) + len) % len].id;
}
/** 現在の読み上げ表示名（順番モード中は「順番に切替」。メッセージ表示用） */
function voicevoxCurrentLabel() {
  if (settings && settings.voicevoxRotate) return '順番に切替';
  return voicevoxSpeakerName(settings ? settings.voicevoxSpeaker : VOICEVOX_SPEAKER_DEFAULT);
}
const VOICEVOX_RUN_ARGS = ['--host', VOICEVOX_HOST, '--port', String(VOICEVOX_PORT)];

function voicevoxRunPath() {
  return path.join(VOICEVOX_DIR, 'linux-cpu-x64', 'run');
}

/** VOICEVOX ENGINE の展開済みバイナリがあるか */
function isVoicevoxInstalled() {
  try {
    return fs.existsSync(voicevoxRunPath());
  } catch (_) {
    return false;
  }
}

function voicevoxBaseUrl() {
  return `http://${VOICEVOX_HOST}:${VOICEVOX_PORT}`;
}

const voicevoxStatus = {
  phase: 'idle', // idle | downloading | extracting | starting | ready | error
  message: '未インストール',
  progress: null, // 0..100（ダウンロード時のみ）
  error: null,
  engineVersion: null,
  installed: false,
  running: false,
  speaker: VOICEVOX_SPEAKER_DEFAULT,
  rotate: false, // 順番モード（v2.9.0。settings.voicevoxRotate と連動）
};
let voicevoxProc = null;
let voicevoxInstalling = false;

function setVoicevoxStatus(patch) {
  Object.assign(voicevoxStatus, patch);
  voicevoxStatus.installed = isVoicevoxInstalled();
  if (voicevoxStatus.installed && voicevoxStatus.phase === 'idle') {
    voicevoxStatus.message = 'インストール済み（停止中）';
  }
  return voicevoxStatus;
}

/** ENGINE が応答するか（短時間タイムアウトで確認） */
async function isVoicevoxRunning(timeoutMs) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : 3000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${voicevoxBaseUrl()}/version`, { signal: ctl.signal });
    if (!r.ok) return false;
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** ENGINE の起動を待つ（/version が 200 を返すまでポーリング） */
async function waitForVoicevoxReady(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 120000);
  for (;;) {
    if (await isVoicevoxRunning(3000)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function ensure7z() {
  return new Promise((resolve, reject) => {
    exec('command -v 7z >/dev/null 2>&1 || 7z i >/dev/null 2>&1', (err) => {
      if (!err) return resolve();
      // 未導入環境向けフォールバック（提供パッケージ名は 7zip）
      exec('apt-get update && apt-get install -y 7zip', { timeout: 5 * 60 * 1000 }, (e2) => {
        if (e2) return reject(new Error('7z が無く自動導入にも失敗しました'));
        resolve();
      });
    });
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const r = await fetch(url);
      if (!r.ok || !r.body) {
        return reject(new Error(`ダウンロードに失敗しました (HTTP ${r.status})`));
      }
      const total = Number(r.headers.get('content-length')) || 0;
      let done = 0;
      const ws = fs.createWriteStream(destPath);
      const reader = r.body.getReader();
      const pump = async () => {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          done += value.length;
          if (!ws.write(Buffer.from(value))) {
            await new Promise((res) => ws.once('drain', res));
          }
          if (total > 0 && onProgress) {
            try { onProgress(Math.min(100, Math.round((done / total) * 100))); } catch (_) {}
          }
        }
        ws.end(() => resolve({ done, total }));
      };
      ws.on('error', reject);
      await pump();
    } catch (e) {
      reject(e);
    }
  });
}

function extractArchive(archivePath) {
  return new Promise((resolve, reject) => {
    execFile('7z', ['x', archivePath, `-o${VOICEVOX_DIR}`, '-y'], { timeout: 20 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`展開に失敗しました: ${String((err && err.message) || err)} ${String(stderr || '').slice(0, 500)}`));
      resolve(stdout);
    });
  });
}

function resolveVoicevoxAsset(releaseJson) {
  const tag = String((releaseJson && releaseJson.tag_name) || '').trim();
  const ver = tag.replace(/^v/, '') || VOICEVOX_ENGINE_VERSION_FALLBACK;
  const assets = (releaseJson && releaseJson.assets) || [];
  const hit = assets.find((a) => /linux-cpu-x64.*7z\.001$/.test(String((a && a.name) || '')));
  if (hit && hit.browser_download_url) {
    return { version: ver, url: hit.browser_download_url, name: hit.name };
  }
  // フォールバック: 命名規則から直接 URL を組み立てる
  const name = `voicevox_engine-linux-cpu-x64-${ver}.7z.001`;
  return {
    version: ver,
    url: `https://github.com/VOICEVOX/voicevox_engine/releases/download/${ver}/${name}`,
    name,
  };
}

/** VOICEVOX ENGINE プロセスを起動する（既起動なら何もしない） */
async function startVoicevox() {
  if (voicevoxProc && voicevoxProc.exitCode == null) {
    if (await isVoicevoxRunning(3000)) {
      setVoicevoxStatus({ phase: 'ready', message: '起動済み', error: null, running: true });
      return voicevoxStatus;
    }
    try { voicevoxProc.kill(); } catch (_) {}
    voicevoxProc = null;
  }
  if (!isVoicevoxInstalled()) {
    throw new Error('VOICEVOX がインストールされていません（先にインストールしてください）');
  }
  setVoicevoxStatus({ phase: 'starting', message: 'VOICEVOX を起動しています…', error: null });
  const runPath = voicevoxRunPath();
  try {
    fs.chmodSync(runPath, 0o755);
  } catch (_) {}
  voicevoxProc = spawn(runPath, VOICEVOX_RUN_ARGS, {
    cwd: path.dirname(runPath),
    stdio: 'ignore',
    detached: true,
  });
  if (voicevoxProc && voicevoxProc.unref) voicevoxProc.unref();
  if (voicevoxProc) {
    voicevoxProc.on('exit', () => {
      if (voicevoxProc && voicevoxProc.exitCode != null) voicevoxProc = null;
      if (voicevoxStatus.phase === 'ready') {
        setVoicevoxStatus({ phase: 'idle', message: '停止しました', running: false });
      }
    });
  }
  const ok = await waitForVoicevoxReady(120000);
  if (!ok) {
    setVoicevoxStatus({ phase: 'error', message: '起動に失敗しました', error: 'ENGINE の起動確認がタイムアウトしました', running: false });
    throw new Error('ENGINE の起動確認がタイムアウトしました');
  }
  // バージョン取得（表示用。失敗しても起動は継続）
  let engineVersion = null;
  try {
    const r = await fetch(`${voicevoxBaseUrl()}/version`);
    if (r.ok) engineVersion = (await r.json().catch(() => null)) ?? null;
    if (typeof engineVersion !== 'string') engineVersion = String(engineVersion ?? '');
  } catch (_) {}
  setVoicevoxStatus({ phase: 'ready', message: `VOICEVOX で読み上げ中（${voicevoxCurrentLabel()}）`, error: null, running: true, engineVersion });
  return voicevoxStatus;
}

/** VOICEVOX ENGINE プロセスを停止する */
function stopVoicevox() {
  if (voicevoxProc && voicevoxProc.exitCode == null) {
    try { voicevoxProc.kill('SIGTERM'); } catch (_) {}
  }
  voicevoxProc = null;
  setVoicevoxStatus({ phase: 'idle', message: isVoicevoxInstalled() ? 'インストール済み（停止中）' : '未インストール', running: false, progress: null });
  return voicevoxStatus;
}

/** ダウンロード→展開→起動→設定切替までを背景実行する（二重起動防止付き） */
async function installVoicevoxBackground() {
  if (voicevoxInstalling) return voicevoxStatus;
  voicevoxInstalling = true;
  try {
    // 既に展開済みなら起動だけ行う
    if (isVoicevoxInstalled()) {
      await startVoicevox();
      settings = normalizeSettings({ ttsEngine: 'voicevox' }, settings);
      saveSettings();
      return voicevoxStatus;
    }
    setVoicevoxStatus({ phase: 'downloading', message: 'VOICEVOX をダウンロードしています…（約1.8GB）', progress: 0, error: null });
    let release = null;
    try {
      const r = await fetch('https://api.github.com/repos/VOICEVOX/voicevox_engine/releases/latest', {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/vnd.github+json' },
      });
      if (r.ok) release = await r.json();
    } catch (_) {}
    const asset = resolveVoicevoxAsset(release);
    const dest = path.join(VOICEVOX_DIR, asset.name);
    await downloadFile(asset.url, dest, (p) => {
      setVoicevoxStatus({ progress: p, message: `VOICEVOX をダウンロードしています… ${p}%` });
    });
    setVoicevoxStatus({ phase: 'extracting', message: 'VOICEVOX を展開しています…（数分かかります）', progress: null });
    await ensure7z();
    await extractArchive(dest);
    try { fs.unlinkSync(dest); } catch (_) {}
    if (!isVoicevoxInstalled()) {
      throw new Error('展開後に実行ファイルが見つかりませんでした');
    }
    await startVoicevox();
    // 完了したら自動で VOICEVOX 読み上げに切り替える
    settings = normalizeSettings({ ttsEngine: 'voicevox' }, settings);
    saveSettings();
    return voicevoxStatus;
  } catch (e) {
    const msg = String((e && e.message) || e);
    setVoicevoxStatus({ phase: 'error', message: 'インストールに失敗しました', error: msg, running: false });
    throw e;
  } finally {
    voicevoxInstalling = false;
  }
}

/** テキストを VOICEVOX で合成して WAV Buffer を返す（プロキシ用） */
async function synthesizeVoicevox(text, speaker) {
  const spk = Number.isFinite(Number(speaker)) ? Number(speaker) : (settings.voicevoxSpeaker || VOICEVOX_SPEAKER_DEFAULT);
  const q = new URLSearchParams({ text: String(text), speaker: String(spk) });
  const aq = await fetch(`${voicevoxBaseUrl()}/audio_query?${q.toString()}`, { method: 'POST' });
  if (!aq.ok) throw new Error(`audio_query HTTP ${aq.status}`);
  const queryJson = await aq.json();
  // 読み上げ速度を設定値に寄せる（VOICEVOX の speedScale は概ね 0.5〜2.0）
  queryJson.speedScale = Math.max(0.5, Math.min(2.0, Number(settings.ttsRate) || 1.0));
  const syn = await fetch(`${voicevoxBaseUrl()}/synthesis?speaker=${encodeURIComponent(String(spk))}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(queryJson),
  });
  if (!syn.ok) throw new Error(`synthesis HTTP ${syn.status}`);
  return Buffer.from(await syn.arrayBuffer());
}

// ---------- 緊急地震速報 (EEW / Wolfx Open API WebSocket) ----------
// サーバーが Wolfx の WebSocket を購読し、ブラウザへは SSE で push する。
// 環境変数: EEW_ENABLED（既定で有効。0/false/off/no で無効）/ EEW_WS_URL（既定 jma_eew）
const EEW_WS_URL = process.env.EEW_WS_URL || 'wss://ws-api.wolfx.jp/jma_eew';
const EEW_RECONNECT_MIN_MS = 5000;
const EEW_RECONNECT_MAX_MS = 60000;
const EEW_PING_INTERVAL_MS = 50 * 1000;

function eewEnabled() {
  const raw = process.env.EEW_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

let latestEew = null;
let eewConnected = false;
let eewLastHeartbeatAt = null;
let eewLastEewAt = null;
let eewWs = null;
let eewReconnectTimer = null;
let eewPingTimer = null;
let eewBackoffMs = EEW_RECONNECT_MIN_MS;
const eewSseClients = new Set();

const EEW_DISPLAY_MS = 60 * 1000; // 画面表示（自動で消すまでの時間）
/** 直近の EEW が表示対象（受信から1分以内）かどうか */
function eewActive() {
  return !!(latestEew && latestEew.receivedAt &&
    Date.now() - Date.parse(latestEew.receivedAt) < EEW_DISPLAY_MS);
}

/**
 * Wolfx の EEW 生 JSON を画面配信用に正規化する（純粋関数）。
 * heartbeat・EEW 以外は null を返す。
 * heartbeat 以外の判定は EventID / Hypocenter / Title の有無で行う
 * （実データに type フィールドが無いことがあるため）。
 * Magunitude は公式の綴り（Magnitude ではなく Magunitude）。両方受け付ける。
 */
function normalizeEew(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.type === 'heartbeat') return null;
  const hasEewKey = raw.EventID != null || raw.Hypocenter != null || raw.Title != null;
  if (!hasEewKey) return null;
  const issue = raw.Issue && typeof raw.Issue === 'object' ? raw.Issue : {};
  const magRaw = raw.Magunitude != null ? raw.Magunitude : raw.Magnitude;
  const warnAreas = Array.isArray(raw.WarnArea)
    ? raw.WarnArea.filter((w) => w && typeof w === 'object').map((w) => ({
        chiiki: w.Chiiki != null ? String(w.Chiiki) : '',
        shindo1: w.Shindo1 != null ? String(w.Shindo1) : '',
        shindo2: w.Shindo2 != null ? String(w.Shindo2) : '',
        time: w.Time != null ? String(w.Time) : '',
        type: w.Type != null ? String(w.Type) : '',
        arrive: w.Arrive != null ? String(w.Arrive) : '',
      }))
    : [];
  return {
    type: 'eew',
    title: raw.Title != null ? String(raw.Title) : '',
    codeType: raw.CodeType != null ? String(raw.CodeType) : '',
    source: issue.Source != null ? String(issue.Source) : '',
    status: issue.Status != null ? String(issue.Status) : '',
    eventId: raw.EventID != null ? String(raw.EventID) : '',
    serial: raw.Serial != null ? String(raw.Serial) : '',
    announcedTime: raw.AnnouncedTime != null ? String(raw.AnnouncedTime) : '',
    originTime: raw.OriginTime != null ? String(raw.OriginTime) : '',
    hypocenter: raw.Hypocenter != null ? String(raw.Hypocenter) : '',
    latitude: raw.Latitude != null ? String(raw.Latitude) : '',
    longitude: raw.Longitude != null ? String(raw.Longitude) : '',
    magnitude: magRaw != null ? String(magRaw) : '',
    depth: raw.Depth != null ? String(raw.Depth) : '',
    maxIntensity: raw.MaxIntensity != null ? String(raw.MaxIntensity) : '',
    warnAreas,
    isSea: !!raw.isSea,
    isTraining: !!raw.isTraining,
    isAssumption: !!raw.isAssumption,
    isWarn: !!raw.isWarn,
    isFinal: !!raw.isFinal,
    isCancel: !!raw.isCancel,
    originalText: raw.OriginalText != null ? String(raw.OriginalText) : '',
    receivedAt: new Date().toISOString(),
  };
}

/** 正規化済み EEW を SSE 購読者全員へ配信する */
function broadcastEew(eew) {
  if (!eew) return;
  const payload = `event: eew\ndata: ${JSON.stringify(eew)}\n\n`;
  for (const res of [...eewSseClients]) {
    try {
      res.write(payload);
    } catch (e) {
      try { eewSseClients.delete(res); } catch (_) {}
    }
  }
}

/** Wolfx からの1メッセージを処理する（heartbeat 応答 / EEW 配信） */
function handleEewMessage(data) {
  let msg = null;
  if (typeof data === 'string') {
    const t = data.trim();
    if (t === '' || t === 'pong') return;
    try {
      msg = JSON.parse(t);
    } catch {
      return;
    }
  } else if (data && typeof data === 'object') {
    msg = data;
  } else {
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'heartbeat') {
    eewLastHeartbeatAt = new Date().toISOString();
    try {
      if (eewWs && eewWs.readyState === 1) {
        eewWs.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
    } catch (_) {}
    return;
  }
  const eew = normalizeEew(msg);
  if (!eew) return;
  latestEew = eew;
  eewLastEewAt = eew.receivedAt;
  console.log(`[EEW] 受信: ${eew.title} ${eew.hypocenter} M${eew.magnitude} ${eew.maxIntensity}`);
  broadcastEew(eew);
}

function clearEewTimers() {
  if (eewPingTimer) { clearInterval(eewPingTimer); eewPingTimer = null; }
  if (eewReconnectTimer) { clearTimeout(eewReconnectTimer); eewReconnectTimer = null; }
}

function scheduleEewReconnect() {
  if (!eewEnabled()) return;
  if (eewReconnectTimer) return;
  const wait = Math.min(eewBackoffMs, EEW_RECONNECT_MAX_MS);
  eewBackoffMs = Math.min(eewBackoffMs * 2, EEW_RECONNECT_MAX_MS);
  console.warn(`[EEW] ${Math.round(wait / 1000)}秒後に再接続します (${EEW_WS_URL})`);
  eewReconnectTimer = setTimeout(() => {
    eewReconnectTimer = null;
    connectEew();
  }, wait);
  if (eewReconnectTimer.unref) eewReconnectTimer.unref();
}

/** Wolfx WebSocket へ接続する（切断時は指数バックオフで再接続） */
function connectEew() {
  if (!eewEnabled()) return;
  if (typeof WebSocket === 'undefined') {
    console.warn('[EEW] グローバル WebSocket が無いため EEW 監視を開始できません');
    return;
  }
  if (eewWs) {
    try { eewWs.close(); } catch (_) {}
    eewWs = null;
  }
  let ws;
  try {
    ws = new WebSocket(EEW_WS_URL);
  } catch (e) {
    console.warn('[EEW] 接続に失敗しました:', String((e && e.message) || e));
    scheduleEewReconnect();
    return;
  }
  eewWs = ws;
  ws.onopen = () => {
    eewConnected = true;
    eewBackoffMs = EEW_RECONNECT_MIN_MS;
    console.log(`[EEW] 接続しました (${EEW_WS_URL})`);
    if (eewPingTimer) clearInterval(eewPingTimer);
    eewPingTimer = setInterval(() => {
      try {
        if (ws.readyState === 1) ws.send('ping');
      } catch (_) {}
      // heartbeat が3分以上途絶えたら張り直す
      if (eewLastHeartbeatAt) {
        const gap = Date.now() - Date.parse(eewLastHeartbeatAt);
        if (Number.isFinite(gap) && gap > 3 * 60 * 1000) {
          try { ws.close(); } catch (_) {}
        }
      }
    }, EEW_PING_INTERVAL_MS);
    if (eewPingTimer.unref) eewPingTimer.unref();
  };
  ws.onmessage = (ev) => {
    try {
      handleEewMessage(ev && ev.data);
    } catch (e) {
      console.warn('[EEW] メッセージ処理に失敗:', String((e && e.message) || e));
    }
  };
  ws.onerror = (e) => {
    console.warn('[EEW] エラー:', String((e && e.message) || e));
  };
  ws.onclose = () => {
    if (eewWs === ws) eewWs = null;
    eewConnected = false;
    if (eewPingTimer) { clearInterval(eewPingTimer); eewPingTimer = null; }
    console.warn('[EEW] 切断しました');
    scheduleEewReconnect();
  };
}

/** EEW 監視を開始する（無効時は開始しない。main() から呼ぶ） */
function startEewWatcher() {
  if (!eewEnabled()) {
    console.log('[EEW] 無効化されています (EEW_ENABLED=0)');
    return;
  }
  eewBackoffMs = EEW_RECONNECT_MIN_MS;
  connectEew();
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

// フィード種別: 'rss'（既定・RSS/Atom/RDF）/ 'site'（RSS非配信サイトのトップページ等）
// 旧データ（kind 無し）は 'rss' 扱いにする（後方互換）
function feedKind(feed) {
  return feed && feed.kind === 'site' ? 'site' : 'rss';
}

/** フィード種別を正規化する（'site' 以外はすべて 'rss'） */
function normalizeFeedKind(v) {
  return v === 'site' ? 'site' : 'rss';
}

// フィード状態（/api/news の sources[]・/api/feeds の feeds[] として返却）
function freshFeedState(f) {
  return {
    id: feedId(f.url),
    name: f.name,
    url: f.url,
    kind: feedKind(f),
    enabled: f.enabled !== false,
    ok: false,
    items: 0,
    error: null,
  };
}

let feedStates = FEEDS.map(freshFeedState);

/** source 名（フィード名）からフィード ID を逆引きする（旧データの移行用。無ければ null） */
function feedIdByName(name) {
  if (!name) return null;
  const hit = FEEDS.find((f) => f.name === name);
  return hit ? feedId(hit.url) : null;
}

/** 表示対象（チェック入り）のフィード ID 集合 */
function enabledFeedIds() {
  return new Set(
    FEEDS.filter((f) => f.enabled !== false).map((f) => feedId(f.url))
  );
}

/**
 * 記事が表示対象か。feedId 不明の旧データは表示する（fail-open）。
 * チェックを外したフィードの記事は store に残るが表示だけ除外される
 *（再チェックで即復活する。削除とは異なり store クリアはしない）。
 */
function isFeedEnabledFor(entry, enabledIds) {
  if (!entry || !entry.feedId) return true;
  const set = enabledIds || enabledFeedIds();
  return set.has(entry.feedId);
}

let lastUpdatedAt = null;
let lastFetchResult = { ok: 0, ng: 0, items: 0, errors: [] };

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': BROWSER_UA },
  // 写真抽出用: media:content / media:thumbnail を配列のまま保持する
  // 全文取得用: content:encoded を保持する（v2.2.0・selfrss 参考）
  customFields: {
    feed: [],
    item: [
      ['media:content', 'media:content', { keepArray: true }],
      ['media:thumbnail', 'media:thumbnail', { keepArray: true }],
      'media:group',
      'content:encoded',
    ],
  },
});

/** タイトル正規化: 前後trim・連続する半角/全角空白を1つに圧縮（§4.2.1 重複排除用） */
function normalizeTitle(t) {
  return (t || '').trim().replace(/[ \t\u3000]+/g, ' ');
}

// ---------- 長文本文の取得（selfrss 参考: v2.2.0） ----------
// RSS の短い snippet ではなく content:encoded 等の全文を優先し、
// 記事ページも og:description（短い場合あり）より <p> 結合の全文を優先する。
// いずれも「長い方を採用」することで、要約前の時点で文の途中切れを減らす。
const RSS_BODY_MAX_CHARS = 3000;
const ARTICLE_BODY_MAX_CHARS = 2000;
// 短い本文のしきい値（この文字数未満は「短い」とみなし、記事ページで長い本文を試す）
const SHORT_BODY_CHARS = 150;
// 短い本文の再取得はこの間隔を空ける（有料壁ページ等の叩きすぎ防止）
const BODY_REFETCH_MIN_MS = 6 * 3600 * 1000;
const bodyAttemptAt = new Map(); // url -> 最後に記事ページ取得を試みた時刻(ms)

/** 短文キャッシュの再取得が可能か（前回試行から十分間隔が空いたか） */
function shouldRefetchBody(url) {
  const t = bodyAttemptAt.get(url);
  if (!t) return true;
  return Date.now() - t >= BODY_REFETCH_MIN_MS;
}

/** 記事ページ取得の試行を記録する（成功・失敗・キャッシュ返却を問わず試行時に呼ぶ） */
function markBodyAttempt(url) {
  if (!url) return;
  bodyAttemptAt.set(url, Date.now());
  if (bodyAttemptAt.size > 2000) {
    const first = bodyAttemptAt.keys().next().value;
    bodyAttemptAt.delete(first);
  }
}

/** HTML をプレーンテキスト化する（script/style 除去・タグ除去・実体参照復号） */
function htmlToText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<template[\s\S]*?<\/template>/gi, ' ');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|article|section)>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/[ \t\u3000\xa0]+/g, ' ');
  t = t.replace(/\n\s*\n+/g, '\n');
  return t.trim();
}

/** RSS アイテムのフィールド値を文字列化する（object/配列で来る場合に対応） */
function rssFieldText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(rssFieldText).join('\n');
  if (typeof v === 'object') {
    if (typeof v._ === 'string') return v._;
    if (typeof v.href === 'string') return v.href;
    if (typeof v['#'] === 'string') return v['#'];
    return '';
  }
  return String(v);
}

/**
 * RSS アイテムから本文候補のうち最も長いものを返す（selfrss の全文優先流儀）。
 * 候補: content:encoded / content / summary / description / contentSnippet。
 * HTML はテキスト化して比較する。
 */
function extractRssBody(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const fields = [
    raw['content:encoded'],
    raw.content,
    raw.summary,
    raw.description,
    raw.contentSnippet,
  ];
  let best = '';
  for (const f of fields) {
    const s = rssFieldText(f);
    if (!s) continue;
    const text = /<[a-z][^>]*>/i.test(s)
      ? htmlToText(s)
      : decodeEntities(s).replace(/\s+/g, ' ').trim();
    if (text.length > best.length) best = text;
  }
  return best.slice(0, RSS_BODY_MAX_CHARS);
}

/**
 * 記事HTMLの主文エリアから <p> 段落を抜き出す。
 * <article> があればその範囲を優先する（Readability の軽量代替）。
 * 関連見出し・広告欄の段落まで混ざらないよう、定型の区切り文言で打ち切る。
 */
const PARAGRAPH_STOP_PREFIXES = [
  'あわせて読みたい',
  '関連記事',
  '関連ニュース',
  'おすすめ記事',
  // 有料壁の会員勧誘（無料分の末尾・または全文が勧誘の場合はそこで打ち切る）
  '有料会員',
  '会員限定',
  '有料登録',
  '無料登録',
  '無料会員',
  '登録すると続き',
  '続きをお読み',
  'この記事は会員限定',
  '企業での記事共有',
  'すべての記事が読み放題',
  '※掲載される投稿は',
  '※無料期間中に',
  '[Copyright',
  'Copyright',
];
function isBoilerplateParagraph(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  for (const p of PARAGRAPH_STOP_PREFIXES) {
    if (p && s.startsWith(p)) return true;
  }
  // 検索誘導・詳細リンクの定型行（本文中に現れることはほぼ無い）
  if (s.includes('読売新聞を検索でお気に入り')) return true;
  if (s.length < 80 && s.includes('詳しくはこちら')) return true;
  return false;
}
/**
 * 段落先頭のシェアボタン文言（「メールでシェアする Facebookでシェアする …」等）を除去する。
 * タグ境界が空白化されるため、先頭の文言ランを空白区切りで繰り返し剥がす。
 * 「ツイートするには」のように後に文字が続く場合は剥がさない（本文の可能性があるため）。
 */
const SHARE_LEAD_RE =
  /^(?:\S{0,16}?(?:シェアする|ツイートする|ポストする)|はてなブックマークでシェアする|はてブ|LINEで送る|LINEに送る|ブックマークする|お気に入りに登録する?|クリップする)\s+/;
function cleanShareLead(t) {
  let s = String(t == null ? '' : t);
  let prev;
  do {
    prev = s;
    s = s.replace(SHARE_LEAD_RE, '');
  } while (s !== prev);
  return s.trim();
}

/**
 * アプリ誘導・広告の短文かどうか（本文は続くため打ち切らず読み飛ばす）。
 * 例: [PR] / 「雨雲レーダーは「NHK ONE …」で」/ 「…を詳しく」/ 「…リアルタイム表示」
 */
function isPromoParagraph(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 80) return false;
  if (/^(\[PR\]|【PR】|PR[:：]|広告)/.test(s)) return true;
  if (s.includes('NHK ONE')) return true;
  if (/詳しく$/.test(s)) return true;
  if (/リアルタイム表示$/.test(s)) return true;
  if (s.includes('まとめ読みがしやすくなります')) return true;
  return false;
}

/** 文末記号（本文らしい終わり）。「…」で終わるNHK式の文も本文扱いにする */
const SENTENCE_END_RE = /[。！？!?…」』）］〉》.]$/;

function extractMainParagraphs(html, maxChars) {
  if (!html) return [];
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : ARTICLE_BODY_MAX_CHARS;
  let scope = String(html);
  const artStart = scope.search(/<article[\s>]/i);
  const artEnd = scope.search(/<\/article>/i);
  if (artStart !== -1 && artEnd > artStart) {
    scope = scope.slice(artStart, artEnd);
  } else {
    const mainStart = scope.search(/<main[\s>]/i);
    const mainEnd = scope.search(/<\/main>/i);
    if (mainStart !== -1 && mainEnd > mainStart) scope = scope.slice(mainStart, mainEnd);
  }
  const out = [];
  let nonSentenceRun = 0; // 句点なし短文の連続数（関連見出しラン検出用）
  // ※ v2.4.4: <p> の直後に英字が続く場合（<path> <picture> <pre> 等）は除外する。
  // 従来は <path d="..."> の「<p」に誤マッチし、SVG・広告JSまで段落に飲み込んでいた。
  for (const m of scope.matchAll(/<p(?![a-zA-Z])[^>]*>([\s\S]*?)<\/p(?![a-zA-Z])>/gi)) {
    // <p> 内に紛れた <script> は中身ごと除去してからタグを剥がす（広告JS混入対策）
    let t = m[1].replace(/<script[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
    t = decodeEntities(t).replace(/\s+/g, ' ').trim();
    t = cleanShareLead(t);
    if (!t) continue;
    // 埋め込みJS断片が残っていたらその段落は捨てる（本文は続く）
    if (/googletag|console\.(log|error|warn|info|debug)|document\.write/.test(t)) continue;
    if (isPromoParagraph(t)) continue;
    // 写真キャプションは本文から外す（v2.4.6。朝日はRSSが空のため記事取得に頼る分、混入対策）
    if (isCaptionParagraph(t)) continue;
    if (t.length < 20 || isJunkBody(t)) continue;
    // 本文末尾の関連・広告・有料壁の勧誘に入ったら打ち切る（本文段落のみ採用）
    if (isBoilerplateParagraph(t)) break;
    // 句点なし短文の連続は関連見出し群とみなす（直前の1件を取り除いて打ち切る。
    // 写真キャプション等の単発は残す。長文フラグメントは本文扱いで計数リセット）
    if (SENTENCE_END_RE.test(t)) {
      nonSentenceRun = 0;
    } else if (t.length < 80) {
      nonSentenceRun += 1;
      if (nonSentenceRun >= 2) {
        out.pop();
        break;
      }
    } else {
      nonSentenceRun = 0;
    }
    out.push(t);
    if (out.join('').length >= limit) break;
  }
  return out;
}

/** 2つの本文候補のうち実質的に長い方を返す（「続きを読む」残渣を除いた長さで比較） */
function pickLongerBody(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  if (!sa) return sb;
  if (!sb) return sa;
  // 残渣（シェア文言・広告JS等）を除いた実質長で比較する（v2.4.5: 旧キャッシュのゴミが長いだけで勝たない）
  const ea = stripReadMore(sanitizeBodyText(sa)).trim().length;
  const eb = stripReadMore(sanitizeBodyText(sb)).trim().length;
  return eb > ea ? sb : sa;
}

function normalizeItem(raw, sourceName) {
  const title = (raw.title || '').trim();
  if (!title) return null;
  const link = (raw.link || raw.guid || '').trim();
  const pubDate =
    raw.isoDate || raw.pubDate || (raw['dc:date'] || raw['dcterms:date'] || null);
  // selfrss 参考: RSS の短い snippet より content:encoded 等の全文を優先する。
  // 長い方を採用することで、要約前の時点で文の途中切れを減らす。
  let body = extractRssBody(raw);
  // RSS 由来の本文に有料壁のゴミが混じる場合も破棄する（タイトルのみ読み上げ）
  body = cleanBodyWithLink(body, link);
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
 * 末尾の「続きを読む」系の誘導文を除去する（読み上げ・要約用。表示原文は保持）。
 * 例: 「… 続きを読む →」「... 続きを読む」「全文を読む＞＞」等。
 * RSS の contentSnippet / og:description に混入する定型文が TTS で読まれるのを防ぐ。
 */
function stripReadMore(s) {
  let t = String(s == null ? '' : s);
  if (!t) return t;
  // 文中の孤立パターン（改行を挟む場合あり）は先に潰す
  t = t.replace(/\s*[.…．․]{2,}\s*\r?\n?\s*…?\s*(続きを読む|全文を読む|記事全文を読む|詳しく読む|もっと読む)\s*[→➔⇒＞〉》≫>→]*\s*/gu, ' ');
  // 末尾パターンを繰り返し除去（「… 続きを読む →」のような複合形に対応）
  let prev;
  do {
    prev = t;
    t = t.replace(/[\s\u3000\r\n]*([.…．․…・─\-‐―—～~]+)?\s*(続きを読む|全文を読む|記事全文を読む|詳しく読む|もっと読む)\s*[→➔⇒＞〉》≫>→]*[\s\u3000\r\n]*$/u, '');
    // 矢印だけ残った残渣（「… →」等）も除去
    t = t.replace(/[\s\u3000]*[…‥…]+\s*[→➔⇒＞〉》≫>→]+\s*$/u, '');
  } while (t !== prev);
  return t;
}

/**
 * 上限文字数で丸める際に、できる限り読点・句点まで含めるための切り詰め。
 * - 上限を超える場合、先読み範囲内で次の句点（。！？）まで延ばして切る
 * - 句点が無ければ読点（、）まで延ばす
 * - それも無ければ上限内の最後の句読点に切り戻す
 * - どれも無ければハードカット＋…
 */
function truncateAtPunctuation(text, maxChars, lookahead = 80) {
  const s = String(text == null ? '' : text);
  if (!s || s.length <= maxChars) return s;
  const head = s.slice(0, maxChars);
  const tail = s.slice(maxChars, maxChars + lookahead);
  // 1. 先読みで次の句点まで延ばす（閉じ括弧が続けばそれも含める）
  const m = tail.match(/^[^。！？!?]*[。！？!?][」』）)]?/);
  if (m) {
    return (head + m[0]).trim();
  }
  // 2. 句点が無い場合は読点まで延ばす（途切れよりは自然なため）
  const m2 = tail.match(/^[^、，,。！？!?]*[、，,]/);
  if (m2) {
    return (head + m2[0]).trim();
  }
  // 3. 上限内で最後の句読点に切り戻す（短くなりすぎる場合は切り戻さない）
  const puncts = ['。', '！', '？', '!', '?', '、', '，', ',', '\n'];
  let last = -1;
  for (const p of puncts) {
    const i = head.lastIndexOf(p);
    if (i > last) last = i;
  }
  if (last >= Math.max(40, maxChars * 0.4)) {
    return head.slice(0, last + 1).trim();
  }
  return head.replace(/…?$/, '…');
}
/**
 * 読み上げ文を組み立てる（タイトル + 本文要約）。【...】は読み上げない。
 * 空白の連続は1つにたたみ、前後の空白を除去する。
 */
function buildSpeakText(title, extra) {
  const t = stripSpeakBrackets(stripReadMore(title)).replace(/[ \t\u3000]+/g, ' ').trim();
  const rawB = isJunkBody(extra) ? '' : (extra || '');
  const b = stripSpeakBrackets(stripReadMore(rawB)).replace(/\s+/g, ' ').trim();
  if (!t) return b;
  return t + (b ? '。' + b : '');
}

// ---------- 要約（3行程度） ----------
/**
 * 本文を3文程度に要約して読み上げ用テキストを作る。
 * - 文区切り（。！？) で分割し先頭から最大3文
 * - 全体は最大 220 文字で丸める（TTS が長くなりすぎないように）
 * - 「続きを読む」系の誘導文は読み上げない（表示原文は保持）
 * - 上限で区切る場合はできる限り読点・句点まで含める
 */
function summarizeText(text, maxSentences = 3, maxChars = 220) {
  if (isJunkBody(text)) return '';
  let src = stripSpeakBrackets(text || '').replace(/\s+/g, ' ').trim();
  src = stripReadMore(src).trim();
  if (!src) return '';
  const parts = src.match(/[^。！？\n]+[。！？\n]?/g) || [src];
  const sents = parts.map((s) => s.trim()).filter(Boolean).slice(0, maxSentences);
  let out = stripReadMore(sents.join('')).trim();
  if (out.length > maxChars) out = truncateAtPunctuation(out, maxChars);
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

// ---------- freebuff整形（v3.0.0・ローカル純粋関数のみ。外部CLI/API・spawn禁止） ----------
// RSS・記事取得後の本文に、有効時のみ適用する。
// 内容: ですます調/不要な半角全角空白消去(必要空白残す)/広告削除/長文は4行要約。
// 失敗時は元の本文にフォールバックする。
const FREEBUFF_BODY_MAX_CHARS = 4000; // 有効時は取得文字数を長めにする
const FREEBUFF_SUMMARY_CHARS = 800; // 4行要約の上限目安

/** 有効時の取得文字数（無効時は従来の ARTICLE_BODY_MAX_CHARS） */
function currentBodyMaxChars() {
  return settings && settings.freebuffFormat ? FREEBUFF_BODY_MAX_CHARS : ARTICLE_BODY_MAX_CHARS;
}

/**
 * 過去の重複破損の修復だけを行う純粋関数（v3.1.1 以前の保護なし変換で混入した
 * 「しましました」「ましました」「でしました」系を正規形に戻す）。
 * 整形の有無にかかわらず適用でき、冪等（適用済み・正常文には無害）。
 * v3.1.3: 要約側・起動時キャッシュ healing のために toDesuMasu から分離。
 * なお「ない→ありません」系は動詞否定と形容詞の区別が正規表現では不可能で
 * どちらも破壊する（少ありません・食べありません）ため、あえて変換しない（原文維持）。
 */
function repairPastDesuMasuDup(s) {
  let t = String(s == null ? '' : s);
  if (!t) return t;
  // 例: わかりましましました→わかりました / 発表しましました→発表しました /
  // 確認されましました→確認されました / 状態でしましました→状態でした
  t = t.replace(/(まし)+ました/g, 'ました');
  t = t.replace(/でし(まし)+た/g, 'でした');
  return t;
}

/**
 * ですます調への簡易変換（語尾の言い切りを丁寧語に寄せる）。
 * v3.1.2: 既に丁寧語の部分への重複適用を防ぐ（「ました」「でした」は一時保護し、
 * 「まだ」「ただ」等の「だ」は変換しない）。過去データの破損は repairPastDesuMasuDup
 * で先に修復するため、本関数は冪等。
 * v3.1.3 注意: 「しました。」は部分文字列として「した。」を含むため、
 * 保護なしで /した。/g をかけると「発表しました。」→「発表しましました。」と
 * 壊れる。保護・修復のどちらも削らないこと（回帰テスト test/freebuff.test.js 参照）。
 */
function toDesuMasu(s) {
  let t = String(s == null ? '' : s);
  if (!t) return t;
  // 0. 過去の重複破損を修復（v3.1.3: repairPastDesuMasuDup に分離。設定OFF時の healing でも共用）
  t = repairPastDesuMasuDup(t);
  // 0b. 既存の丁寧語を一時保護（未変換の常体は原文のまま残る）
  const PH_M = '\uE000';
  const PH_D = '\uE001';
  t = t.replace(/ました/g, PH_M).replace(/でした/g, PH_D);
  // した系を先に処理する（後続の「だった→でした」が作る「でした」を重ねて壊さないため）
  const rules = [
    [/する。/g, 'します。'],
    [/した。/g, 'しました。'],
    [/している。/g, 'しています。'],
    [/している$/g, 'しています'],
    [/した$/g, 'しました'],
    [/である。/g, 'です。'],
    [/であった。/g, 'でした。'],
    [/だった。/g, 'でした。'],
    [/(?<![またただ未])だ。/g, 'です。'],
    [/である$/g, 'です'],
    [/(?<![またただ未])だ$/g, 'です'],
  ];
  for (const [re, rep] of rules) t = t.replace(re, rep);
  t = t.split(PH_M).join('ました').split(PH_D).join('でした');
  return t;
}

/**
 * ローカル整形の純粋関数（外部呼び出しなし）。
 * @param {string} text 元の本文
 * @returns {string} 整形後の本文（失敗時は原文）
 */
function formatFreebuffBody(text) {
  try {
    const orig = String(text == null ? '' : text);
    if (!orig.trim()) return orig;
    // 1. 広告・誘導の除去（行単位。必要空白は残す）
    let s = sanitizeBodyText(orig);
    const lines = s.split('\n').map((l) => l.trim()).filter((l) => {
      if (!l) return false;
      if (/^(\[PR\]|【PR】|PR[:：]|広告)/.test(l)) return false;
      if (isPromoParagraph(l)) return false;
      if (/^(関連記事|関連ニュース|おすすめ記事|あわせて読みたい)/.test(l)) return false;
      return true;
    });
    s = lines.join('\n') || s;
    // 2. 不要な半角・全角空白の消去
    // 2a. 日本語まわり・括弧内の無駄スペースを除去（欧文同士の必要空白は残す）
    const JP = 'ぁ-んァ-ヶ一-鿿々〆〤';
    const SP = '[ \\t\\u3000\\xa0]';
    const AN = 'A-Za-z0-9';
    s = s.replace(new RegExp(`([${JP}])${SP}+(?=[${JP}])`, 'g'), '$1'); // 日本語同士
    s = s.replace(new RegExp(`([${AN}])${SP}+(?=[${JP}])`, 'g'), '$1'); // 欧文→日本語
    s = s.replace(new RegExp(`([${JP}])${SP}+(?=[${AN}])`, 'g'), '$1'); // 日本語→欧文
    s = s.replace(new RegExp(`([。！？」』）])${SP}+(?=[${JP}「（])`, 'g'), '$1'); // 句読点後
    s = s.replace(new RegExp(`${SP}+(?=[。、！？」』）])`, 'g'), ''); // 句読点前
    s = s.replace(new RegExp(`([（(])${SP}+`, 'g'), '$1'); // 開き括弧後
    s = s.replace(new RegExp(`${SP}+([）)])`, 'g'), '$1'); // 閉じ括弧前
    // 2b. 残りの連続空白を1つに圧縮（必要空白は残す）
    s = s.replace(/[ \t\u3000\xa0]+/g, (m) => (m.includes('\n') ? m : ' '));
    s = s.split('\n').map((l) => l.replace(/ +/g, ' ').trim()).filter(Boolean).join('\n');
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    if (!s) return orig;
    // 3. ですます調
    s = toDesuMasu(s);
    // 4. 長文は4行要約（文区切りで先頭4文・上限で丸め）
    const parts = s.match(/[^。！？\n]+[。！？\n]?/g) || [s];
    const sents = parts.map((p) => p.trim()).filter(Boolean);
    if (sents.length > 4 || s.length > FREEBUFF_SUMMARY_CHARS) {
      let out = sents.slice(0, 4).join('');
      if (out.length > FREEBUFF_SUMMARY_CHARS) out = truncateAtPunctuation(out, FREEBUFF_SUMMARY_CHARS);
      s = out.trim() || s;
    }
    return s || orig;
  } catch (_) {
    return String(text == null ? '' : text);
  }
}

/** 設定が有効な場合のみ整形する（無効時は原文のまま） */
function maybeFormatFreebuff(text) {
  if (!settings || !settings.freebuffFormat) return String(text == null ? '' : text);
  return formatFreebuffBody(text);
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

// ---------- ゴミ本文検出（有料記事のナビ・JS混入対策） ----------
// 読売新聞の有料記事など、本文の代わりにサイトナビや埋め込みJSが抽出される場合がある。
// 例: 「朝刊記事 紙面ビューアー 社説 English さがす ヘルプ let optionWeatherArea = ...」
// こうした本文は読み上げ・表示から除外し、タイトルのみ読み上げにフォールバックする。
const JUNK_BODY_PATTERNS = [
  'YolConsts',
  'optionWeatherArea',
  'LOCAL_STORAGE_OPTION_WEATHER_AREA',
  'weather_area_code',
  '紙面ビューアー',
  'localStorage.getItem',
  // 読売の会員登録・購読案内の定型文（有料壁で本文の代わりに抽出される）
  '読売新聞販売店',
  '読者会員',
  'ご購読の確認',
  // 他紙の有料壁定型文（本文の代わりに勧誘文しか無い場合の除外用）
  'この記事は会員限定',
  '登録すると続きをお読み',
];

/**
 * 記事本文として不適切なゴミ（有料壁のナビ・JS混入）かを判定する。
 * 本文らしい通常記事に含まれ得ないページ固有の断片で検出する。
 */
function isJunkBody(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  for (const p of JUNK_BODY_PATTERNS) {
    if (p && s.includes(p)) return true;
  }
  // ナビ文言の詰め合わせ（単独では本文に現れ得る語もあるため組み合わせで判定）
  if (s.includes('購読申込') && s.includes('ログイン') && (s.includes('朝刊記事') || s.includes('紙面'))) {
    return true;
  }
  // 関連リンク欄の抽出（有料壁で本文の代わりに先頭の関連リンク群が取れる場合）
  if (s.replace(/^\s+/, '').startsWith('あわせて読みたい')) {
    return true;
  }
  return false;
}

/**
 * JSON 文字列由来のエスケープ残渣（\uXXXX・\n・\" 等）を復号する。
 * livedoor の JSON-LD は description 全体が \u エスケープされており、
 * 従来の処理では「3\u65e5\u672a\u660e…」のような文字化けが本文に残った（v2.4.3）。
 * 既にキャッシュ済みの化け本文の修復にも使う。
 */
function decodeJsonEscapes(s) {
  let t = String(s == null ? '' : s);
  if (!t.includes('\\')) return t;
  // 先に JSON の「\\」（文字としてのバックスラッシュ）を退避し、残りの \X を復号してから戻す
  const BS = '\uE000';
  t = t.split('\\\\').join(BS);
  t = t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return '';
    }
  });
  t = t
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, '/');
  return t.split(BS).join('\\');
}

/**
 * 写真キャプションらしい段落か（本文から除外する）。
 * 朝日の形式（「…ガードレール=2026年9月24日…、上田幸一撮影」）を想定。
 * 「=」を含み「撮影/提供」で終わる短文のみ対象（本文の「…を撮影。」は「。」で終わるため残る）。
 */
function isCaptionParagraph(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 200) return false;
  return /[=＝]/.test(s) && /(撮影|提供)\s*$/.test(s);
}

/**
 * 途中から始まる有料壁の勧誘テールを切り落とすマーカー。
 * 旧キャッシュの連結済み本文用（新規抽出は段落先頭判定で打ち切るため対象外）。
 * 本文に現れにくい勧誘固有の言い回しに限定する。
 */
const MIDTEXT_SOLICITATION_MARKERS = [
  '登録すると続き',
  'この記事は会員限定',
  'すべての記事が読み放題',
  '※無料期間中に',
  '【この記事の続きが読める】',
  '有料記事が読み放題',
  '初回1カ月無料',
  '企業での記事共有',
  '有料会員になると',
];

/** 勧誘テールを切り落とす（無ければ原文） */
function truncateSolicitationTail(s) {
  const t = String(s == null ? '' : s);
  if (!t) return t;
  let cut = -1;
  for (const m of MIDTEXT_SOLICITATION_MARKERS) {
    if (!m) continue;
    const i = t.indexOf(m);
    if (i !== -1 && (cut === -1 || i < cut)) cut = i;
  }
  if (cut === -1) return t;
  return t.slice(0, cut).replace(/[\s　…]+$/, '').trim();
}

/**
 * 本文テキストの残渣除去（v2.4.5）。
 * 旧バージョンでキャッシュされた「シェアボタン文言＋広告JS＋[PR]」付き本文や
 * RSS 由来の同様の混入を、表示・保存の各経路で修復するための集中処理。
 * cleanBody系の先頭で適用する（写真キャプション等の本文情報は残す）。
 */
function sanitizeBodyText(t) {
  let s = decodeJsonEscapes(t);
  if (!s) return s;
  // 先頭のシェアボタン文言ランを除去
  let prev;
  do {
    prev = s;
    s = cleanShareLead(s);
  } while (s !== prev);
  // 写真キャプションの残渣を除去（「=日時…撮影」で終わる空白なしスパン。本文は残す）
  s = s.replace(/\S*[=＝]\S*?(撮影|提供)(?=\s|$)/g, ' ');
  // 途中からの勧誘テールを切り落とす
  s = truncateSolicitationTail(s);
  // 埋め込み広告JSのスパン除去（JSコード内に「。」は現れない前提。残渣のみを狙う）
  s = s.replace(/(console\.\w+|googletag|setTimeout\s*\()[^。]{0,1000}?\}\)\s*;?/g, ' ');
  // 広告マーカー除去
  s = s.replace(/\[PR\]|【PR】/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** ゴミ本文なら ''、そうでなければ原文を返す */
function cleanBodyText(text) {
  const s = sanitizeBodyText(text);
  if (!s) return s;
  return isJunkBody(s) ? '' : s;
}

/**
 * 読売の有料壁残渣かを判定する。
 * 無料記事の og:description は「【読売新聞】」始まりで統一されているため、
 * yomiuri.co.jp の本文でこの接頭辞を持たないものは、有料壁のナビ・購読案内・
 * 関連リンク・広告のいずれかが抽出された残渣とみなす（将来の文言変動にも耐える）。
 */
function isYomiuriPaywallResidue(link, body) {
  const s = String(body == null ? '' : body);
  if (!s) return false;
  if (!/yomiuri\.co\.jp/i.test(String(link || ''))) return false;
  return !s.replace(/^\s+/, '').startsWith('【読売新聞】');
}

/** ゴミ本文・有料壁残渣なら ''、そうでなければ原文を返す（link 付き版） */
function cleanBodyWithLink(text, link) {
  const s = sanitizeBodyText(text);
  if (!s) return s;
  if (isJunkBody(s)) return '';
  if (isYomiuriPaywallResidue(link, s)) return '';
  return s;
}

/**
 * 先頭のパンくず残渣（「ニューストップ > 国内ニュース > 社会ニュース > 」等）を除去する。
 * livedoor の JSON-LD description 先頭に付くサイト内ナビ由来の断片対策（v2.4.3）。
 * 数字を含む比較表現（「5 > 3」等）は本文の可能性があるため残す。
 */
function stripBreadcrumbPrefix(s) {
  const t = String(s == null ? '' : s);
  if (!t) return t;
  const m = t.match(/^((?:[^>。！？\n＞]{1,24}\s*[>＞›»]\s*)+)/);
  if (!m) return t;
  const segs = m[1].split(/ *[>＞›»] */).filter((g) => g.trim() !== '');
  if (segs.length === 0 || segs.some((g) => /[0-9０-９]/.test(g))) return t;
  return t.slice(m[1].length).replace(/^\s+/, '');
}

/**
 * 記事HTMLから本文を抽出する。優先度（selfrss 参考・v2.2.0で長文優先に変更）:
 * 1. og:description / meta[name=description] / JSON-LD の description
 * 2. 主文エリアの <p> 結合（最大 ARTICLE_BODY_MAX_CHARS 文字）
 * → 候補のうち実質的に最も長いものを採用する（短い snippet の途中切れを避ける）。
 * 読売は無料記事（og が「【読売新聞】」始まり）のみ <p> も採用し、
 * 有料壁ページは従来どおり '' 相当（タイトルのみ読み上げ）にする。
 * ※ v2.3.0: 無料記事にも含まれる YolConsts 等のページ内定数だけで
 *    有料壁と判定していたため、無料記事まで '' になっていたのを修正。
 */
function extractArticleDescription(html, maxChars = ARTICLE_BODY_MAX_CHARS, link = '') {
  if (!html) return '';
  const cands = [];
  const og = extractMetaContent(html, 'property', 'og:description');
  if (og && og.length >= 10 && !isJunkBody(og)) cands.push(og.trim());
  const meta = extractMetaContent(html, 'name', 'description');
  if (meta && meta.length >= 10 && !isJunkBody(meta)) cands.push(meta.trim());
  const ldMatch = html.match(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (ldMatch) {
    for (const tag of ldMatch) {
      const inner = tag.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
      const dm = inner.match(/"description"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (dm && dm[1]) {
        // JSON 文字列のエスケープ（\uXXXX 等。livedoor は全面エスケープ）を復号する（v2.4.3）
        let desc = '';
        try {
          desc = JSON.parse('"' + dm[1] + '"');
        } catch {
          desc = decodeJsonEscapes(dm[1]);
        }
        desc = decodeEntities(String(desc).replace(/\s+/g, ' ')).trim();
        if (desc.length >= 10 && !isJunkBody(desc)) cands.push(desc);
      }
    }
  }
  // 読売の無料記事は og が「【読売新聞】」始まりで統一されている。
  // 有料壁ページ（本文の代わりにナビ・購読案内等しか無い）は <p> 拾い自体を行わない。
  // ページ内定数（YolConsts 等）は無料記事にも含まれるため判定には使わない。
  const isYomiuri = /yomiuri\.co\.jp/i.test(String(link || ''));
  const yomiuriFree = cands.some((c) => c.replace(/^\s+/, '').startsWith('【読売新聞】'));
  if (!(isYomiuri && !yomiuriFree)) {
    // 主文エリアの <p> を結合した全文候補（従来は先頭1段落×500字だったものを拡張）
    const paras = extractMainParagraphs(html, maxChars);
    if (paras.length > 0) {
      let joined = '';
      for (const p of paras) {
        joined += (joined && !/[。！？!?」』]$/.test(joined) ? ' ' : '') + p;
        if (joined.length >= maxChars) break;
      }
      joined = decodeEntities(joined).slice(0, maxChars).trim();
      if (joined.length >= 10 && !isJunkBody(joined)) {
        // 読売の無料記事の <p> 本文には接頭辞が付かないため補う。
        // 下流の有料壁残渣判定（接頭辞の有無）はそのまま活きる。
        if (isYomiuri && yomiuriFree && !joined.replace(/^\s+/, '').startsWith('【読売新聞】')) {
          joined = `【読売新聞】${joined}`;
        }
        cands.push(joined);
      }
    }
  }
  if (cands.length === 0) return '';
  // 最も長い候補を採用（「続きを読む」残渣を除いた実質長で比較）
  let best = cands[0];
  let bestLen = stripReadMore(best).trim().length;
  for (const c of cands.slice(1)) {
    const len = stripReadMore(c).trim().length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  return stripBreadcrumbPrefix(best);
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

// ---------- Webサイト直接登録（RSS非配信サイト対応・v2.4.0） ----------
// RSS の無いニュースサイトのトップページ等から記事リンクを抽出し、
// RSS アイテム相当（{ title, link }）として既存パイプラインに流す。
// 本文・写真は fillMissingBodies が記事ページから追いかけ取得する。
const SITE_MAX_LINKS = 50; // 1サイトあたりの記事候補上限
const SITE_MIN_TITLE_CHARS = 8; // アンカーテキストの最小文字数（ナビ文言の除外用）
const SITE_HTML_MAX_BYTES = 2 * 1024 * 1024; // 解析対象HTMLの上限（巨大ページ対策）
const SITE_STATIC_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|pdf|mp4|webm|mp3|wav|zip|rar|xml|rss|rdf|atom|json)(\?.*)?$/i;

/** アンカーテキストを記事タイトル用に整形する（タグ除去・空白圧縮・上限200字） */
function cleanAnchorText(t) {
  if (!t) return '';
  let s = String(t).replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}

/**
 * 記事リンクらしいURLかを判定する（純粋関数）。
 * - 同一ホストのみ（外部リンク・SNS共有等を除外）
 * - 静的ファイル・ページ内アンカー・特殊スキームを除外
 * - パス深さ2段以上、または数字を含むID状パス（1段CMS対応）
 */
function isArticleLikeUrl(u, base) {
  let baseHost = '';
  try {
    baseHost = new URL(String(base || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!u || typeof u.href !== 'string') return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname.toLowerCase() !== baseHost) return false;
  if (SITE_STATIC_EXT.test(u.pathname)) return false;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return false; // トップページ自身
  if (segs.length < 2 && !/\d{4,}/.test(u.pathname)) return false;
  // 登録元ページ自身へのリンクは除外する
  try {
    const b = new URL(String(base));
    b.hash = '';
    const c = new URL(u.href);
    c.hash = '';
    if (c.href === b.href) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * サイトHTMLから記事候補 {title, link} を抽出する（純粋関数・出現順・URL重複排除）。
 * タイトルはアンカーテキスト（短すぎるものは除外）。最大 maxLinks 件。
 */
function extractSiteLinks(html, baseUrl, maxLinks = SITE_MAX_LINKS) {
  const out = [];
  const seen = new Set();
  if (!html || !baseUrl) return out;
  const scope = String(html).slice(0, SITE_HTML_MAX_BYTES);
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(scope)) !== null) {
    if (out.length >= maxLinks) break;
    const rawHref = (m[2] || '').trim();
    if (!rawHref || rawHref.startsWith('#')) continue;
    const lower = rawHref.toLowerCase();
    if (
      lower.startsWith('javascript:') ||
      lower.startsWith('mailto:') ||
      lower.startsWith('tel:') ||
      lower.startsWith('data:')
    ) {
      continue;
    }
    let u;
    try {
      u = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    u.hash = '';
    if (!isArticleLikeUrl(u, baseUrl)) continue;
    const key = u.href;
    if (seen.has(key)) continue;
    const title = cleanAnchorText(m[3]);
    if (title.length < SITE_MIN_TITLE_CHARS) continue;
    seen.add(key);
    out.push({ title, link: key });
  }
  return out;
}

/** サイトHTMLを1件取得する（HTML以外・巨大ページは拒否） */
async function fetchSiteHtml(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,*/*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('site HTTP ' + res.status);
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype && !/html/.test(ctype) && !/text/.test(ctype)) {
      throw new Error('HTMLではありません (' + ctype.split(';')[0] + ')');
    }
    const text = await res.text();
    return text.slice(0, SITE_HTML_MAX_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Webサイト1件分を取得してRSSアイテム相当の配列を返す。
 * 戻り値は [{ title, link }]（pubDate 無し。fetchedAt でソートされる）。
 */
async function scrapeSiteFeed(feed, timeoutMs = 15000) {
  if (!feed || !feed.url) throw new Error('URLが指定されていません');
  const html = await fetchSiteHtml(feed.url, timeoutMs);
  return extractSiteLinks(html, feed.url);
}

/**
 * 1フィード分の取得（RSS/サイトの分岐。fetchAllFeeds と個別refreshで共用）。
 * 戻り値は RSS アイテム相当の配列。
 */
async function fetchSingleFeed(feed) {
  if (feedKind(feed) === 'site') {
    return scrapeSiteFeed(feed);
  }
  const parsed = await parser.parseURL(feed.url);
  return (parsed && parsed.items) || [];
}

/**
 * 記事ページを1回取得して本文と写真URLを返す（og:image 優先）。
 * 本文が十分長いキャッシュはそのまま返す。短い本文しか無い場合は
 * 間隔を空けて再取得し、長い方が取れればそちらに置き換える
 * （v2.3.1: 短い og スニペットだけが残り続ける問題の修正。
 *  読売RSSは description が空のため、再取得なしでは全文に届かない）。
 */
async function fetchArticlePage(url, timeoutMs = 10000) {
  if (!url || !/^https?:\/\//.test(url)) return { body: '', image: '' };
  if (bodyCache.has(url) && imageCache.has(url)) {
    const cachedBody = bodyCache.get(url) || '';
    // 長文キャッシュはそのまま返す。短文は再取得 interval 経過後のみ再試行する
    if (cachedBody.length >= SHORT_BODY_CHARS || !shouldRefetchBody(url)) {
      return { body: cachedBody, image: imageCache.get(url) || '' };
    }
  }
  markBodyAttempt(url);
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
    // v3.0.0: 有効時は取得文字数を長めにし、取得後にローカル整形をかける（外部呼び出しなし）
    const maxChars = currentBodyMaxChars();
    let body = extractArticleDescription(html, maxChars, url);
    // 有料壁などでナビ・JSが混入したゴミ本文は破棄し、タイトルのみ読み上げにする
    body = cleanBodyWithLink(body, url);
    body = repairPastDesuMasuDup(maybeFormatFreebuff(body));
    // キャッシュ済みの本文より今回の方が長ければ長い方を残す（短い snippet で上書きしない）
    const cached = bodyCache.get(url) || '';
    if (cached) body = pickLongerBody(cached, body);
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
  // 短文キャッシュの再取得制御は fetchArticlePage 側に一任する（v2.3.1）
  const { body } = await fetchArticlePage(url, timeoutMs);
  return body;
}

/** body・image 未取得の記事に本文・写真を付与する（並列数制限・上限付き・ベストエフォート） */
async function fillMissingBodies(items, { concurrency = 5, limit = 120 } = {}) {
  // 本文が短い（RSS の snippet 程度）場合も記事ページで長い本文を試す（selfrss 流儀の長い方優先）。
  // 読売RSSは description が空のため本文空の記事が多く、空・短い順に優先して埋める。
  const targets = items
    .filter((it) => it.link && (!it.body || it.body.length < SHORT_BODY_CHARS || !it.image))
    .sort(
      (a, b) =>
        (a.body || '').length - (b.body || '').length ||
        (b.fetchedAt || '').localeCompare(a.fetchedAt || '')
    )
    .slice(0, limit);
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const it = targets[i++];
      // 両方キャッシュ済みなら取得不要（store 反映のみ）
      let body = it.body || '';
      let image = it.image || '';
      if (!body || body.length < SHORT_BODY_CHARS || !image) {
        const page = await fetchArticlePage(it.link);
        if (page.body) body = pickLongerBody(body, cleanBodyWithLink(page.body, it.link));
        if (!image && page.image) image = page.image;
      }
      if (body && body !== it.body) {
        body = repairPastDesuMasuDup(maybeFormatFreebuff(body));
        it.body = body;
        it.summary = summarizeText(body);
        bodyCache.set(it.link, body);
      }
      if (image) {
        if (!it.image) it.image = image;
        imageCache.set(it.link, image);
      }
      // store 側の同一 link にも反映（長い方を残す）
      for (const [, list] of store) {
        for (const e of list) {
          if (e.link === it.link) {
            if (body) {
              // v3.1.4: 追いかけ取得のstore反映時も整形を適用（旧キャッシュの未整形本文が長い場合の漏れ修正）
              const merged = repairPastDesuMasuDup(maybeFormatFreebuff(pickLongerBody(e.body, body)));
              if (merged !== e.body) {
                e.body = merged;
                e.summary = summarizeText(merged);
              }
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
            raw.store[p].map((e) => {
              // 旧キャッシュに残った有料壁のゴミ本文・残渣は読み込まず、タイトルのみにする
              // v3.1.3: v3.1.1 以前の保護なし変換で混入した「しましました」系の破損も
              // 設定の有無にかかわらず修復する（修復だけなら原文の意味は変えない）
              const rawBody = e.body || '';
              const cleanBody = repairPastDesuMasuDup(cleanBodyWithLink(rawBody, e.link));
              const rawSummary = e.summary || '';
              return {
                prefecture: e.prefecture,
                title: e.title,
                link: e.link,
                source: e.source,
                // v1.7.0 以降は feedId を保持する。旧データは source 名から逆引きする
                feedId: e.feedId || feedIdByName(e.source),
                pubDate: e.pubDate || null,
                fetchedAt: e.fetchedAt,
                body: cleanBody,
                summary: repairPastDesuMasuDup(cleanBodyWithLink(rawSummary, e.link)) || (cleanBody ? summarizeText(cleanBody) : ''),
                image: e.image || '',
              };
            })
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
        kind: normalizeFeedKind(f.kind),
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
            kind: feedKind(f),
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
  const enabledIds = enabledFeedIds();
  const incomingId = feedId(feed.url);
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
        // 同一記事を現在も配信中のフィードへ付け替える。
        // 付け替え前が無効フィード由来の場合のみ行う（両方有効時の表示名フラップ防止）。
        // v2.4.2: 無効化RSSと同URLのサイト登録記事が表示されない問題の修正。
        if (dup.feedId !== incomingId && !enabledIds.has(dup.feedId)) {
          dup.feedId = incomingId;
          dup.source = n.source;
        }
        // 既存記事に写真・本文が無く、今回の取得にあれば補完する（本文は長い方を残す）
        if (!dup.image && n.image) {
          dup.image = n.image;
          if (dup.link) imageCache.set(dup.link, n.image);
        }
        if (n.body && dup.link) {
          // v3.1.3: 過去破損の混ざったキャッシュと混ぜても破損を残さないよう修復する
          // v3.1.4: 既存記事への追記時も整形ONなら maybeFormat をかける（RSS受信時整形漏れ修正）
          const merged = repairPastDesuMasuDup(maybeFormatFreebuff(pickLongerBody(dup.body, cleanBodyWithLink(n.body, dup.link))));
          if (merged !== dup.body) {
            dup.body = merged;
            dup.summary = summarizeText(merged);
          }
        }
        continue;
      }
      // RSS 時点の本文（content:encoded 等の全文優先）を保持する。
      // 記事ページの追いかけ取得でさらに長い本文が取れれば fillMissingBodies が上書きする。
      const initBody = maybeFormatFreebuff(cleanBodyWithLink(n.body, n.link));
      list.unshift({
        prefecture: pref,
        title: n.title,
        link: n.link,
        source: n.source,
        feedId: feedId(feed.url),
        pubDate: n.pubDate,
        fetchedAt,
        body: initBody,
        summary: initBody ? summarizeText(initBody) : '',
        image: n.image || '',
      });
      if (n.image && n.link) imageCache.set(n.link, n.image);
      if (initBody && n.link) {
        bodyCache.set(n.link, initBody);
        if (bodyCache.size > 1000) {
          const first = bodyCache.keys().next().value;
          bodyCache.delete(first);
        }
      }
      // pubDate 新しい順に並べ替え（pubDate無しは fetchedAt で代用）→ 最新10件に trim。
      // サイト直接登録の記事（pubDate無し）が取得直後に末尾へ回り足切りされないための措置（v2.4.2）。
      list.sort((a, b) => {
        const ka = a.pubDate || a.fetchedAt || '';
        const kb = b.pubDate || b.fetchedAt || '';
        if (ka && kb && ka !== kb) return kb.localeCompare(ka);
        if (ka) return -1;
        if (kb) return 1;
        return 0;
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
    targets.map(({ feed }) => fetchSingleFeed(feed))
  );

  let ok = 0;
  let ng = 0;
  let itemCount = 0;
  const errors = [];
  const nextStates = FEEDS.map((f) => freshFeedState(f));

  results.forEach((r, k) => {
    const { feed, index } = targets[k];
    if (r.status === 'fulfilled') {
      const items = r.value || [];
      ok++;
      itemCount += items.length;
      nextStates[index] = {
        id: feedId(feed.url),
        name: feed.name,
        url: feed.url,
        kind: feedKind(feed),
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
        kind: feedKind(feed),
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
  const enabledIds = enabledFeedIds();
  for (const pref of [...PREFECTURES, '全国', ...TOPIC_CATEGORIES]) {
    const list = store.get(pref) || [];
    for (const e of list) {
      if (!isWithinHours(e, settings.maxAgeHours, nowMs)) continue;
      if (!isFeedEnabledFor(e, enabledIds)) continue;
      // 旧キャッシュ由来のゴミ本文・有料壁残渣が残っていても表示・読み上げに出さない
      // v3.1.3: 読み上げは summary 優先のため、要約側の過去破損（しましました系）も
      // 設定の有無にかかわらず修復する。整形ON時はさらに maybeFormat をかける
      const rawBody = e.body || bodyCache.get(e.link) || '';
      const body = repairPastDesuMasuDup(maybeFormatFreebuff(cleanBodyWithLink(rawBody, e.link)));
      const rawSummary = e.summary || '';
      const summary = repairPastDesuMasuDup(maybeFormatFreebuff(cleanBodyWithLink(rawSummary, e.link))) || summarizeText(body);
      out.push({
        prefecture: e.prefecture || pref,
        title: e.title,
        link: e.link,
        source: e.source,
        pubDate: e.pubDate || null,
        fetchedAt: e.fetchedAt,
        body,
        summary,
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
  const enabledIds = enabledFeedIds();
  for (const pref of PREFECTURES) {
    const list = (store.get(pref) || []).filter(
      (e) => isWithinHours(e, settings.maxAgeHours, nowMs) && isFeedEnabledFor(e, enabledIds)
    );
    if (list.length === 0) continue;
    out.push({
      prefecture: pref,
      news: list.map((e) => {
        const g = byKey.get(memberKey(e, pref));
        // v3.1.3: flatItems と同じく要約側の過去破損も修復する（読み上げは summary 優先のため）
        const rawBody = e.body || bodyCache.get(e.link) || '';
        const body = repairPastDesuMasuDup(maybeFormatFreebuff(cleanBodyWithLink(rawBody, e.link)));
        const rawSummary = e.summary || '';
        const summary = repairPastDesuMasuDup(maybeFormatFreebuff(cleanBodyWithLink(rawSummary, e.link))) || summarizeText(body);
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
  const enabledIds = enabledFeedIds();
  let n = 0;
  for (const p of [...PREFECTURES, ...TOPIC_CATEGORIES]) {
    const list = store.get(p) || [];
    for (const e of list) {
      if (isWithinHours(e, settings.maxAgeHours, nowMs) && isFeedEnabledFor(e, enabledIds)) n++;
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
// 更新直後に古い値が残らないよう、ブラウザ／プロキシのキャッシュを禁止する
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ ok: true, version: VERSION, display: `v.${VERSION}` });
});

// ---- 緊急地震速報 (EEW) ----
// 最新状態の取得（ポーリング用。push は /api/eew/stream の SSE を使う）
app.get('/api/eew', (req, res) => {
  res.json({
    ok: true,
    enabled: eewEnabled(),
    connected: eewConnected,
    wsUrl: EEW_WS_URL,
    lastHeartbeatAt: eewLastHeartbeatAt,
    lastEewAt: eewLastEewAt,
    active: eewActive(),
    eew: latestEew,
  });
});

// SSE で EEW を push 配信する（フロントは EventSource で購読）
app.get('/api/eew/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Tailscale Serve 等のプロキシのバッファリング抑止
  });
  res.write(': connected\n\n');
  // 接続時点で「表示対象（1分以内）」の EEW があれば即送る
  if (eewActive()) {
    res.write(`event: eew\ndata: ${JSON.stringify(latestEew)}\n\n`);
  }
  eewSseClients.add(res);
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) {}
  }, 25 * 1000);
  if (keepalive.unref) keepalive.unref();
  req.on('close', () => {
    clearInterval(keepalive);
    eewSseClients.delete(res);
  });
});

// 模擬発報（表示確認用。制御系 API と同じく DISABLE_CONTROL=1 で無効化）
app.post('/api/eew/mock', (req, res) => {
  if (!controlEnabled()) {
    return res.status(403).json({ ok: false, error: '制御APIは無効化されています (DISABLE_CONTROL=1)' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (body[k] != null && body[k] !== '') return body[k];
    }
    return undefined;
  };
  const raw = {
    Title: pick('Title', 'title') != null ? String(pick('Title', 'title')) : '緊急地震速報（予報）',
    CodeType: pick('CodeType', 'codeType') != null ? String(pick('CodeType', 'codeType')) : '32',
    Issue: { Source: '気象庁', Status: '通常' },
    EventID: pick('EventID', 'eventId') != null ? String(pick('EventID', 'eventId')) : 'mock-event',
    Serial: pick('Serial', 'serial') != null ? String(pick('Serial', 'serial')) : '1',
    AnnouncedTime: pick('AnnouncedTime', 'announcedTime') || '2026/10/02 12:00:00',
    OriginTime: pick('OriginTime', 'originTime') || '2026/10/02 11:59:55',
    Hypocenter: pick('Hypocenter', 'hypocenter') != null ? String(pick('Hypocenter', 'hypocenter')) : 'テスト震源',
    Latitude: pick('Latitude', 'latitude') != null ? String(pick('Latitude', 'latitude')) : '35.6',
    Longitude: pick('Longitude', 'longitude') != null ? String(pick('Longitude', 'longitude')) : '140.1',
    Magunitude: pick('Magunitude', 'Magnitude', 'magnitude') != null
      ? String(pick('Magunitude', 'Magnitude', 'magnitude'))
      : '6.0',
    Depth: pick('Depth', 'depth') != null ? String(pick('Depth', 'depth')) : '50km',
    MaxIntensity: pick('MaxIntensity', 'maxIntensity') != null ? String(pick('MaxIntensity', 'maxIntensity')) : '5弱',
    WarnArea: Array.isArray(body.WarnArea) ? body.WarnArea
      : Array.isArray(body.warnAreas) ? body.warnAreas.map((w) => ({
          Chiiki: w.chiiki || w.Chiiki, Shindo1: w.shindo1 || w.Shindo1,
          Shindo2: w.shindo2 || w.Shindo2, Time: w.time || w.Time,
          Type: w.type || w.Type, Arrive: w.arrive || w.Arrive,
        }))
      : [{ Chiiki: 'テスト地域', Shindo1: '5弱', Shindo2: '', Time: '', Type: '緊急地震速報（予報）', Arrive: '' }],
    isWarn: body.isWarn !== undefined ? !!body.isWarn : true,
    isFinal: !!body.isFinal,
    isCancel: !!body.isCancel,
    isTraining: !!body.isTraining,
    isAssumption: !!body.isAssumption,
    isSea: !!body.isSea,
    OriginalText: pick('OriginalText', 'originalText') != null ? String(pick('OriginalText', 'originalText')) : '',
  };
  const eew = normalizeEew(raw) || {
    type: 'eew',
    title: raw.Title,
    hypocenter: raw.Hypocenter,
    magnitude: raw.Magunitude,
    maxIntensity: raw.MaxIntensity,
    receivedAt: new Date().toISOString(),
  };
  eew.isMock = true;
  eew.receivedAt = new Date().toISOString();
  latestEew = eew;
  eewLastEewAt = eew.receivedAt;
  broadcastEew(eew);
  res.json({ ok: true, eew });
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

// ---- VOICEVOX API（v2.6.0。install/stop は制御系と同じく DISABLE_CONTROL=1 で無効化） ----
app.get('/api/voicevox/status', async (req, res) => {
  const installed = isVoicevoxInstalled();
  let running = false;
  try {
    running = await isVoicevoxRunning(2000);
  } catch (_) {}
  voicevoxStatus.installed = installed;
  voicevoxStatus.running = running;
  voicevoxStatus.rotate = !!settings.voicevoxRotate;
  if (voicevoxInstalling) {
    return res.json({ ok: true, installing: true, ttsEngine: settings.ttsEngine, speaker: settings.voicevoxSpeaker || VOICEVOX_SPEAKER_DEFAULT, rotate: !!settings.voicevoxRotate, speakers: VOICEVOX_SPEAKERS, ...voicevoxStatus });
  }
  if (running && voicevoxStatus.phase !== 'ready') {
    voicevoxStatus.phase = 'ready';
    voicevoxStatus.message = `VOICEVOX で読み上げ中（${voicevoxCurrentLabel()}）`;
  }
  if (!running && voicevoxStatus.phase === 'ready') {
    voicevoxStatus.phase = 'idle';
    voicevoxStatus.message = installed ? 'インストール済み（停止中）' : '未インストール';
  }
  res.json({ ok: true, installing: false, ttsEngine: settings.ttsEngine, speaker: settings.voicevoxSpeaker || VOICEVOX_SPEAKER_DEFAULT, rotate: !!settings.voicevoxRotate, speakers: VOICEVOX_SPEAKERS, ...voicevoxStatus });
});

// 話者切替: 管理画面の話者ボタン用。
// /api/settings でも変更できるが、こちらは話者に特化した短縮API。
// 個別話者を選ぶと順番モードは Off になる（順番モードは POST /api/voicevox/rotate で On）。
app.post('/api/voicevox/speaker', (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const raw = body.speaker != null ? body.speaker : body.voicevoxSpeaker;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || !VOICEVOX_SPEAKER_IDS.includes(n)) {
    return res.status(400).json({ ok: false, error: 'speaker は 3（ずんだもん）・2（四国めたん）・52（雀松朱司）・8（春日部つむぎ）・13（青山龍星）・20（もち子さん）・29（No.7）のいずれかを指定してください' });
  }
  settings = normalizeSettings({ voicevoxSpeaker: n, voicevoxRotate: false }, settings);
  saveSettings();
  voicevoxStatus.speaker = settings.voicevoxSpeaker;
  voicevoxStatus.rotate = false;
  if (voicevoxStatus.phase === 'ready') {
    voicevoxStatus.message = `VOICEVOX で読み上げ中（${voicevoxCurrentLabel()}）`;
  }
  res.json({ ok: true, speaker: settings.voicevoxSpeaker, speakerName: voicevoxSpeakerName(settings.voicevoxSpeaker), rotate: false, speakers: VOICEVOX_SPEAKERS, settings });
});

// 順番モード切替（v2.9.0）: 管理画面の「順番」ボタン用。
// On のときサイネージ画面が1記事ごとに VOICEVOX_SPEAKERS の順で話者を切り替える。
// { rotate: true/false }（省略時は現在の On/Off を反転する）。
app.post('/api/voicevox/rotate', (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const raw = body.rotate != null ? body.rotate : body.voicevoxRotate;
  const on = raw == null ? !settings.voicevoxRotate
    : !(raw === false || raw === 0 || raw === 'false' || raw === '0' || raw === 'off');
  settings = normalizeSettings({ voicevoxRotate: on }, settings);
  saveSettings();
  voicevoxStatus.speaker = settings.voicevoxSpeaker;
  voicevoxStatus.rotate = !!settings.voicevoxRotate;
  if (voicevoxStatus.phase === 'ready') {
    voicevoxStatus.message = `VOICEVOX で読み上げ中（${voicevoxCurrentLabel()}）`;
  }
  res.json({ ok: true, rotate: !!settings.voicevoxRotate, rotateName: '順番に切替', speaker: settings.voicevoxSpeaker, speakers: VOICEVOX_SPEAKERS, settings });
});

app.post('/api/voicevox/install', (req, res) => {
  if (!controlEnabled()) {
    return res.status(403).json({ ok: false, error: '制御APIは無効化されています (DISABLE_CONTROL=1)' });
  }
  if (voicevoxInstalling) {
    return res.json({ ok: true, message: 'インストール処理中です', status: voicevoxStatus });
  }
  // 背景でダウンロード→展開→起動（応答は待たない。進捗は status ポーリングで確認）
  installVoicevoxBackground().catch((e) => {
    console.error('voicevox install failed:', String((e && e.message) || e));
  });
  res.json({ ok: true, message: 'VOICEVOX のインストールを開始しました', status: voicevoxStatus });
});

app.post('/api/voicevox/stop', (req, res) => {
  if (!controlEnabled()) {
    return res.status(403).json({ ok: false, error: '制御APIは無効化されています (DISABLE_CONTROL=1)' });
  }
  stopVoicevox();
  // 停止したらブラウザ読み上げに戻す（既存機能を壊さない）
  settings = normalizeSettings({ ttsEngine: 'browser' }, settings);
  saveSettings();
  res.json({ ok: true, message: 'VOICEVOX を停止しブラウザ読み上げに戻しました', status: voicevoxStatus, settings });
});

// TTS プロキシ: フロントはテキストを送るだけで WAV を受け取れる（CORS・公開ポート回避）
app.post('/api/tts', async (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const text = String(body.text != null ? body.text : '').trim();
  if (!text) {
    return res.status(400).json({ ok: false, error: 'text を指定してください', fallback: 'browser' });
  }
  const speakerRaw = body.speaker != null ? parseInt(body.speaker, 10) : (settings.voicevoxSpeaker || VOICEVOX_SPEAKER_DEFAULT);
  const speaker = Number.isFinite(speakerRaw) ? speakerRaw : VOICEVOX_SPEAKER_DEFAULT;
  // 長文は先頭だけ合成する（ENGINE 負荷・応答時間の上限）
  const clipped = text.slice(0, 1000);
  try {
    const wav = await synthesizeVoicevox(clipped, speaker);
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'no-store');
    return res.send(wav);
  } catch (e) {
    return res.status(503).json({ ok: false, error: 'VOICEVOX が利用できません: ' + String((e && e.message) || e), fallback: 'browser' });
  }
});

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
      kind: feedKind(f),
      enabled: f.enabled !== false,
    })),
  });
});

function cleanFeedEntry(f) {
  if (!f || typeof f.url !== 'string' || !/^https?:\/\//.test(f.url.trim())) return null;
  return {
    name: ((f.name || f.url).toString().slice(0, 100)),
    url: f.url.trim(),
    kind: normalizeFeedKind(f.kind),
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
  // npm install が package-lock.json の version を自動更新して作業ツリーを汚し、
  // 次回の `git pull --ff-only` が失敗するのを防ぐため、pull 前に自動生成差分を破棄する
  const cmd = 'git fetch origin && (git checkout -- package-lock.json package.json 2>/dev/null || true) && git pull --ff-only && npm install --no-audit --no-fund && systemctl restart newsflow';
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
  const entry = {
    name: (name || url).slice(0, 100),
    url,
    kind: normalizeFeedKind(req.body && req.body.kind),
    enabled: true,
  };
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

// ---- フィード更新（管理画面の「対象」チェックボックス用） ----
// { enabled?: boolean, name?: string } を受け付け、永続化する。
// チェックを外しても記事は store に残る（表示だけ除外。再チェックで即復活）。
// チェックを入れた場合は背景で再取得する（無効期間中の分を取り込む）。
app.put('/api/feeds/:id', (req, res) => {
  const idx = resolveFeedIndex(String(req.params.id || ''));
  if (!Number.isInteger(idx) || idx < 0 || idx >= FEEDS.length) {
    return res.status(404).json({ ok: false, error: '指定のフィードが見つかりません' });
  }
  const body = (req.body && typeof req.body === 'object' ? req.body : {});
  const feed = FEEDS[idx];
  const prev = feedStates[idx] || freshFeedState(feed);
  if (body.enabled !== undefined) {
    const v = body.enabled;
    feed.enabled = !(v === false || v === 0 || v === 'false' || v === '0' || v === 'off');
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 100);
    if (!name) {
      return res.status(400).json({ ok: false, error: 'name を空にはできません' });
    }
    feed.name = name;
  }
  if (body.kind !== undefined) {
    feed.kind = normalizeFeedKind(body.kind);
  }
  saveFeeds();
  const next = {
    id: feedId(feed.url),
    name: feed.name,
    url: feed.url,
    kind: feedKind(feed),
    enabled: feed.enabled !== false,
    ok: !!prev.ok,
    items: prev.items || 0,
    error: prev.error || null,
  };
  feedStates[idx] = next;
  // 有効化時は背景で即時取得（応答は待たない）
  if (next.enabled) {
    fetchAllFeeds().catch((e) => console.error('fetch after enable failed:', e));
  }
  res.json({ ok: true, feed: next, feeds: feedStates });
});

// ---- 記事本文オンデマンド API（フロントのフォールバック用） ----
app.get('/api/article', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ ok: false, error: 'url パラメータが必要です' });
  }
  // store に本文があればそれを返す（ゴミ本文はタイトルのみ扱いにする）。
  // ただし短い本文しか無い場合はライブ再取得に回す（v2.3.1: 短文キャッシュに張り付かない）
  for (const [, list] of store) {
    const hit = list.find((e) => e.link === url && (e.body || e.summary));
    if (hit) {
      const image = hit.image || imageCache.get(url) || '';
      // v3.1.3: 要約側の過去破損（しましました系）も修復する
      const body = repairPastDesuMasuDup(maybeFormatFreebuff(cleanBodyWithLink(hit.body, url)));
      const summary = repairPastDesuMasuDup(maybeFormatFreebuff(cleanBodyWithLink(hit.summary, url))) || summarizeText(body);
      if (body.length >= SHORT_BODY_CHARS || !shouldRefetchBody(url)) {
        if (!body && !summary) {
          return res.json({ ok: true, url, body: '', summary: '', image, cached: true });
        }
        return res.json({ ok: true, url, body, summary, image, cached: true });
      }
      // 短文かつ再取得 interval 経過 → 下のライブ取得にフォールスルーする
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
    const items = await fetchSingleFeed(feed);
    const fetchedAt = new Date().toISOString();
    const added = ingestFeedItems(feed, items, fetchedAt);
    feedStates[idx] = {
      id: feedId(feed.url),
      name: feed.name,
      url: feed.url,
      kind: feedKind(feed),
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
      kind: feedKind(feed),
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
  startEewWatcher();
  // VOICEVOX 読み上げ設定なら ENGINE を自動起動する（失敗してもサーバーは起動する）
  if (settings.ttsEngine === 'voicevox' && isVoicevoxInstalled()) {
    startVoicevox().catch((e) => console.error('voicevox autostart failed:', String((e && e.message) || e)));
  }
  // v3.1.4: 起動時RSS待ちでlistenが遅延しないよう、先にlisten→scheduleし取得はバックグラウンド化（遅延実行。廃止ではない）
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[起動] http://127.0.0.1:${PORT} で待受中`);
  });
  scheduleFetch();
  fetchAllFeeds().catch((e) => console.error('initial fetch failed:', e));
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
  formatFreebuffBody,
  maybeFormatFreebuff,
  toDesuMasu,
  repairPastDesuMasuDup,
  currentBodyMaxChars,
  FREEBUFF_BODY_MAX_CHARS,
  FREEBUFF_SUMMARY_CHARS,
  stripSpeakBrackets,
  stripReadMore,
  truncateAtPunctuation,
  buildSpeakText,
  titleSimilarity,
  areSimilarTitles,
  titleTokens,
  isDateNumericToken,
  contentTokens,
  decodeEntities,
  extractMetaContent,
  extractArticleDescription,
  extractRssBody,
  extractMainParagraphs,
  isBoilerplateParagraph,
  htmlToText,
  rssFieldText,
  pickLongerBody,
  RSS_BODY_MAX_CHARS,
  ARTICLE_BODY_MAX_CHARS,
  isJunkBody,
  cleanBodyText,
  decodeJsonEscapes,
  sanitizeBodyText,
  stripBreadcrumbPrefix,
  isYomiuriPaywallResidue,
  cleanBodyWithLink,
  fetchArticleBody,
  fetchArticlePage,
  shouldRefetchBody,
  markBodyAttempt,
  SHORT_BODY_CHARS,
  extractFeedImage,
  extractOgImage,
  ingestFeedItems,
  fetchSingleFeed,
  feedKind,
  normalizeFeedKind,
  extractSiteLinks,
  cleanAnchorText,
  isArticleLikeUrl,
  cleanShareLead,
  isPromoParagraph,
  isCaptionParagraph,
  truncateSolicitationTail,
  scrapeSiteFeed,
  resolveFeedIndex,
  feedId,
  articleId,
  feedIdByName,
  enabledFeedIds,
  isFeedEnabledFor,
  loadFeeds,
  saveFeeds,
  describeWeather,
  describeJmaWeather,
  parseJmaForecast,
  weatherAreaCode,
  weatherAreaInfo,
  WEATHER_AREAS,
  WEATHER_DEFAULT_AREA,
  // 緊急地震速報 (EEW / Wolfx)
  EEW_WS_URL,
  EEW_DISPLAY_MS,
  eewEnabled,
  eewActive,
  normalizeEew,
  handleEewMessage,
  broadcastEew,
  startEewWatcher,
  connectEew,
  get latestEew() { return latestEew; },
  get eewConnected() { return eewConnected; },
  // 指示書 §3.4 の関数名との両対応エイリアス（実装名が正規。テストはどちらでも参照可）
  similarity: titleSimilarity,
  clusterItems: assignGroups,
  extractMeta: extractArticleDescription,
  // VOICEVOX（読み上げ, v2.6.0）
  VOICEVOX_PORT,
  VOICEVOX_HOST,
  VOICEVOX_DIR,
  VOICEVOX_SPEAKER_DEFAULT,
  VOICEVOX_SPEAKERS,
  VOICEVOX_SPEAKER_IDS,
  voicevoxSpeakerName,
  voicevoxSpeakerForIndex,
  VOICEVOX_ENGINE_VERSION_FALLBACK,
  get voicevoxStatus() { return voicevoxStatus; },
  isVoicevoxInstalled,
  isVoicevoxRunning,
  startVoicevox,
  stopVoicevox,
  installVoicevoxBackground,
  synthesizeVoicevox,
  resolveVoicevoxAsset,
  voicevoxBaseUrl,
};
