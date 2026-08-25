// seed_share.js — トーナメントプレビューの共有コーデック層。
//   - シードページ (発行側) と site/bracket/ (プレビュー側) の両方から読む。
//   - ペイロード規約 (validatePayload) / URL フラグメントの encode/decode /
//     作業状況 CSV → ペイロード変換 を担当。DOM / fetch には依存しない。
//   - 圧縮はブラウザ標準の CompressionStream('deflate-raw')。Node 18+ でも同じ
//     コードパスで動く (テストは往復で検証)。
// 設計: docs/seed_preview_design.md §2
//
// ペイロード (v:1):
//   { v:1, ev, src, phases:[{name,pools,adv,lb?}], wv:[poolIdx→waveIdx]?, prog?,
//     uids:[uid|null...], names:{index:string} }
//   - シード番号 = uids の index + 1。
//   - names は原則 全参加者分 (プレビュー側が players/<uid>.json を取れなくても
//     名前が出せるように)。URL が長くなる規模では DB 未登録者のみに縮小する。
//   - phases[].lb = 1プールあたり敗者側スタートの人数 (下位シードから)。
//     省略/0 = 全員勝者側スタート。トップカットの「予選2位は敗者側から」用。
//   - プール数は phases[*].pools が正。wv の長さは phases[0].pools と一致必須。
//   - prog は進出割当パターンの予約フィールド (省略 = start.gg デフォルト =
//     期待強度順。docs 参照。現状これ以外の値は未定義)。

(function (global) {
  'use strict';

  // ホスト環境 (CompressionStream / Blob / Response / btoa)。
  const H = (typeof globalThis !== 'undefined') ? globalThis : global;

  // ───────────────────────── base64url ─────────────────────────
  function bytesToBase64url(bytes) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return H.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64urlToBytes(s) {
    if (typeof s !== 'string' || /[^A-Za-z0-9_-]/.test(s)) {
      const junk = typeof s === 'string' ? (s.match(/[^A-Za-z0-9_-]/g) || []).slice(0, 3).join('') : '';
      throw new Error('共有データ (d=) に使えない文字が入っています' +
        (junk ? ` ("${junk}" など)。URL の途中で改行が入っていないか確認してください` : ''));
    }
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    const bin = H.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ───────────────────────── deflate-raw ─────────────────────────
  function _requireCompression() {
    if (typeof H.CompressionStream === 'undefined' || typeof H.DecompressionStream === 'undefined') {
      throw new Error('このブラウザは CompressionStream に対応していません (新しいブラウザで開いてください)');
    }
  }

  async function _pipe(bytes, transform) {
    const stream = new H.Blob([bytes]).stream().pipeThrough(transform);
    const buf = await new H.Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function deflateRawBytes(bytes) {
    _requireCompression();
    return _pipe(bytes, new H.CompressionStream('deflate-raw'));
  }

  // 展開に失敗する原因はほぼ「URL が最後まで貼られていない」。
  // ブラウザは中身のないエラー (Chrome は "Failed to fetch") しか返さないので言い換える。
  async function inflateRawBytes(bytes) {
    _requireCompression();
    try {
      return await _pipe(bytes, new H.DecompressionStream('deflate-raw'));
    } catch (e) {
      throw new Error(`共有データを展開できません (${bytes.length}バイト)。` +
        'URL が途中で切れている可能性があります — アドレスバーの末尾まで含めてコピーし直すか、' +
        '作業状況 CSV での共有をお試しください');
    }
  }

  // ───────────────────────── ペイロード検証 ─────────────────────────
  function _isInt(v) { return typeof v === 'number' && Number.isInteger(v); }

  // フェーズ f の参加人数の列 [N, adv0*pools0, ...] (検証済み前提。min でクランプ)。
  function phaseEntrantCounts(phases, N) {
    const out = [];
    let cur = N;
    for (let f = 0; f < phases.length; f++) {
      out.push(cur);
      cur = Math.min(cur, Math.max(0, (phases[f].adv | 0)) * Math.max(1, (phases[f].pools | 0)));
    }
    return out;
  }

  // フェーズ構成の検証。errors 配列を返す (空 = OK)。
  function validatePhases(phases, N) {
    const errors = [];
    if (!Array.isArray(phases) || phases.length < 1) return ['phases がありません'];
    let cur = N;
    for (let f = 0; f < phases.length; f++) {
      const p = phases[f] || {};
      const tag = `フェーズ${f + 1} (${p.name || '無名'})`;
      if (typeof p.name !== 'string' || !p.name.trim()) errors.push(`${tag}: 名前がありません`);
      if (!_isInt(p.pools) || p.pools < 1) { errors.push(`${tag}: プール数が不正 (${p.pools})`); continue; }
      if (p.pools > cur) errors.push(`${tag}: プール数 ${p.pools} が参加人数 ${cur} を超えています`);
      if (p.lb != null) {
        const maxPool = Math.ceil(cur / p.pools);
        if (!_isInt(p.lb) || p.lb < 0) errors.push(`${tag}: 敗者側スタート人数が不正 (${p.lb})`);
        else if (p.lb > maxPool - 2) {
          errors.push(`${tag}: 敗者側スタート ${p.lb}人 が多すぎます (1プール ${maxPool}人 なので ${Math.max(0, maxPool - 2)}人 まで)`);
        }
      }
      const isFinal = f === phases.length - 1;
      if (!isFinal) {
        if (!_isInt(p.adv) || p.adv < 1) {
          errors.push(`${tag}: 進出人数が不正 (${p.adv})`);
        } else if (p.adv * p.pools >= cur) {
          errors.push(`${tag}: 進出合計 ${p.adv}×${p.pools}=${p.adv * p.pools} が参加人数 ${cur} 以上でカットになりません`);
        } else {
          cur = p.adv * p.pools;
        }
      }
    }
    return errors;
  }

  // 最終フェーズのプールが 2 つ以上あると、そこで大会が終わらない (合流先が無い)。
  // その場合は 1 プールの次フェーズを自動で足す。N = 全参加人数。
  function withFinalPhase(phases, N) {
    const out = (phases || []).map((p) => Object.assign({}, p));
    const last = out[out.length - 1];
    if (!last || (last.pools | 0) <= 1) return out;
    if (!((last.adv | 0) >= 1)) last.adv = 2;
    const cur = phaseEntrantCounts(out, N)[out.length - 1];
    let adv = last.adv | 0;
    while (adv > 1 && adv * (last.pools | 0) >= cur) adv--;   // カットになるところまで詰める
    // 1人抜けでもカットにならない (プール数 >= 人数) なら足しようがないのでそのまま
    if (adv * (last.pools | 0) >= cur) return phases.map((p) => Object.assign({}, p));
    last.adv = adv;
    out.push({ name: 'TOP' + adv * (last.pools | 0), pools: 1, adv: 0 });
    return out;
  }

  function validatePayload(p) {
    const errors = [];
    if (!p || typeof p !== 'object') return ['ペイロードがオブジェクトではありません'];
    if (p.v !== 1) errors.push(`未知のバージョン v=${p && p.v} (対応: 1)`);
    if (!Array.isArray(p.uids) || p.uids.length < 2) {
      errors.push('uids (シード順の参加者列) がないか 2 人未満です');
      return errors;   // 以降の検証は uids 前提
    }
    const seen = new Set();
    for (let i = 0; i < p.uids.length; i++) {
      const u = p.uids[i];
      if (u === null) {
        if (!p.names || typeof p.names[String(i)] !== 'string' || !p.names[String(i)].trim()) {
          errors.push(`シード${i + 1}: uid がなく names にも名前がありません`);
        }
      } else if (!_isInt(u) || u <= 0) {
        errors.push(`シード${i + 1}: uid が不正 (${u})`);
      } else if (seen.has(u)) {
        errors.push(`シード${i + 1}: uid ${u} が重複しています`);
      } else {
        seen.add(u);
      }
    }
    errors.push(...validatePhases(p.phases, p.uids.length));
    if (p.wv != null) {
      const P0 = Array.isArray(p.phases) && p.phases[0] ? p.phases[0].pools : null;
      if (!Array.isArray(p.wv)) errors.push('wv が配列ではありません');
      else if (P0 != null && p.wv.length !== P0) {
        errors.push(`wv の長さ ${p.wv.length} が予選プール数 ${P0} と一致しません`);
      } else if (p.wv.some((w) => !_isInt(w) || w < 0)) {
        errors.push('wv に不正な値があります');
      }
    }
    return errors;
  }

  // ───────────────────────── encode / decode ─────────────────────────
  async function encodePayload(payload) {
    const errors = validatePayload(payload);
    if (errors.length) throw new Error('ペイロードが不正です: ' + errors.join(' / '));
    const json = JSON.stringify(payload);
    const gz = await deflateRawBytes(new TextEncoder().encode(json));
    return bytesToBase64url(gz);
  }

  async function decodePayload(blob) {
    const bytes = await inflateRawBytes(base64urlToBytes(blob));
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Error('共有データを JSON として読めません: ' + (e && e.message));
    }
    const errors = validatePayload(payload);
    if (errors.length) throw new Error('共有データが不正です: ' + errors.join(' / '));
    return payload;
  }

  // ───────────────────────── データバージョン ─────────────────────────
  // 「同じデータを見ているか」を突き合わせるための短いハッシュ。
  //
  // 含めるのは **ブラケットの中身を決める要素だけ**:
  //   ev (大会名) / uids (シード順) / phases (名前・プール数・通過人数・敗者側スタート) /
  //   wv (ウェーブ割り) / prog (進出割当)
  //
  // 含めないもの:
  //   - 見る側の状態 (フラグメントの ph / pool / wd / lb / hi)。どのプールを開いて
  //     いるかで版が変わったら突き合わせに使えない。
  //   - names (表示名)。URL が長くなる規模では DB 登録者ぶんを落とすので、
  //     同じブラケットでも URL の作り方で中身が変わる。表示専用なので無視する。
  //   - src (発行元が seed ページか CSV か)。同じブラケットなら同じ版であるべき。
  //   - blob (d=) 自体。deflate の出力は実装依存で、同じ入力でも一致する保証がない。
  function versionSource(p) {
    const phases = (Array.isArray(p && p.phases) ? p.phases : []).map((f) => [
      String((f && f.name) || ''), (f && f.pools) | 0, (f && f.adv) | 0, (f && f.lb) | 0,
    ]);
    return JSON.stringify({
      v: (p && p.v) | 0,
      ev: String((p && p.ev) || ''),
      uids: (Array.isArray(p && p.uids) ? p.uids : []).map((u) => (u == null ? 0 : u)),
      phases,
      wv: (p && Array.isArray(p.wv)) ? p.wv.map((w) => w | 0) : null,
      prog: (p && p.prog) || null,
    });
  }

  // 突き合わせ用なので暗号ハッシュは要らない (crypto.subtle は http や古い環境で
  // 使えず、そのために版が出ないほうが困る)。FNV-1a を2レーン回して
  // MurmurHash3 の finalizer で撹拌した 40bit を使う。
  function _mix32(h) {
    h ^= h >>> 16; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  }

  // 目視で突き合わせる前提なので、紛らわしい文字 (I/L/O/U) を除いた
  // Crockford base32 で 8 文字 (40bit)。'ABCD-EFGH' の形で出す。
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  function payloadVersion(p) {
    const str = versionSource(p);
    let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ (c + i), 2246822519);
    }
    const a = _mix32(h1 ^ (h2 >>> 15));           // 上位 32bit
    const b = _mix32(h2 ^ (h1 >>> 13)) & 0xff;    // 下位 8bit → 計 40bit
    let out = '';
    for (let i = 7; i >= 0; i--) {
      // 40bit を 5bit ずつ。下位から取って逆順に並べる。
      const shift = (7 - i) * 5;
      const bits = shift < 8
        ? (b >>> shift) | ((a << (8 - shift)) & 0x1f)
        : (a >>> (shift - 8));
      out = B32[bits & 31] + out;
    }
    return out.slice(0, 4) + '-' + out.slice(4);
  }

  // ───────────────────────── URL フラグメント ─────────────────────────
  // '#v=1&ph=0&pool=A3&wd=1&lb=0&hi=12&d=<blob>'。view は blob の外 (表示状態の共有用)。
  function parseFragment(hash) {
    // 貼り付け時に折り返しの改行・空白が混ざることがあるので落とす
    const s = String(hash || '').replace(/^#/, '').replace(/\s+/g, '');
    const q = new URLSearchParams(s);
    const num = (k, dflt) => {
      const v = q.get(k);
      if (v == null || v === '') return dflt;
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? dflt : n;
    };
    return {
      v: num('v', 1),
      view: {
        ph: num('ph', 0),
        pool: q.get('pool') || null,
        wd: num('wd', 1),
        lb: num('lb', 0),
        hi: num('hi', null),      // 注目する参加者 (シード index-1)。次フェーズへの遷移で使う
      },
      d: q.get('d') || null,
    };
  }

  function buildFragment(view, d) {
    const q = new URLSearchParams();
    q.set('v', '1');
    q.set('ph', String((view && view.ph) || 0));
    if (view && view.pool) q.set('pool', view.pool);
    q.set('wd', String(view && view.wd != null ? view.wd : 1));
    if (view && view.lb) q.set('lb', String(view.lb));
    if (view && view.hi != null) q.set('hi', String(view.hi));
    q.set('d', d);
    return '#' + q.toString();
  }

  // ───────────────────────── ウェーブ / プール表示名 ─────────────────────────
  // seed_app.js の chunkWaveMap / waveLetter / poolLabel と同一仕様 (純関数として再掲)。
  function chunkWaveMap(P, W) {
    const map = new Array(P);
    const Wc = Math.max(1, Math.min(W, P));
    const bsize = Math.floor(P / Wc), extra = P % Wc;
    let p = 0;
    for (let w = 0; w < Wc; w++) {
      const sz = bsize + (w < extra ? 1 : 0);
      for (let k = 0; k < sz; k++) map[p++] = w;
    }
    return map;
  }
  function waveLetter(i) { return i < 26 ? String.fromCharCode(65 + i) : 'W' + (i + 1); }
  function poolLabel(poolIdx, waveMap) {
    if (!waveMap || !waveMap.some((w) => w > 0)) return 'P' + (poolIdx + 1);
    const w = waveMap[poolIdx];
    let k = 0;
    for (let p = 0; p < poolIdx; p++) if (waveMap[p] === w) k++;
    return waveLetter(w) + (k + 1);
  }

  // ───────────────────────── 作業状況 CSV → ペイロード ─────────────────────────
  // seed_app の「💾 作業状況を保存 (CSV)」出力 (seed,name,discriminator,uid,lock,pool,pools,waves)
  // を読み込む。日本語列名 (順位/名前/プール数/ウェーブ数) も受ける。
  function parseCsv(text) {
    const s = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  }

  const _COL_ALIASES = {
    seed: ['seed', '順位', 'シード'],
    name: ['name', '名前'],
    uid: ['uid'],
    pools: ['pools', 'プール数'],
    waves: ['waves', 'ウェーブ数'],
    // プレビューの保存 CSV 用の拡張列 (1行目のみ。シードページの作業状況 CSV には無い)
    event: ['event', 'イベント'],
    phases: ['phases'],
    wv: ['wv'],
    view: ['view'],
  };

  function _findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const lower = rows[i].map((c) => String(c).trim().toLowerCase());
      const cols = {};
      for (const key in _COL_ALIASES) {
        for (const alias of _COL_ALIASES[key]) {
          const j = lower.indexOf(alias);
          if (j >= 0) { cols[key] = j; break; }
        }
      }
      if (cols.seed != null || (cols.name != null && cols.uid != null)) return { headerIdx: i, cols };
    }
    return null;
  }

  // 作業状況 CSV テキスト → { payload, warnings }。致命的な不整合は throw (fail-loud)。
  function workCsvToPayload(text, opts) {
    opts = opts || {};
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('CSV が空です');
    const head = _findHeader(rows);
    if (!head) throw new Error('ヘッダ行が見つかりません (seed/順位 列、または name+uid 列が必要)');
    const { headerIdx, cols } = head;
    const warnings = [];
    const entries = [];
    let P = null, W = null, evName = null, phasesJson = null, wvJson = null, viewStr = null;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const get = (k) => (cols[k] != null && row[cols[k]] != null) ? String(row[cols[k]]).trim() : '';
      const pv = get('pools'), wvv = get('waves');
      if (P == null && /^\d+$/.test(pv)) P = parseInt(pv, 10);
      if (W == null && /^\d+$/.test(wvv)) W = parseInt(wvv, 10);
      if (evName == null && get('event')) evName = get('event');
      if (phasesJson == null && get('phases')) phasesJson = get('phases');
      if (wvJson == null && get('wv')) wvJson = get('wv');
      if (viewStr == null && get('view')) viewStr = get('view');
      const name = get('name');
      const uidS = get('uid');
      const uid = /^\d+$/.test(uidS) ? parseInt(uidS, 10) : null;
      if (!name && uid == null) continue;   // 参加者情報のない行
      const seedS = get('seed');
      const seed = /^\d+$/.test(seedS) ? parseInt(seedS, 10) : null;
      entries.push({ seed, uid, name, line: i + 1 });
    }
    if (entries.length < 2) throw new Error(`参加者が ${entries.length} 人しか読めませんでした`);
    const withSeed = entries.filter((e) => e.seed != null);
    if (withSeed.length !== entries.length && withSeed.length > 0) {
      throw new Error('seed (順位) 列が一部の行にしかありません (全行に付けるか、全行外してください)');
    }
    if (withSeed.length) {
      const seen = new Set();
      for (const e of withSeed) {
        if (seen.has(e.seed)) throw new Error(`シード番号 ${e.seed} が重複しています (${e.line} 行目)`);
        seen.add(e.seed);
      }
      entries.sort((a, b) => a.seed - b.seed);
    }
    const dupUid = new Set(), uidSeen = new Set();
    for (const e of entries) {
      if (e.uid != null) {
        if (uidSeen.has(e.uid)) dupUid.add(e.uid);
        uidSeen.add(e.uid);
      }
    }
    if (dupUid.size) throw new Error('uid が重複しています: ' + [...dupUid].join(', '));
    // phases / wv / view (プレビュー保存 CSV の拡張列。JSON 文字列。壊れていたら fail-loud)
    let phases = null, wvArr = null, view = null;
    if (phasesJson) {
      try { phases = JSON.parse(phasesJson); } catch (e) { throw new Error('phases 列の JSON が読めません: ' + e.message); }
    }
    if (wvJson) {
      try { wvArr = JSON.parse(wvJson); } catch (e) { throw new Error('wv 列の JSON が読めません: ' + e.message); }
    }
    if (viewStr) view = parseFragment('#' + viewStr).view;
    if (phases && P == null && phases[0]) P = phases[0].pools;
    if (P == null) { P = 1; warnings.push('pools 列がないためプール数 1 として扱います'); }
    if (W == null) W = 1;
    const uids = entries.map((e) => e.uid);
    const names = {};
    // CSV 経由は DB 登録状況が分からないので、名前がある行はすべて names に載せる
    // (登録者は players/<uid>.json の display が優先されるだけで無害)。
    entries.forEach((e, i) => { if (e.name) names[String(i)] = e.name; });
    const payload = {
      v: 1,
      ev: evName || opts.ev || 'CSV 読み込み',
      src: 'csv',
      phases: withFinalPhase(phases || [{ name: P >= 2 ? '予選' : 'ブラケット', pools: P, adv: 2 }], uids.length),
      wv: wvArr || chunkWaveMap(P, Math.max(1, W)),
      uids,
      names,
    };
    const errors = validatePayload(payload);
    if (errors.length) throw new Error('CSV から作ったペイロードが不正です: ' + errors.join(' / '));
    return { payload, warnings, view };
  }

  // ── ペイロード → 保存用 CSV (プレビューページの「💾 CSV保存」) ──
  // 1 行目にだけ pools/waves/event/phases/wv/view を書く。シードページの作業状況 CSV と
  // 同じ列 (seed,name,uid) を持つので、シードアップロードの📌パネルでも読める。
  // opts.nameOf = (index) => 表示名 ('' 可。uid があれば省略しても復元できる)。
  // opts.poolLabelOf = (index) => プール表示名 (参考列。無ければ空)。
  // opts.view = {ph,pool,wd,lb} (表示状態も保存する場合)。
  function buildWorkCsv(payload, opts) {
    opts = opts || {};
    const field = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const wv = payload.wv || [];
    const W = wv.reduce((m, w) => Math.max(m, w), 0) + 1;
    const viewStr = opts.view
      ? buildFragment(opts.view, 'x').slice(1).replace(/&d=x$/, '')
      : '';
    const lines = ['seed,name,uid,pool,pools,waves,event,phases,wv,view'];
    payload.uids.forEach((uid, i) => {
      const name = opts.nameOf ? (opts.nameOf(i) || '') : ((payload.names || {})[String(i)] || '');
      lines.push([
        i + 1,
        field(name),
        uid != null ? uid : '',
        field(opts.poolLabelOf ? (opts.poolLabelOf(i) || '') : ''),
        i === 0 ? (payload.phases[0].pools) : '',
        i === 0 ? W : '',
        i === 0 ? field(payload.ev || '') : '',
        i === 0 ? field(JSON.stringify(payload.phases)) : '',
        i === 0 ? field(JSON.stringify(wv)) : '',
        i === 0 ? field(viewStr) : '',
      ].join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  const API = {
    encodePayload, decodePayload, validatePayload, validatePhases, phaseEntrantCounts, withFinalPhase,
    versionSource, payloadVersion,
    parseFragment, buildFragment,
    chunkWaveMap, waveLetter, poolLabel,
    parseCsv, workCsvToPayload, buildWorkCsv,
    // テスト用の下位 API
    bytesToBase64url, base64urlToBytes, deflateRawBytes, inflateRawBytes,
  };
  global.SeedShare = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
