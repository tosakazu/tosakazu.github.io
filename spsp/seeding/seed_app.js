// seed_app.js — SPSP シードツール本体 (seed / seed-upload 両ページ共通)。
// ページ側で SEED_APP_CONFIG (= { mode: 'spsp' | 'csv' }) を定義してから本スクリプトを
// 読み込む。mode 'csv' は基準順位ソースとして CSV / Google Sheets を読み込み、
// 手動調整の base に取り込む。それ以外の機能 = フェーズ自動作成 (プール数指定) /
// 被り回避最適化 / 手動調整 / CSV ダウンロード / start.gg 適用 はモード共通。
// 元は site/seed/index.html のインライン本体 HTML + <script> 群 (スタイルは seed_app.css)。
'use strict';

// ── ページスケルトン (本体 HTML)。ページには <div id="seed-app-root"></div> だけ置く ──
const SEED_APP_SKELETON_HTML = `
<div class="header">
  <h1>シード生成</h1>
  <p class="subtitle">start.gg 大会の参加者を SPSP の総合評価順に並べ替え。CSV ダウンロード or 直接 start.gg に反映。</p>

  <div class="upcoming-box open" id="upcoming-box">
    <div class="upcoming-toggle" id="upcoming-toggle">
      <span class="chev">▶</span>
      <span>直近の大会から選ぶ</span>
      <span class="badge" id="upcoming-count" style="display:none">0</span>
      <span style="color:#9ca3af;font-weight:400;font-size:11px;margin-left:auto">日本 / 3週間以内</span>
    </div>
    <div class="upcoming-body" id="upcoming-body">
      <div class="upcoming-loading" id="upcoming-loading">読み込み中…</div>
      <div class="upcoming-pager" id="upcoming-pager" style="display:none">
        <button type="button" id="upcoming-prev">‹ 前へ</button>
        <span id="upcoming-pageinfo">1 / 1</span>
        <button type="button" id="upcoming-next">次へ ›</button>
      </div>
      <div class="upcoming-list" id="upcoming-list" style="display:none"></div>
    </div>
  </div>

  <form id="seed-form" style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">
        <label for="token" style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">
          start.gg API Token
          <a href="https://start.gg/admin/profile/developer" target="_blank" rel="noopener" style="color:#dc2626;margin-left:6px;font-size:10px;text-decoration:underline">API キー取得→</a>
        </label>
        <div style="display:flex;gap:4px;align-items:stretch">
          <input type="password" id="token" placeholder="xxxxxxxxxxxxxxxxxxxx" autocomplete="off"
            style="flex:1;min-width:0;padding:8px 12px;background:#f9fafb;color:#111827;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;font-family:inherit">
          <button type="button" id="token-reveal" title="表示/隠す"
            style="background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;border-radius:6px;padding:0 10px;font-size:14px;cursor:pointer;font-family:inherit">👁</button>
          <button type="button" id="token-save" title="ブラウザに保存"
            style="background:#dc2626;color:#fff;border:none;border-radius:6px;padding:0 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">💾 保存</button>
        </div>
        <div id="token-hint" style="font-size:10px;color:#9ca3af;margin-top:3px;height:14px"></div>
      </div>
      <div style="flex:2;min-width:280px">
        <label for="event-url" style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">大会イベント URL</label>
        <input type="text" id="event-url" placeholder="https://www.start.gg/tournament/15-kagaribi-15/event/singles"
          style="width:100%;padding:8px 12px;background:#f9fafb;color:#111827;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;font-family:inherit">
        <div id="event-url-help" style="font-size:10px;color:#9ca3af;margin-top:3px">URL に <code>/event/...</code> が含まれていることを確認</div>
      </div>
      <div style="display:flex;align-items:flex-end;padding-bottom:14px">
        <button type="submit" id="fetch-btn" style="background:#dc2626;color:#fff;border:none;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">参加者を取得</button>
      </div>
    </div>
    <div id="phase-row" style="display:none">
      <label for="phase-select" style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">フェーズ</label>
      <select id="phase-select" style="width:100%;padding:8px 12px;background:#f9fafb;color:#111827;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;font-family:inherit"></select>
    </div>
    <!-- phase 未作成 event 用: シード適用時に自動作成する phase の設定 -->
    <div id="phase-create-row" style="display:none;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 12px">
      <div style="font-size:11px;color:#92400e;font-weight:600;margin-bottom:6px">⚠ ブラケット未作成 — シード適用時に Double Elimination の phase を自動作成します</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <label for="pc-group-count" style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">プール数</label>
          <input type="number" id="pc-group-count" value="1" min="1" max="128" step="1"
            style="width:72px;padding:7px 10px;background:#f9fafb;color:#111827;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;font-family:inherit">
        </div>
        <div>
          <label for="pc-phase-name" style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">phase 名</label>
          <input type="text" id="pc-phase-name" value="Bracket" maxlength="80"
            style="width:140px;padding:7px 10px;background:#f9fafb;color:#111827;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;font-family:inherit">
        </div>
      </div>
    </div>
  </form>

  <div id="event-picker">
    <div class="label">この大会には SSBU シングルス event が複数あります。どれを使いますか?</div>
    <div class="pe-list" id="event-picker-list"></div>
  </div>

  <div class="method-tabs" id="method-tabs" style="display:none">
    <div class="method-tab active" data-method="ensemble">
      総合評価<span class="tab-desc">推奨</span>
    </div>
    <div class="method-tab" data-method="tjpr">
      順位評価<span class="tab-desc">大会順位ベースのランキング</span>
    </div>
    <div class="method-tab" data-method="bt_gated">
      直対評価<span class="tab-desc">直接対決ベースのランキング</span>
    </div>
  </div>

  <div class="controls">
    <input type="search" id="search" placeholder="プレイヤー名 / UID で検索…" autocomplete="off" style="display:none">
    <button id="csv-btn" disabled style="background:#16a34a;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:none">CSV ダウンロード</button>
    <button id="upload-btn" disabled style="background:#b91c1c;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:none">start.gg にシード適用</button>
    <span class="status" id="status">大会 URL を入力して「参加者を取得」を押してください</span>
  </div>
  <div id="error-help" style="display:none;margin-top:8px"></div>
</div>

<!-- 🔀 被り回避最適化パネル -->
<div id="seedopt-panel" style="display:none;max-width:1400px;margin:14px auto 0;padding:12px 24px">
  <details style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;background:#fafafa">
    <summary style="cursor:pointer;list-style:revert">
      <strong style="font-size:14px;color:#111827">🔀 被り回避最適化</strong>
      <span style="font-size:11px;color:#6b7280">地域被り（都道府県）と直近再対戦を避けるようシード順を最適化します。</span>
    </summary>
    <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-top:10px">
      <label style="font-size:11px;color:#6b7280">プール数
        <input type="number" id="so-pools" value="1" min="1" max="128" step="1"
          style="display:block;width:80px;padding:5px 6px;border:1px solid #d1d5db;border-radius:5px;font-size:13px">
      </label>
      <label style="font-size:11px;color:#6b7280" title="ウェーブ = 連続するプールの塊 (A,B,C,… の連番アルファベット)。ウェーブ指定・ウェーブ固定の判定に使う。start.gg のプール名 (A1,B2,…) から自動取得できたときは自動で入る。手動で上書き可">ウェーブ数
        <input type="number" id="so-waves" value="1" min="1" max="26" step="1"
          style="display:block;width:80px;padding:5px 6px;border:1px solid #d1d5db;border-radius:5px;font-size:13px">
      </label>
      <span id="so-waves-label" style="font-size:11px;color:#9ca3af"></span>
      <span id="so-format-label" style="font-size:11px;color:#9ca3af"></span>
      <button id="so-run" style="background:#2563eb;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">最適化を実行</button>
      <button id="so-stop" disabled style="background:#6b7280;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:none">中断して結果を反映</button>
      <button id="so-cancel" title="最適化を無かったことにして、実行する直前の並びとレポート表示に戻します" style="background:#fff;color:#374151;border:1px solid #d1d5db;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:none">最適化を取り消す</button>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:12px;color:#374151">
      <label title="2プール以上のとき、プール内の当たり回戦も最適化する（プレイヤーのプール内順位を少し動かす）。1プールでは常に実行＝指定不可"><input type="checkbox" id="so-enable-intra" checked> プール内変動</label>
      <label title="地域被り（同じ都道府県/地域の選手が同じプール・早期回戦に固まる）を考慮して分散する"><input type="checkbox" id="so-avoid-region" checked> 地域被りを考慮</label>
      <label title="直近に対戦した相手と再び早期に当たるのを考慮して避ける"><input type="checkbox" id="so-avoid-recent" checked> 直接対戦を考慮</label>
      <label title="全員のトーナメント想定順位（1,2,3,4,5,5,7,7,9,9,9,9,…のタイ帯）が元シードから変わらない範囲でのみ入れ替える"><input type="checkbox" id="so-keep-deplace" checked> トーナメント順位固定</label>
      <label title="通常のプール最適化（プール間/内）に加えて、全体を1つの勝者側ダブルイリミブラケットとみなし「シード通り勝ち上がったときに実際に発生する試合」の被りも追加で最適化する。追加フェーズはタイ帯（DE想定順位）内で動き、プール分離を壊す移動は損として評価される。このモード中は全フェーズでDE想定順位不変がハード制約。1プールでは勝者側のみ。DE専用"><input type="checkbox" id="so-scope-winners" checked> 勝者側ブラケットも考慮</label>
      <label title="平日扱いの大会（平日開催・実質平日・プレ大会）での対戦も「直接対戦」の考慮対象に含める（既定は含めない）"><input type="checkbox" id="so-include-weekday"> 平日大会を含む</label>
      <label title="東京・神奈川・埼玉・千葉を同一地域(南関東)として扱う"><input type="checkbox" id="so-group-minamikanto" checked> 東京・神奈川・埼玉・千葉をまとめる</label>
      <label title="兵庫・大阪・京都を同一地域(京阪神)として扱う"><input type="checkbox" id="so-group-keihanshin"> 兵庫・大阪・京都をまとめる</label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:12px;color:#374151">
      <span id="so-shiftlimit-label" style="font-weight:600">シードズレ上限:</span>
      <label>固定(±0)は <input type="number" id="so-shift0" min="1" style="width:52px"> 位まで</label>
      <label>／ ±1は <input type="number" id="so-shift1" min="1" style="width:52px"> 位まで</label>
      <label>／ ±2は <input type="number" id="so-shift2" min="1" style="width:52px"> 位まで</label>
      <label>／ ±3は <input type="number" id="so-shift3" min="1" style="width:52px"> 位まで</label>
      <label>／ ±4は <input type="number" id="so-shift4" min="1" style="width:52px"> 位まで</label>
      <label>／ 全順位で最大 ±<input type="number" id="so-maxshift" min="0" step="1" placeholder="なし" style="width:56px"></label>
      <span style="color:#9ca3af;font-size:10px">（段階指定を超えた順位は無制限。全て空欄=制約なし。空のまま大会を読み込むと規模別の既定値が入る）</span>
    </div>
    <div style="margin-top:10px;font-size:12px;color:#374151;max-width:360px">
      <div style="display:flex;align-items:center;gap:8px">
        <span id="so-orderpow-label" style="font-weight:600" title="元順位からのシードズレ罰則の強さ。左ほどズレの大きさを許容して大きく動かし、右ほど大きなズレを強く罰して小さく動かす。0 = ズレを罰しない">ズレ抑制</span>
        <span id="so-orderpow-val" style="font-variant-numeric:tabular-nums;font-weight:700;font-size:11px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;padding:1px 10px;min-width:34px;text-align:center">2</span>
      </div>
      <input type="range" id="so-orderpow" min="0" max="5" step="0.5" value="2" style="display:block;width:100%;margin:8px 0 3px;accent-color:#dc2626">
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#9ca3af">
        <span>大きく動かす</span><span>小さく動かす</span>
      </div>
    </div>
    <div style="margin-top:8px">
      <details>
        <summary style="font-size:11px;color:#6b7280;cursor:pointer">上級者向けパラメータ（全ハイパラ編集可・空欄＝既定）</summary>
        <div style="margin-top:8px;font-size:11px;color:#6b7280">
          <div style="font-weight:600;color:#374151;margin:6px 0 2px">探索</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <label>モード
              <select id="so-mode" style="display:block;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px">
                <option value="multistart-sa">多点スタート焼きなまし（既定）</option>
                <option value="multistart-hillclimb">多点スタート山登り</option>
                <option value="sa">焼きなまし</option>
                <option value="hillclimb">山登り</option>
              </select>
            </label>
            <label>多点数<input type="number" id="so-restarts" value="15" min="1" max="100" style="display:block;width:64px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label>SA冷却率<input type="number" id="so-cooling" value="0.999" step="0.001" min="0.5" max="0.9999" style="display:block;width:72px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label title="反復回数 = max(500, 状態数×この値)。大きいほど高精度・低速">反復係数<input type="number" id="so-itersscale" value="1000" min="10" max="2000" step="10" style="display:block;width:72px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label>乱数シード<input type="number" id="so-rngseed" value="12345" style="display:block;width:84px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
          </div>
          <div style="font-weight:600;color:#374151;margin:8px 0 2px">罰則の重み</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <label>地域重み W_region<input type="number" id="so-wregion" value="1.0" step="0.1" style="display:block;width:72px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label>直近重み W_recent<input type="number" id="so-wrecent" value="0.3" step="0.05" style="display:block;width:72px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label title="元ランキングからのシードズレ罰則の重み(0で無効)">元順位ズレ重み<input type="number" id="so-worder" value="0.001" step="0.005" min="0" style="display:block;width:80px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label>県の重み式
              <select id="so-prefweight" style="display:block;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px">
                <option value="inv_sqrt">1/√人数（既定）</option>
                <option value="inv">1/人数</option>
                <option value="inv_log">1/log2(1+人数)</option>
                <option value="const">一定</option>
              </select>
            </label>
          </div>
          <div style="font-weight:600;color:#374151;margin:8px 0 2px">直近対戦の時間減衰（日:重み の制御点・折れ線, 最後の点より後は0）</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <label title="日:重み をカンマ区切り。例 0:1,30:1,91:0.5,182.5:0.25,365:0">減衰点<input type="text" id="so-decaypoints" placeholder="0:1,30:1,91:0.5,182.5:0.25,365:0" style="display:block;width:300px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label>大会規模重み式
              <select id="so-sizeweight" style="display:block;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px">
                <option value="log2">log2(参加人数)（既定）</option>
                <option value="sqrt">√参加人数</option>
                <option value="linear">参加人数</option>
              </select>
            </label>
            <label title="同じ2人の複数対戦の罰則のまとめ方。max=最重1試合(回数に依らず)、sum=合算(常連ほど強く分離)">ペア内集計
              <select id="so-recentagg" style="display:block;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px">
                <option value="max">max（最重1試合・既定）</option>
                <option value="sum">sum（全対戦を合算）</option>
              </select>
            </label>
          </div>
          <div style="font-weight:600;color:#374151;margin:8px 0 2px">プール内・可動制約（CSV / 空欄＝既定）</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <label>回戦重み<input type="text" id="so-roundweights" placeholder="1,0.6,0.4,0.06,0.02" style="display:block;width:160px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label title="プール内順位ごとに動かせるプール数。空欄＝既定(1・2位固定、以降1,2,4,8,…と倍々)">プール間可動 k_inter<input type="text" id="so-kinter" placeholder="既定: 0,0,1,2,4,…" style="display:block;width:160px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
            <label title="プール内順位ごとに動かせる順位数。空欄＝既定(上位1/4固定・残り±1。プール間移動した選手も同じ窓)">プール内可動 k_intra<input type="text" id="so-kintra" placeholder="既定: 上位1/4固定・残り±1" style="display:block;width:160px;padding:4px;border:1px solid #d1d5db;border-radius:5px;font-size:12px"></label>
          </div>
        </div>
      </details>
    </div>
    <div id="so-progress" style="margin-top:10px;font-size:12px;color:#374151"></div>
    <div id="so-report" style="margin-top:10px;font-size:12px;color:#374151"></div>
  </details>
</div>

<!-- 📌 シード指定・固定パネル: CSV で一部プレイヤーの順位/ウェーブ指定 + プール/ウェーブ固定 -->
<div id="spec-panel" style="display:none;max-width:1400px;margin:10px auto 0;padding:0 24px">
  <details style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;background:#fafafa">
    <summary style="cursor:pointer;list-style:revert">
      <strong style="font-size:13px;color:#111827">📌 シード指定・固定 (CSV)</strong>
      <span style="font-size:11px;color:#6b7280">一部プレイヤーの順位/ウェーブを CSV で指定し、プール/ウェーブを固定できます。</span>
    </summary>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px">
      <input type="text" id="spec-src-url" placeholder="Google Sheets URL または CSV URL" style="flex:1;min-width:220px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:6px;font-size:12px">
      <span style="font-size:11px;color:#6b7280">or</span>
      <input type="file" id="spec-src-file" accept=".csv,text/csv" style="font-size:11px">
      <button id="spec-src-load" style="background:#2563eb;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">読み込み</button>
      <button id="spec-tpl" style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer">テンプレート</button>
      <button id="spec-clear" style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer">指定・固定をクリア</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:5px;line-height:1.6">
      プレイヤー列 (<b>uid</b> / <b>discriminator</b> / <b>seedId</b> / <b>name</b>) で参加者と照合し、指定列のある行だけ適用します:
      <b>seed</b> (そのシード番号に配置) ／ <b>wave</b> (A,B,… または 1,2,… — そのウェーブのプールに配置) ／
      <b>lock</b> (pool / wave — 指定した枠から動かさない)。
      順位・ウェーブ指定は現在の並びを基準に組み直し、手動調整として取り込みます (後から行移動で微修正可)。
      <b>「作業状況を保存」で書き出した CSV もここから読み込めます</b> — シード順・固定・プール数/ウェーブ数が
      そのまま復元されるので、作業の再開や他の人との共有に使えます。
    </div>
    <div id="spec-status" style="font-size:11px;color:#374151;margin-top:5px;line-height:1.6"></div>
  </details>
</div>

<!-- 作業状況の保存 (現在のシード順 + 固定を CSV に。読み込みは 📌 パネル側) -->
<div id="work-bar" style="display:none;margin:10px 0 0">
  <button id="spec-export" style="background:#16a34a;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">作業状況を保存 (CSV)</button>
  <button id="bracket-preview" title="現在のシード順 (被り回避を実行済みならその結果) で組んだトーナメントを別ページでプレビューします。URL を共有すれば同じ画面が開けます" style="background:#7c3aed;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;margin-left:6px">トーナメントプレビュー</button>
  <span id="work-note" style="font-size:11px;color:#6b7280;margin-left:8px"></span>
</div>

<!-- 手動調整モード: ロック解除で通常のランキング表のまま並べ替えできる (自動保存/undo/redo) -->
<div id="manual-bar" style="display:none;margin:10px 0 6px"></div>

<div class="table-wrap">
  <table id="ranktable">
    <!-- thead は SPSPRankingTable コンポーネントが自動生成 -->
    <tbody id="tbody">
      <tr><td colspan="9" class="empty-msg">大会 URL を入力して「参加者を取得」を押すとここにランキングが表示されます</td></tr>
    </tbody>
  </table>
</div>

<div style="max-width:1400px;margin:24px auto 0;padding:0 24px;font-size:11px;color:#9ca3af;line-height:1.6">
  🔒 入力した API トークンはこのブラウザから start.gg にのみ送信されます。GitHub Pages 側には何も保存・転送されません。
  「💾 保存」を押した場合のみ localStorage に永続保存します (タップで取り消し可能)。
</div>`;

const SEED_APP_CONFIG = Object.assign({ mode: 'spsp' }, window.SEED_APP_CONFIG || {});
(function mountSeedAppSkeleton() {
  const root = document.getElementById('seed-app-root');
  if (!root) throw new Error('seed_app: #seed-app-root がありません');
  root.innerHTML = SEED_APP_SKELETON_HTML;
  // csv モード: ページ名・説明をシードアップロード用に差し替え
  if (SEED_APP_CONFIG.mode === 'csv') {
    const h1 = root.querySelector('.header h1');
    if (h1) h1.textContent = 'シードアップロード';
    const sub = root.querySelector('.header .subtitle');
    if (sub) sub.textContent = 'CSV / Google Sheets の順位を基準に start.gg のシードを作成。手動調整・被り回避最適化・フェーズ自動作成・CSV ダウンロード対応。';
    // 「参加者を取得」ボタンは不要 (適用時に URL から seedId を自動取得する)。
    const fb = root.querySelector('#fetch-btn');
    if (fb) fb.style.display = 'none';
    const urlHelp = root.querySelector('#event-url-help');
    if (urlHelp) urlHelp.style.display = 'none';
    // 「参加者を取得」前提の案内文も CSV 向けに差し替え
    const st = root.querySelector('#status');
    if (st) st.textContent = 'CSV / Google Sheets を読み込んでください';
    const emptyMsg = root.querySelector('#ranktable .empty-msg');
    if (emptyMsg) emptyMsg.textContent = 'CSV / Google Sheets を読み込むとここにリストが表示されます';
  }
  // csv モード: 基準順位ソース (CSV / Sheets) の入力欄を差し込む
  if (SEED_APP_CONFIG.mode === 'csv') {
    const anchorEl = root.querySelector('#event-picker');
    const div = document.createElement('div');
    div.id = 'csv-source-row';
    div.style.cssText = 'background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 12px;margin-top:10px';
    div.innerHTML = '<div style="font-size:12px;font-weight:600;color:#1e40af;margin-bottom:6px">📄 基準順位ソース (CSV / Google Sheets)</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">'
      + '<input type="text" id="csv-src-url" placeholder="Google Sheets URL または CSV URL" style="flex:1;min-width:220px;padding:8px 10px;border:1px solid #e5e7eb;border-radius:6px;font-size:12px">'
      + '<span style="font-size:11px;color:#6b7280">or</span>'
      + '<input type="file" id="csv-src-file" accept=".csv,text/csv" style="font-size:11px">'
      + '<button id="csv-src-load" style="background:#2563eb;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">読み込み</button>'
      + '<button id="csv-tpl" style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db;padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer">テンプレート</button>'
      + '</div>'
      + '<div id="csv-src-status" style="font-size:11px;color:#6b7280;margin-top:5px;line-height:1.5">'
      + '列は uid / discriminator / seedId / name のいずれかで参加者と照合します (順序は seed 列があればその昇順、無ければ行順)。'
      + '参加者取得済みなら読み込み時に基準へ反映、未取得なら取得後に自動反映されます。</div>';
    anchorEl.parentNode.insertBefore(div, anchorEl);
  }
})();

// ── ヘルプアイコン (?) ────────────────────────────────────────────────
// オプションやボタンの意味を、マウスオーバーでもタップでも読めるようにする。
// title 属性はホバーでしか出ず、スマホでは読めないので独自ポップに置き換える。
//
// 説明文は HELP_TEXT を優先し、無ければ既存の title 属性を流用する
// (= 既に title を書いてある要素は id を並べるだけでアイコンが付く)。
// アイコンを付けた要素の title は消す (ネイティブのツールチップと二重に出さない)。
const HELP_TEXT = {
  // ── 取得まわり ──
  'token': 'start.gg の API トークン。参加者の取得と、start.gg へのシード適用に使います。'
    + 'このブラウザから start.gg にのみ送信され、SPSP 側には保存も転送もされません。',
  'event-url': '対象イベントの start.gg URL。大会ページではなく、シングルス等の'
    + '「イベント」の URL を入れてください (例: .../tournament/xxx/event/singles)。',
  'fetch-btn': '入力した URL の参加者を start.gg から取得し、SPSP のランキング順に並べます。ここが出発点です。',
  'phase-select': 'シードを適用するフェーズ。プール分けのあるイベントでは、'
    + 'どのフェーズのシードを触るかをここで選びます。',
  'pc-group-count': '新しく作るフェーズのプール数。',
  'pc-phase-name': 'start.gg 上に作られるフェーズの名前。',

  // ── 出力 ──
  'csv-btn': '今の並びを CSV でダウンロードします。start.gg の一括インポートや、'
    + '他のツールへの受け渡しに使えます。',
  'upload-btn': '⚠️ 今の並びを start.gg の本番シードとして書き込みます (取り消しは start.gg 側で行ってください)。'
    + '被り回避を実行済みならその結果、手動調整をしていればそれも含めた最終的な並びが適用されます。',
  'spec-export': '今のシード順・固定・プール数/ウェーブ数を CSV に保存します。'
    + '📌 パネルから読み込めば、この状態から作業を再開できます。他の人との共有にも使えます。',
  'bracket-preview': '今のシード順で組んだトーナメント表を別ページで開きます。'
    + 'URL を共有すれば同じ画面を見せられます。'
    + 'なお start.gg の設定によっては実際のブラケットと食い違うことがあります (プレビュー側に詳細)。',

  // ── 被り回避 ──
  'so-pools': 'このフェーズをいくつのプールに分けるか。start.gg から取得できたときは自動で入ります。'
    + '1 なら 1 本のブラケットとして扱います。',
  'so-run': '設定した条件で、地域被りと再対戦を避けるようシード順を探索します。'
    + '完了すると自動で反映され、CSV・start.gg 適用・トーナメントプレビューにも同じ並びが使われます。',
  'so-stop': '探索を途中で打ち切り、その時点で見つかっている最良の並びを反映します。',
  'so-orderpow-label': '元のランキング順からどれだけズラしてよいか。'
    + '左に寄せるほど被り回避を優先して大きく動かし、右に寄せるほど元の順位を尊重して小さく動かします。',
  'so-mode': '探索アルゴリズム。通常は既定のままで構いません。',
  'so-shiftlimit-label': '元のランキング順から各選手が動いてよいシード数の上限を、順位帯ごとに決めます。'
    + '各欄は「そのズレ幅までしか許さないのは何位まで」。'
    + '例) ±1に8・±2に16・±3に32 と入れると、1〜8位は±1、9〜16位は±2、17〜32位は±3、33位以降は無制限。'
    + '左の欄ほど小さい順位にしてください。全て空欄なら順位帯の制限なしです。'
    + '空のまま大会を読み込むと、参加人数に応じた既定値が入ります。',
  'so-maxshift': '順位帯に関係なく、全員に効くシードズレの上限。'
    + '左の順位帯ごとの指定と併用したときは、厳しい方が効きます。空欄なら全体上限なし。'
    + '0 を入れると誰も動かなくなります。'
    + '（プール数が多いと、プール間±1 とプール内±1 の合成でシード番号は最大 2×プール数−1 動き得ます。'
    + 'それを番号で直接抑えたいとき用です）',

  // ── 表示・操作 ──
  'search': 'プレイヤー名か start.gg の user_id で絞り込みます。',
};

// アイコンを付ける対象。ここに id を並べるだけで付く。
const HELP_TARGETS = [
  'token', 'event-url', 'fetch-btn', 'phase-select', 'pc-group-count', 'pc-phase-name',
  'csv-btn', 'upload-btn', 'spec-export', 'bracket-preview',
  'so-pools', 'so-waves', 'so-run', 'so-stop', 'so-cancel',
  'so-enable-intra', 'so-avoid-region', 'so-avoid-recent', 'so-keep-deplace',
  'so-scope-winners', 'so-include-weekday', 'so-group-minamikanto', 'so-group-keihanshin',
  'so-orderpow-label', 'so-shiftlimit-label', 'so-maxshift',
  'so-mode', 'so-itersscale', 'so-worder', 'so-decaypoints',
  'so-kinter', 'so-kintra',
];

function injectHelpIcons(root) {
  for (const id of HELP_TARGETS) {
    const el = root.querySelector('#' + id);
    if (!el) continue;
    // 説明の持ち主: 外付け <label for>, 囲っている <label>, なければ要素自身。
    const outerLabel = root.querySelector('label[for="' + id + '"]');
    const wrapLabel = el.closest('label');
    const host = outerLabel || wrapLabel || el;
    const text = HELP_TEXT[id] || host.getAttribute('title') || el.getAttribute('title');
    if (!text) continue;
    host.removeAttribute('title');
    el.removeAttribute('title');
    const ico = document.createElement('button');
    ico.type = 'button';
    ico.className = 'help-ico';
    ico.textContent = '?';
    ico.dataset.help = text;
    ico.setAttribute('aria-label', '説明を表示');
    ico.setAttribute('aria-expanded', 'false');
    // 置き場所は「ラベル文字の直後」。
    //   外付け label      → その末尾 (入力は別行なので末尾 = 文字の直後)
    //   囲い label + チェック → 末尾 (<input> テキスト の順で並ぶため)
    //   囲い label + それ以外 → 入力の**前** (テキスト <input display:block> の順なので、
    //                            末尾に置くと入力の下に落ちてしまう)
    //   label 無し        → 要素の直後
    const isCheck = el.type === 'checkbox' || el.type === 'radio';
    if (outerLabel) outerLabel.appendChild(ico);
    else if (wrapLabel && isCheck) wrapLabel.appendChild(ico);
    else if (wrapLabel) wrapLabel.insertBefore(ico, el);
    else el.parentNode.insertBefore(ico, el.nextSibling);
    // 対象が隠れているときはアイコンも隠す (ボタンは処理の進み具合で出し入れされる)
    bindHelpVisibility(ico, el);
  }
}

// 対象要素の表示/非表示にアイコンを追従させる。
// アイコンは対象の兄弟なので、祖先が隠れれば一緒に隠れる。自分自身の
// display:none / hidden だけを見ればよい。
const HELP_VIS_OBS = (typeof MutationObserver !== 'undefined')
  ? new MutationObserver((records) => {
      for (const r of records) syncHelpVisibility(r.target);
    })
  : null;
const HELP_ICO_BY_TARGET = new WeakMap();

function isElementHidden(el) {
  if (el.hidden) return true;
  if (el.style && el.style.display === 'none') return true;
  try {
    const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    if (cs && cs.display === 'none') return true;
  } catch (e) { /* 計算できない環境では inline 指定のみで判断 */ }
  return false;
}

function syncHelpVisibility(target) {
  const ico = HELP_ICO_BY_TARGET.get(target);
  if (!ico) return;
  const hide = isElementHidden(target);
  ico.hidden = hide;
  if (hide && HELP_OPEN_ICO === ico) hideHelp();
}

function bindHelpVisibility(ico, target) {
  HELP_ICO_BY_TARGET.set(target, ico);
  syncHelpVisibility(target);
  if (HELP_VIS_OBS) {
    HELP_VIS_OBS.observe(target, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
  }
}

// ポップは 1 つを使い回す (開くたびに DOM を作らない)。
let HELP_POP = null;
let HELP_OPEN_ICO = null;

function helpPopEl() {
  if (!HELP_POP) {
    HELP_POP = document.createElement('div');
    HELP_POP.className = 'help-pop';
    HELP_POP.hidden = true;
    HELP_POP.setAttribute('role', 'tooltip');
    document.body.appendChild(HELP_POP);
  }
  return HELP_POP;
}

function showHelp(ico) {
  const pop = helpPopEl();
  pop.textContent = ico.dataset.help || '';
  pop.hidden = false;
  // まず表示してから実寸で位置決めする (幅が確定しないと画面外判定ができない)
  const r = ico.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  // 下に入らなければ上に出す
  let top = r.bottom + 6;
  if (top + pr.height > window.innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
  if (HELP_OPEN_ICO && HELP_OPEN_ICO !== ico) HELP_OPEN_ICO.setAttribute('aria-expanded', 'false');
  ico.setAttribute('aria-expanded', 'true');
  HELP_OPEN_ICO = ico;
}

function hideHelp() {
  if (HELP_POP) HELP_POP.hidden = true;
  if (HELP_OPEN_ICO) {
    HELP_OPEN_ICO.setAttribute('aria-expanded', 'false');
    delete HELP_OPEN_ICO.dataset.pinned;
  }
  HELP_OPEN_ICO = null;
}

document.addEventListener('click', (e) => {
  const ico = e.target.closest && e.target.closest('.help-ico');
  if (ico) {
    // label の中に置くので、そのままだとチェックボックスが反応してしまう
    e.preventDefault();
    e.stopPropagation();
    if (HELP_OPEN_ICO === ico && ico.dataset.pinned === '1') {
      hideHelp();
    } else {
      showHelp(ico);
      ico.dataset.pinned = '1';
    }
    return;
  }
  if (!e.target.closest || !e.target.closest('.help-pop')) hideHelp();
}, true);

document.addEventListener('mouseover', (e) => {
  const ico = e.target.closest && e.target.closest('.help-ico');
  if (ico && ico !== HELP_OPEN_ICO) showHelp(ico);
});
document.addEventListener('mouseout', (e) => {
  const ico = e.target.closest && e.target.closest('.help-ico');
  // クリックで開いたものはホバーが外れても閉じない
  if (ico && ico === HELP_OPEN_ICO && ico.dataset.pinned !== '1') hideHelp();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHelp(); });
window.addEventListener('resize', hideHelp);
window.addEventListener('scroll', hideHelp, true);

injectHelpIcons(document.getElementById('seed-app-root'));

// ── Chart.js (lazy load on first graph use) ──
let CHART_LOADED = false;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
async function ensureChartJs() {
  if (CHART_LOADED) return;
  await loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/luxon@3.4.4/build/global/luxon.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/chartjs-adapter-luxon@1.3.1/dist/chartjs-adapter-luxon.umd.min.js');
  CHART_LOADED = true;
}

// ── 本体 ──

const DATA = [];
let META = null;
let currentMethod = 'ensemble';
let filterText = '';

// MASTER は (uid → record) Map にキャッシュ
let MASTER_MAP = null;
let MASTER_META = null;
// 複数 start.gg アカウント統合表 (old uid → 正規 uid)。site/data/user_merges.json
// (= build/user_merges.py から生成) を loadMasterData で取得。旧アカウントで
// エントリーされてもランキング参照・再対戦履歴が正規 uid で引けるようにする。
let USER_MERGES_MAP = null;

// start.gg から取った user_id を正規 uid に変換 (統合対象でなければそのまま)。
function canonicalUserId(uid) {
  if (uid == null || !USER_MERGES_MAP) return uid;
  const c = USER_MERGES_MAP.get(uid);
  return c != null ? c : uid;
}
// 直近フェッチした event 情報 (phaseId, eventName, entrant list, etc.)
let EVENT_CONTEXT = null;
// 被り回避最適化のシード順 (= uid 配列)。null なら currentMethod 順。
// 最適化が完了した時点で自動的にここへ入る (= 実行したら反映される)。
// CSV / start.gg 適用 / トーナメントプレビューはすべてこれを見る。
let APPLIED_ORDER = null;
// 「最適化を取り消す」で戻る状態。最適化を反映する直前に取る。
let PRE_OPT = null;   // { order: [uid], manual: MANUAL の複製 | null }

// CSV / start.gg 適用で使うシード出力順。優先度: 被り回避適用 > 手動調整 > currentMethod 順。
// 手動調整は編集中でも現在の並びを出力に使う (確定は「編集を終える」の意味)。
function orderedRecs() {
  if (APPLIED_ORDER) {
    const pos = new Map(APPLIED_ORDER.map((u, i) => [u, i]));
    return DATA.slice().sort((a, b) =>
      (pos.has(a.user_id) ? pos.get(a.user_id) : 1e9) - (pos.has(b.user_id) ? pos.get(b.user_id) : 1e9));
  }
  if (MANUAL) {
    const pos = new Map(manualOrder().map((u, i) => [u, i]));
    return DATA.slice().sort((a, b) =>
      (pos.has(a.user_id) ? pos.get(a.user_id) : 1e9) - (pos.has(b.user_id) ? pos.get(b.user_id) : 1e9));
  }
  // 手動調整なし: currentMethod 順 + 固定射影 (固定者は指定プール/ウェーブへ)。
  const base = DATA.slice().sort((a, b) => (a.ranks[currentMethod] || 1e9) - (b.ranks[currentMethod] || 1e9));
  const uids = _projectSeedLocks(base.map(r => r.user_id));
  const pos = new Map(uids.map((u, i) => [u, i]));
  return base.sort((a, b) =>
    (pos.has(a.user_id) ? pos.get(a.user_id) : 1e9) - (pos.has(b.user_id) ? pos.get(b.user_id) : 1e9));
}

// ── 手動調整モード ─────────────────────────────────────────────
// ロックを外すと現在の出力順を基準 (base) に、行の「選択」→挿入位置クリック or
// シード番号直接入力で並べ替えできる。操作は op 履歴 (最大 MANUAL_MAX_OPS 件,
// undo/redo 可、超過分は base に畳み込み) で管理し、localStorage に1件だけ自動保存
// (同一イベント・同一参加者集合なら再訪時に復元)。確定すると orderedRecs / CSV /
// start.gg 適用 / 被り回避最適化の基準ランキングになる。
const MANUAL_LS_KEY = 'spsp_seed_manual_v1';
const MANUAL_MAX_OPS = 100;
let MANUAL = null;   // {base:[uid], ops:[{uid,to}], hpos, committed, editing, sel}
// シード指定・固定 (spec-panel の CSV / 行の📌ボタン)。MANUAL と同じ localStorage に保存。
//   pins:  {uid: seat1}      … 順位指定 (base 組み直しに使用済みの記録)
//   waves: {uid: waveIdx0}   … ウェーブ指定 (同上)
//   locks: {uid: 'pool'|'wave'} … 被り回避最適化のハード制約 (optimizer の seedLocks へ)
let SEED_SPEC = null;   // {label, pins, waves, locks}

function manualEventKey() {
  if (!EVENT_CONTEXT) return null;
  return `${EVENT_CONTEXT.eventId || ''}:${EVENT_CONTEXT.phaseId || ''}`;
}
function manualParseUid(s) { const n = Number(s); return Number.isNaN(n) ? s : n; }
function manualApplyOp(arr, op) {
  const a = arr.slice();
  const i = a.indexOf(op.uid);
  if (i >= 0) {
    a.splice(i, 1);
    a.splice(Math.max(0, Math.min(op.to, a.length)), 0, op.uid);
  }
  return a;
}
// 固定 (SEED_SPEC.locks の対象指定) を並びへ反映する読み取り時射影。
// 手動 op には積まず、manualOrder / orderedRecs / 最適化の基準すべてで常に適用される
// (= 最適化しなくても固定者は指定プール/ウェーブの位置に挿入ソート的に移動する)。
// op 履歴と独立なので undo/redo・固定解除でそのまま元の並びに戻る。冪等。
// uid 配列 → 表示名の列挙 (多いときは先頭 3 人 + 「ほか N 人」)。
function namesOfUids(uids, max = 3) {
  if (!uids || !uids.length) return '';
  const byUid = new Map(DATA.map(r => [r.user_id, r]));
  const names = uids.map(u => {
    const rec = byUid.get(manualParseUid(u));
    return (rec && rec.display) || `uid:${u}`;
  });
  const head = names.slice(0, max).join('、');
  return names.length > max ? `${head} ほか ${names.length - max}人` : head;
}

let _lockProjNotes = [];   // 直近の射影で枠が足りなかった固定の説明 (manualBarHtml で表示)
function _projectSeedLocks(a) {
  _lockProjNotes = [];
  if (!SEED_SPEC || !SEED_SPEC.locks || !Object.keys(SEED_SPEC.locks).length) return a;
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.SeedOptimizer) return a;
  const P = Math.max(1, parseInt((document.getElementById('so-pools') || {}).value, 10) || 1);
  const waveMap = currentWaveMap(P);
  const r = enforceSeedLocks(a, SEED_SPEC.locks, P, waveMap,
    (s, PP) => SeedOptimizer.poolOfSeed(s, PP));
  // 枠不足は「どこが何人分足りないか + 誰が反映されないか」を出す。
  // 枠 0 = 現在のプール数/ウェーブ数にその対象が無い (設定変更や前回の固定が残っている)。
  _lockProjNotes = (r.overflow || []).map((o) => {
    const label = o.kind === 'pool' ? poolLabel(o.target, waveMap) : 'ウェーブ' + waveLetter(o.target);
    const who = namesOfUids(o.dropped);
    if (o.cap === 0) {
      return `${label} は現在の${o.kind === 'pool' ? `プール数 (${P})` : `ウェーブ数 (${waveMap.reduce((m, w) => Math.max(m, w), 0) + 1})`}に無いため、${who} の固定を無視しています`;
    }
    return `${label} は ${o.cap}人分の枠に ${o.want}人を固定。${who} は指定を反映できません`;
  });
  return r.order;
}
function manualOrder() {
  let a = MANUAL.base.slice();
  for (let k = 0; k < MANUAL.hpos; k++) a = manualApplyOp(a, MANUAL.ops[k]);
  return _projectSeedLocks(a);
}
function manualMovedSet() {
  return new Set(MANUAL.ops.slice(0, MANUAL.hpos).map(o => o.uid));
}
function saveManual() {
  try {
    if (!MANUAL && !SEED_SPEC) { localStorage.removeItem(MANUAL_LS_KEY); return; }
    localStorage.setItem(MANUAL_LS_KEY, JSON.stringify({
      eventKey: manualEventKey(),
      base: MANUAL ? MANUAL.base : null, ops: MANUAL ? MANUAL.ops : [],
      hpos: MANUAL ? MANUAL.hpos : 0, committed: MANUAL ? MANUAL.committed : false,
      src: (MANUAL && MANUAL.src) || null,
      spec: SEED_SPEC,   // 指定・固定 (MANUAL と独立に保持)
      ts: Date.now(),
    }));
  } catch (e) { /* 容量超過等は無視 (保存はベストエフォート) */ }
}
// イベント取得後に呼ぶ: 同一イベント & 同一参加者集合なら保存済み手動調整を復元。
function restoreManualForEvent() {
  MANUAL = null;
  SEED_SPEC = null;
  _lockProjNotes = [];   // 前の大会の固定警告を持ち越さない
  try {
    const raw = localStorage.getItem(MANUAL_LS_KEY);
    const key = manualEventKey();
    if (raw && key != null) {   // イベント不明 (key=null) では復元しない (別大会の取り違え防止)
      const s = JSON.parse(raw);
      if (s && s.eventKey === key) {
        const cur = new Set(DATA.map(r => r.user_id));
        if (Array.isArray(s.base) && s.base.length === cur.size && s.base.every(u => cur.has(u))) {
          MANUAL = {
            base: s.base, ops: Array.isArray(s.ops) ? s.ops : [],
            hpos: Math.min(s.hpos || 0, (s.ops || []).length),
            committed: !!s.committed, editing: false, sel: null, src: s.src || null,
          };
        }
        // 指定・固定の復元 (現在の参加者に居る uid の分だけ)。
        if (s.spec && typeof s.spec === 'object') {
          const keep = (obj) => {
            const o = {};
            for (const k in (obj || {})) {
              const u = manualParseUid(k);
              if (cur.has(u)) o[u] = obj[k];
            }
            return o;
          };
          const sp = { label: s.spec.label || null, pins: keep(s.spec.pins),
                       waves: keep(s.spec.waves), locks: keep(s.spec.locks) };
          if (Object.keys(sp.pins).length || Object.keys(sp.waves).length || Object.keys(sp.locks).length) {
            SEED_SPEC = sp;
          }
        }
      }
    }
  } catch (e) { MANUAL = null; SEED_SPEC = null; }
  // 手動調整は既定でオン。復元が無ければ現在の出力順を基準に開いておく
  // (オフにしておく理由が無いので、わざわざ「編集を開始」を押させない)。
  if (!MANUAL && DATA.length) {
    MANUAL = { base: orderedRecs().map((r) => r.user_id), ops: [], hpos: 0,
               committed: false, editing: true, sel: null };
  } else if (MANUAL) {
    MANUAL.editing = true;
    MANUAL.sel = null;
  }
  renderManualUI();
  renderSpecStatus();
  // csv モード: 参加者が揃ったので読み込み済み CSV 順を基準に反映 (復元済み手動調整は優先)。
  if (typeof applyCsvOrderIfReady === 'function') applyCsvOrderIfReady(true);
}
function manualPushOp(uid, to) {
  const cur = manualOrder();
  const from = cur.indexOf(uid);
  if (from < 0) return;
  const t = Math.max(0, Math.min(to, cur.length - 1));
  if (t === from) { MANUAL.sel = null; renderManualUI(); return; }
  MANUAL.ops = MANUAL.ops.slice(0, MANUAL.hpos);
  MANUAL.ops.push({ uid, to: t });
  if (MANUAL.ops.length > MANUAL_MAX_OPS) {   // 古い op は base に畳み込む
    MANUAL.base = manualApplyOp(MANUAL.base, MANUAL.ops[0]);
    MANUAL.ops = MANUAL.ops.slice(1);
  }
  MANUAL.hpos = MANUAL.ops.length;
  MANUAL.sel = null;
  saveManual(); renderManualUI();
}
function manualUnlock() {
  if (!MANUAL) {
    // 初回: 現在の出力順 (被り回避適用済みならその順序) を基準に取り込む。
    MANUAL = { base: orderedRecs().map(r => r.user_id), ops: [], hpos: 0, committed: false, editing: true, sel: null };
  } else {
    // 再編集: MANUAL (op 履歴・undo/redo 位置) をそのまま保持する。
    // 被り回避は「最後に別枠でかける処理」なので base には畳み込まない
    // (適用は解除され、手動調整を確定してから再実行する)。
    MANUAL.editing = true;
    MANUAL.sel = null;
  }
  dropAppliedOrder();
  if (SEEDOPT_RESULT) resetSeedOptResultPanel('手動調整モードに入ったため被り回避の結果をクリアしました。確定後に再実行してください。');
  saveManual(); renderManualUI();
}
function manualCommit() {
  if (!MANUAL) return;
  MANUAL.editing = false;
  MANUAL.committed = true;
  MANUAL.sel = null;
  saveManual(); renderManualUI();
  const st = document.getElementById('status');
  if (st) st.textContent = `✋ 手動調整を確定しました (${manualMovedSet().size}人移動)。CSV / start.gg 適用 / 被り回避最適化はこの順序が基準になります。`;
}
function manualDiscard() {
  if (!MANUAL) return;
  // 必ず確認ダイアログを出す (undo/redo 履歴ごと消える操作なので)。
  if (!confirm('手動調整を破棄して元の順序に戻しますか？\n(移動内容と元に戻す/やり直す履歴、ブラウザ保存も消えます)')) return;
  MANUAL = null;
  saveManual(); renderManualUI();
}
function manualBarHtml() {
  const btn = (mn, label, extra) =>
    `<button data-mn="${mn}" ${extra || ''} style="font-size:11px;padding:3px 10px;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;color:#374151;cursor:pointer">${label}</button>`;
  // 固定の枠不足 / 対象消失。黙って握りつぶさず、その場で解除できるようにする。
  const projWarn = _lockProjNotes.length
    ? `<span style="color:#b91c1c;font-size:11px;font-weight:600">⚠ ${_lockProjNotes.map(escHtml).join(' ／ ')}</span>`
      + `<button data-mn="clear-locks" style="font-size:10px;padding:2px 8px;border:1px solid #fca5a5;border-radius:5px;background:#fff;color:#b91c1c;cursor:pointer">固定を解除</button>`
    : '';
  // プール数 / ウェーブ数 (被り回避パネルの so-pools / so-waves と同じ値。手動列のプール表示と
  // プール/ウェーブ固定の枠がこれで決まるので、パネルを開かずここでも変更できるようにする)。
  const _pv = (id, def) => { const v = parseInt((document.getElementById(id) || {}).value, 10); return Number.isFinite(v) ? v : def; };
  const poolWaveInputs =
    `<span style="font-size:11px;color:#6b7280;white-space:nowrap" title="プール数とウェーブ数 (被り回避最適化パネルと共通の設定)。手動列のプール表示とプール/ウェーブ固定の枠がこれで決まります。ウェーブは連続するプールを A,B,C… の塊に分けたもの">`
    + `プール数 <input type="number" data-mn-pools min="1" max="128" step="1" value="${_pv('so-pools', 1)}" style="width:56px;padding:1px 4px;border:1px solid #d1d5db;border-radius:4px;font-size:11px">`
    + ` ／ ウェーブ数 <input type="number" data-mn-waves min="1" max="26" step="1" value="${_pv('so-waves', 1)}" style="width:52px;padding:1px 4px;border:1px solid #d1d5db;border-radius:4px;font-size:11px">`
    + `</span>`;
  if (!MANUAL) {
    // 破棄した直後などの状態。プール数/ウェーブ数はここでも触れるようにしておく
    // (手動調整と関係なく、プール表示や固定の枠を決める設定なので)。
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
      + `<button data-mn="unlock" style="font-size:12px;padding:5px 12px;border:1px solid #d1d5db;border-radius:6px;background:#f3f4f6;color:#6b7280;cursor:pointer">✏ 手動調整を開始</button>`
      + poolWaveInputs + projWarn + `</div>`;
  }
  const moved = manualMovedSet().size;
  if (MANUAL.editing) {
    const canUndo = MANUAL.hpos > 0, canRedo = MANUAL.hpos < MANUAL.ops.length;
    return `<div style="border:2px solid #fb923c;background:#fff7ed;border-radius:8px;padding:8px 10px;font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
      + `<span style="font-weight:700;color:#ea580c">✋ 手動調整モード</span>`
      + `<span style="color:#9a3412">${moved}人移動</span>`
      + poolWaveInputs
      + projWarn
      // 操作ボタンは次の行に折り返す (flex-basis:100% で改行)。
      + `<div style="flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap">`
      + btn('undo', '↩ 元に戻す', canUndo ? '' : 'disabled')
      + btn('redo', '↪ やり直す', canRedo ? '' : 'disabled')
      + `<button data-mn="commit" style="font-size:11px;padding:3px 12px;border:none;border-radius:6px;background:#16a34a;color:#fff;font-weight:600;cursor:pointer">✅ 確定</button>`
      + btn('discard', '🗑 破棄')
      + `</div>`
      + `</div>`;
  }
  const optNote = APPLIED_ORDER ? '（被り回避を反映中 — 下の表は最適化後の順序）' : '';
  return `<div style="border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;padding:6px 10px;font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
    + `<span style="font-weight:700;color:#b45309">✋ 手動調整 (${moved}人移動${MANUAL.src === 'csv' ? '・基準=CSV順' : (MANUAL.src === 'spec' ? '・基準=シード指定CSV' : '')})</span><span style="color:#9ca3af;font-size:10px">${optNote}</span>`
    + poolWaveInputs
    + projWarn
    // 操作ボタンは次の行に折り返す (flex-basis:100% で改行)。
    + `<div style="flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap">`
    + btn('unlock', moved > 0 ? '✏ 編集を再開' : '✏ 編集を開始') + btn('discard', '🗑 破棄')
    + `</div>`
    + `</div>`;
}
// 「プール/ウェーブ指定」バー (「プール指定」ボタンで対象行の直下に表示)。
// 現在と違うプール/ウェーブを選んで適用すると、その中の最寄り位置へ行を移動 (通常の手動 op =
// undo 可) してから固定する。「固定しない」で解除。
function manualLockBarHtml() {
  const recBy = new Map(DATA.map(r => [r.user_id, r]));
  const rec = recBy.get(MANUAL.lockSel);
  const name = escHtml(rec ? rec.display : String(MANUAL.lockSel));
  const P = Math.max(1, parseInt((document.getElementById('so-pools') || {}).value, 10) || 1);
  const waveMap = currentWaveMap(P);
  const W = waveMap.reduce((m, w) => Math.max(m, w), 0) + 1;
  const cur = manualOrder();
  const pos = cur.indexOf(MANUAL.lockSel);
  const poolOf = (s) => (window.SeedOptimizer ? SeedOptimizer.poolOfSeed(s, P) : 0);
  const curPool = pos >= 0 ? poolOf(pos) : 0;
  const lkRaw = (SEED_SPEC && SEED_SPEC.locks) ? SEED_SPEC.locks[MANUAL.lockSel] : null;
  const lkKind = lkRaw ? (lkRaw.kind || lkRaw) : null;
  const lkTarget = (lkRaw && lkRaw.target != null) ? lkRaw.target : null;
  const kind = MANUAL.lockKind || lkKind || 'pool';
  const selCss = 'padding:2px 6px;border:1px solid #d1d5db;border-radius:5px;font-size:12px;background:#fff';
  const kindSel = `<select data-mn-lock-kind style="${selCss}">`
    + `<option value="none"${kind === 'none' ? ' selected' : ''}>固定しない</option>`
    + `<option value="pool"${kind === 'pool' ? ' selected' : ''}>プール固定</option>`
    + (W >= 2 ? `<option value="wave"${kind === 'wave' ? ' selected' : ''}>ウェーブ固定</option>` : '')
    + `</select>`;
  let targetSel = '';
  if (kind === 'pool') {
    const sel = (kind === lkKind && lkTarget != null) ? lkTarget : curPool;
    targetSel = ` 対象 <select data-mn-lock-target style="${selCss}">` + Array.from({ length: P }, (_, p) =>
      `<option value="${p}"${p === sel ? ' selected' : ''}>${escHtml(poolLabel(p, waveMap))}</option>`).join('') + `</select>`;
  } else if (kind === 'wave') {
    const sel = (kind === lkKind && lkTarget != null) ? lkTarget : waveMap[curPool];
    targetSel = ` 対象 <select data-mn-lock-target style="${selCss}">` + Array.from({ length: W }, (_, w) =>
      `<option value="${w}"${w === sel ? ' selected' : ''}>${escHtml(waveLetter(w))}</option>`).join('') + `</select>`;
  }
  return `<div style="margin-top:6px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:6px 10px;font-size:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">`
    + `<b>${name}</b> のプール/ウェーブ指定: ${kindSel}${targetSel} `
    + `<button data-mn="lock-apply" style="padding:2px 12px;border:none;border-radius:5px;background:#dc2626;color:#fff;font-weight:600;cursor:pointer">適用</button> `
    + `<button data-mn="lock-cancel" style="padding:2px 8px;border:1px solid #d1d5db;border-radius:5px;background:#fff;cursor:pointer">キャンセル</button>`
    + `<span style="color:#9ca3af;font-size:10px;flex-basis:100%">固定した選手は指定プール/ウェーブの位置へ自動で移動し (最適化しなくても常に維持)、被り回避最適化でもそこから動きません。解除すると元の位置付近に戻ります${P < 2 ? '。⚠ プール数が1のため固定は効果がありません' : ''}</span>`
    + `</div>`;
}
// 「移動中」アクションバー (選択中のみ manual-bar 直下に表示)。
function manualActionBarHtml() {
  const recBy = new Map(DATA.map(r => [r.user_id, r]));
  const selRec = recBy.get(MANUAL.sel);
  const n = manualOrder().length;
  return `<div style="margin-top:6px;background:#fff7ed;border:1px solid #fb923c;border-radius:6px;padding:6px 10px;font-size:12px">`
    + `<b>${escHtml(selRec ? selRec.display : String(MANUAL.sel))}</b> を移動中 — 表の行間の「▾ ここに挿入」をクリック、またはシード番号 `
    + `<input type="number" data-mn-input min="1" max="${n}" style="width:64px;padding:2px 4px;border:1px solid #d1d5db;border-radius:4px"> `
    + `<button data-mn="move-input" style="padding:2px 10px;border:none;border-radius:5px;background:#fb923c;color:#fff;cursor:pointer">移動</button> `
    + `<button data-mn="cancel-sel" style="padding:2px 8px;border:1px solid #d1d5db;border-radius:5px;background:#fff;cursor:pointer">キャンセル</button></div>`;
}
// 通常のランキング表への手動調整装飾 (描画のたびに適用)。
//   - 移動済み行 = 黄背景、選択中行 = オレンジ背景
//   - 編集中はプレイヤーリンクを新規タブ化
//   - 選択中は行間に「▾ ここに挿入」スロット行を差し込む
function decorateManualTable() {
  if (!MANUAL) return;
  const tbody = document.getElementById('ranktable').querySelector('tbody');
  if (!tbody) return;
  const editing = MANUAL.editing;
  const colspan = (TABLE && TABLE.columns) ? TABLE.columns.length : 10;
  const rows = Array.from(tbody.querySelectorAll('tr.main-row'));
  rows.forEach((tr) => {
    const uid = manualParseUid(tr.dataset.uid);
    if (MANUAL.sel === uid) tr.style.background = '#ffedd5';
    else if (MANUAL.lockSel === uid) tr.style.background = '#fee2e2';
    else if (_mnMoved.has(uid)) tr.style.background = '#fef9c3';
    // 手動調整中 (編集中/確定後とも) はプレイヤー名クリックを新規タブに。
    tr.querySelectorAll('a.player-name').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  });
  // 固定設定バーは対象行のすぐ下に差し込む (画面上部まで戻らずに操作できる)。
  if (editing && MANUAL.lockSel != null) {
    const target = rows.find((tr) => manualParseUid(tr.dataset.uid) === MANUAL.lockSel);
    if (target) {
      const lr = document.createElement('tr');
      lr.className = 'mn-lock-row';
      lr.innerHTML = `<td colspan="${colspan}" style="padding:0;border:none">${manualLockBarHtml()}</td>`;
      // 行クリック (詳細展開) に食われないようにする。
      lr.addEventListener('click', (e) => e.stopPropagation());
      let anchor = target;
      if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('detail-row')) {
        anchor = anchor.nextElementSibling;
      }
      tbody.insertBefore(lr, anchor.nextElementSibling);
    }
  }
  if (editing && MANUAL.sel != null && rows.length) {
    const slotHtml = (attr) =>
      `<td colspan="${colspan}" style="padding:0;border:none"><div class="mn-slot" data-mn="slot" ${attr}>▾ ここに挿入</div></td>`;
    const first = document.createElement('tr');
    first.className = 'mn-slot-row';
    first.innerHTML = slotHtml('data-top="1"');
    tbody.insertBefore(first, rows[0]);
    rows.forEach((tr) => {
      const s = document.createElement('tr');
      s.className = 'mn-slot-row';
      s.innerHTML = slotHtml(`data-after="${escHtml(String(tr.dataset.uid))}"`);
      // 詳細展開行 (detail-row) があればその後ろに入れる
      let anchor = tr;
      if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('detail-row')) {
        anchor = anchor.nextElementSibling;
      }
      tbody.insertBefore(s, anchor.nextElementSibling);
    });
  }
}
// 手動調整のクリック操作 (バー/リスト共通のデリゲーション)。
function manualClickHandler(e) {
  const el = e.target.closest('[data-mn]');
  if (!el || el.disabled) return;
  const act = el.dataset.mn;
  if (act === 'unlock') { manualUnlock(); return; }
  if (act === 'clear-locks') {
    if (SEED_SPEC) { delete SEED_SPEC.locks; _pruneSeedSpec(); }
    saveManual(); render(); renderSpecStatus();
    return;
  }
  if (!MANUAL) return;
  if (act === 'undo') { MANUAL.hpos = Math.max(0, MANUAL.hpos - 1); MANUAL.sel = null; saveManual(); renderManualUI(); return; }
  if (act === 'redo') { MANUAL.hpos = Math.min(MANUAL.ops.length, MANUAL.hpos + 1); MANUAL.sel = null; saveManual(); renderManualUI(); return; }
  if (act === 'commit') { manualCommit(); return; }
  if (act === 'discard') { manualDiscard(); return; }
  if (act === 'select') {
    const uid = manualParseUid(el.dataset.uid);
    MANUAL.sel = (MANUAL.sel === uid) ? null : uid;
    MANUAL.lockSel = null; MANUAL.lockKind = null;
    renderManualUI(); return;
  }
  if (act === 'lockopen') {
    const uid = manualParseUid(el.dataset.uid);
    MANUAL.lockSel = (MANUAL.lockSel === uid) ? null : uid;
    MANUAL.lockKind = null;
    MANUAL.sel = null;
    renderManualUI(); return;
  }
  if (act === 'lock-apply') { if (MANUAL.lockSel != null) applySeedLockChoice(MANUAL.lockSel); return; }
  if (act === 'lock-cancel') { MANUAL.lockSel = null; MANUAL.lockKind = null; renderManualUI(); return; }
  if (act === 'cancel-sel') { MANUAL.sel = null; renderManualUI(); return; }
  if (act === 'slot') {
    if (MANUAL.sel == null) return;
    // スロットは「先頭 (data-top)」か「行 uid の直後 (data-after)」。フィルタ中でも
    // 完全な手動順に対する位置で解決する。
    const cur = manualOrder();
    const from = cur.indexOf(MANUAL.sel);
    const k = el.dataset.top != null ? 0 : cur.indexOf(manualParseUid(el.dataset.after)) + 1;
    manualPushOp(MANUAL.sel, k > from ? k - 1 : k);
    return;
  }
  if (act === 'move-input') {
    if (MANUAL.sel == null) return;
    const inp = document.getElementById('manual-bar').querySelector('input[data-mn-input]');
    const v = inp ? parseInt(inp.value, 10) : NaN;
    if (!Number.isFinite(v)) return;
    manualPushOp(MANUAL.sel, v - 1);
    return;
  }
}

// 手動調整 UI 全体の再描画: バー更新 + 通常テーブルへの手動列/並び順の反映。
// テーブル自体は共有コンポーネントのまま (手動調整列 + 装飾を足すだけ)。
let _mnTableMode = false;   // テーブルに手動列が入っているか
function renderManualUI() {
  const bar = document.getElementById('manual-bar');
  if (!bar) return;
  const workBar = document.getElementById('work-bar');
  if (!DATA.length) {
    bar.style.display = 'none';
    if (workBar) workBar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  if (workBar) workBar.style.display = '';
  // per-render キャッシュ (MANUAL_COL の cell / 装飾が参照)。バー描画より先に計算する
  // (manualOrder → 固定射影の警告 _lockProjNotes をバーが表示するため)。
  if (MANUAL) {
    const order = manualOrder();
    _mnPos = new Map(order.map((u, i) => [u, i]));
    _mnBase = new Map(MANUAL.base.map((u, i) => [u, i]));
    _mnMoved = manualMovedSet();
  } else {
    _mnPos = new Map(); _mnBase = new Map(); _mnMoved = new Set();
    // 手動調整が無くても固定は出力順に効くので、現在の並びで警告状態を計算し直す
    // (これをしないと前回計算時の警告が残り続ける)。
    orderedRecs();
  }
  // プール表示コンテキスト (被り回避パネルのプール数/ウェーブ数から)。
  const _pcP = Math.max(1, parseInt((document.getElementById('so-pools') || {}).value, 10) || 1);
  _mnPoolCtx = _pcP >= 2 ? { P: _pcP, waveMap: currentWaveMap(_pcP) } : null;

  // 固定設定バーは行の直下に出す (decorateManualTable)。ここは移動中バーのみ。
  let barHtml = manualBarHtml();
  if (MANUAL && MANUAL.editing && MANUAL.sel != null) barHtml += manualActionBarHtml();
  bar.innerHTML = barHtml;

  const tbl = ensureTable();
  const wantManual = !!MANUAL && !APPLIED_ORDER;   // 被り回避適用中は通常表示 (最適化後順序)
  if (wantManual !== _mnTableMode) {
    _mnTableMode = wantManual;
    tbl.setColumns(wantManual ? [MANUAL_COL].concat(SEED_BASE_COLUMNS) : SEED_BASE_COLUMNS);
    tbl.setSort(wantManual ? 'manual_pos' : 'rank', 'asc');
  } else if (wantManual) {
    // 手動順 (manual_pos) で並べ直し + セル/装飾の再描画。
    tbl.setSort('manual_pos', 'asc');
  }
}

// V4 用 (= site/index.html の _columnsForMeta と同形): 平均順位 / 平均スコアの
// 代わりに 直対評 / 順位評 を小さい灰色で表示する.
const _smallGray = (v, decimals = 1) =>
  v != null ? `<span style="color:#9ca3af;font-size:11px">${v.toFixed(decimals)}</span>` : '–';
const TJPR_SCORE_COL = {
  id: 'tjpr_score_cell', label: '順位評', sortable: true, sortKey: 'tjpr_score',
  css: 'col-score',
  value: (rec) => -((rec.scores && rec.scores.tjpr_elo) || -Infinity),
  cell: (rec) => _smallGray(rec.scores && rec.scores.tjpr_elo, 2),
};
const BT_SCORE_COL = {
  id: 'bt_score_cell', label: '直対評', sortable: true, sortKey: 'bt_score',
  css: 'col-avg-rank',
  value: (rec) => -((rec.scores && rec.scores.bt_gated_elo) || -Infinity),
  cell: (rec) => _smallGray(rec.scores && rec.scores.bt_gated_elo, 2),
};

// 手動調整列 (手動調整モード中だけ SEED_BASE_COLUMNS の先頭に足す)。
// 手動順のシード番号 + 移動バッジ (元#N) + 編集中は「選択」ボタン。
// per-render キャッシュ (_mnPos/_mnMoved/_mnBase) は renderManualUI が更新する。
let _mnPos = new Map(), _mnMoved = new Set(), _mnBase = new Map();
let _mnPoolCtx = null;   // {P, waveMap} — 手動列のプール表示用 (renderManualUI が更新)
const MANUAL_COL = {
  id: 'manual_pos', label: '手動', css: 'col-manual', sortable: false, sortKey: 'manual_pos',
  value: (rec) => (_mnPos.has(rec.user_id) ? _mnPos.get(rec.user_id) : 1e9),
  cell: (rec) => {
    // 手動シード# + 変動矢印 (▲上げ=緑/▼下げ=青) → 元#N (小さく) → 選択ボタン。
    // 配置は .mn-cell (デスクトップ縦積み / モバイル横並び) で制御。
    const u = rec.user_id;
    const pos = _mnPos.get(u);
    const moved = _mnMoved.has(u);
    const isSel = MANUAL && MANUAL.sel === u;
    let h = `<div class="mn-cell">`;
    let numHtml = `#${pos != null ? pos + 1 : '–'}`;
    if (moved && pos != null) {
      const d = (_mnBase.get(u) != null ? _mnBase.get(u) : pos) - pos;   // 正 = 上げ (シード改善)
      if (d !== 0) {
        numHtml += ` <span style="font-size:10px;font-weight:700;color:${d > 0 ? '#16a34a' : '#2563eb'}">${d > 0 ? '▲' + d : '▼' + (-d)}</span>`;
      }
    }
    h += `<span class="mn-num" title="手動調整後のシード位置">${numHtml}</span>`;
    if (moved) h += `<span class="mn-orig" title="手動調整前のシード位置">元#${(_mnBase.get(u) != null ? _mnBase.get(u) : 0) + 1}</span>`;
    // この順位のプール (P>=2 のとき。ウェーブがあれば A3 形式、無ければ P3)。
    if (_mnPoolCtx && pos != null) {
      const pl = window.SeedOptimizer ? SeedOptimizer.poolOfSeed(pos, _mnPoolCtx.P) : 0;
      h += `<span style="font-size:10px;color:#9ca3af;white-space:nowrap" title="この順位のプール (プール数 ${_mnPoolCtx.P}・被り回避パネルの設定)">${escHtml(poolLabel(pl, _mnPoolCtx.waveMap))}</span>`;
    }
    const lkRaw = SEED_SPEC && SEED_SPEC.locks ? SEED_SPEC.locks[u] : null;
    const lkKind = lkRaw ? (lkRaw.kind || lkRaw) : null;
    // 固定バッジの表記: 対象付きなら「A3固定」/「ウェーブA固定」、旧形式 (対象なし) は種別のみ。
    let lkLabel = null, lkTitle = null;
    if (lkKind) {
      const tgt = (lkRaw && lkRaw.target != null) ? lkRaw.target : null;
      if (lkKind === 'pool') {
        lkLabel = tgt != null && _mnPoolCtx ? poolLabel(tgt, _mnPoolCtx.waveMap) + '固定' : 'プール固定';
        lkTitle = 'プール固定' + (tgt != null && _mnPoolCtx ? ` (${poolLabel(tgt, _mnPoolCtx.waveMap)})` : '');
      } else {
        lkLabel = tgt != null ? 'ウェーブ' + waveLetter(tgt) + '固定' : 'ウェーブ固定';
        lkTitle = 'ウェーブ固定' + (tgt != null ? ` (${waveLetter(tgt)})` : '');
      }
      lkTitle += ': 並びに常時反映され、被り回避最適化でも動かしません';
    }
    if (MANUAL && MANUAL.editing) {
      const isLockSel = MANUAL.lockSel === u;
      h += `<button data-mn="select" data-uid="${escHtml(String(u))}" style="font-size:10px;padding:1px 8px;border:1px solid ${isSel ? '#ea580c' : '#d1d5db'};border-radius:5px;background:${isSel ? '#fb923c' : '#f9fafb'};color:${isSel ? '#fff' : '#374151'};cursor:pointer;white-space:nowrap">${isSel ? '選択中' : '選択'}</button>`;
      h += `<button data-mn="lockopen" data-uid="${escHtml(String(u))}" title="${lkTitle ? escHtml(lkTitle) + ' — クリックで変更' : 'プール/ウェーブを指定して固定する (指定した枠へ移動し、被り回避最適化でも動きません)'}" style="font-size:10px;padding:1px 6px;border:1px solid ${(lkKind || isLockSel) ? '#dc2626' : '#d1d5db'};border-radius:5px;background:${isLockSel ? '#dc2626' : (lkKind ? '#fee2e2' : '#f9fafb')};color:${isLockSel ? '#fff' : (lkKind ? '#b91c1c' : '#374151')};cursor:pointer;white-space:nowrap">${lkLabel ? escHtml(lkLabel) : 'プール指定'}</button>`;
    } else if (lkKind) {
      h += `<span style="font-size:10px;color:#b91c1c;white-space:nowrap" title="${escHtml(lkTitle)}">${escHtml(lkLabel)}</span>`;
    }
    h += `</div>`;
    return h;
  },
};
// csv モードは「読み込んだものを編集してアップロードする」ツールなので、
// SPSP の順位/スコア列は出さない (被り回避などの内部処理では uid 照合を使う)。
const SEED_BASE_COLUMNS = SEED_APP_CONFIG.mode === 'csv'
  ? ['display']
  : [
      'rank', 'display', BT_SCORE_COL, TJPR_SCORE_COL,
      'tjpr_lv', 'tour_count', 'bt_weekday',
      'rank_tjpr', 'rank_bt_gated',
    ];

// 共有 ranking table コンポーネント (= 初期化は DOMContentLoaded 後).
let TABLE = null;
function ensureTable() {
  if (TABLE) return TABLE;
  TABLE = new window.SPSPRankingTable.RankingTable({
    table: document.getElementById('ranktable'),
    rows: DATA,
    method: currentMethod,
    sort: { key: 'rank', dir: 'asc' },
    pageSize: 512,
    infiniteScroll: true,
    totalForRankFrac: 'rows',           // seed: event 参加者数を分母にする
    playerHrefPrefix: '../',
    showTopTours: SEED_APP_CONFIG.mode !== 'csv',    // csv モードは SPSP 情報を出さない
    showDisplayBadges: SEED_APP_CONFIG.mode !== 'csv',
    showGlobalRank: SEED_APP_CONFIG.mode !== 'csv',
    btWeekdayStyle: 'pill',             // ローカル / メインと同じ 常連 / レア
    columns: SEED_BASE_COLUMNS,
    rowClick: (rec, tr, ev) => seedRowClickHandler(rec, tr, ev),
  });
  // 手動調整モードの装飾 (背景色・挿入スロット・新規タブリンク) は描画のたびに当てる。
  TABLE.on('rendered', () => decorateManualTable());
  return TABLE;
}

// discriminator (start.gg 固有ID) 照合用。uid→disc は nightly 生成の discriminators.json
// (優先枠作成ページと同じデータ)。取得失敗は DISC_LOAD_ERROR に保持し、CSV に
// discriminator 列があるのに照合できないときだけ fail-loud でエラーにする。
let DISCRIMINATORS = null;      // {uid(str): disc} | null (未取得/取得失敗)
let DISC_LOAD_ERROR = null;
let _DISC_PROMISE = null;
let _DISC2UID = null;           // disc(小文字) → uid (遅延構築)
function loadDiscriminators() {
  if (_DISC_PROMISE) return _DISC_PROMISE;
  _DISC_PROMISE = fetch('../data/discriminators.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('discriminators.json HTTP ' + r.status); return r.json(); })
    .then(j => { DISCRIMINATORS = j; return j; })
    .catch(e => { DISC_LOAD_ERROR = String((e && e.message) || e); return null; });
  return _DISC_PROMISE;
}
function _disc2uid() {
  if (_DISC2UID || !DISCRIMINATORS) return _DISC2UID;
  _DISC2UID = new Map();
  for (const k in DISCRIMINATORS) _DISC2UID.set(String(DISCRIMINATORS[k]).toLowerCase(), Number(k));
  return _DISC2UID;
}
// CSV セル値 → 正規化 discriminator。"#abc12345" / 大文字のほか、優先枠作成ページの
// 出力形式 ="abc12345" (Excel の指数表記化よけ。パース後は =abc12345) も受け付ける。
function _csvNormDisc(v) {
  return String(v).trim().replace(/^=/, '').replace(/^"|"$/g, '').replace(/^#/, '').toLowerCase();
}

async function loadMasterData() {
  if (MASTER_MAP) return MASTER_MAP;
  const status = document.getElementById('status');
  status.textContent = 'SPSP マスターランキングを取得中…';
  const t0 = performance.now();
  // no-cache: デプロイ直後に新 meta と旧 jsonl の混在キャッシュを掴まないよう再検証させる
  // （upcoming.json と同方針。304 で済むので実コストは小さい）。
  const [metaRes, jsonlRes, mergesRes] = await Promise.all([
    fetch('../meta.json', { cache: 'no-cache' }),
    fetch('../latest_tjpr_full.jsonl', { cache: 'no-cache' }),
    fetch('../data/user_merges.json', { cache: 'no-cache' }),
  ]);
  if (!metaRes.ok) throw new Error('meta.json 取得失敗');
  if (!jsonlRes.ok) throw new Error('latest_tjpr_full.jsonl 取得失敗');
  if (!mergesRes.ok) throw new Error('user_merges.json 取得失敗');
  const mergesRaw = await mergesRes.json();
  USER_MERGES_MAP = new Map(
    Object.entries(mergesRaw).map(([k, v]) => [Number(k), Number(v)]));
  MASTER_META = await metaRes.json();
  META = MASTER_META;  // alias for downstream code
  document.getElementById('footer-info').innerHTML =
    `master generated ${META.eval_date} · ${META.n_players}名 · LOOKBACK ${META.lookback_days}日 · ` +
    `<a href="../overview.html" style="color:#dc2626">概要</a> · ` +
    `<a href="../details.html" style="color:#dc2626">詳細</a>`;
  const txt = await jsonlRes.text();
  const lines = txt.split('\n').filter(l => l.length);
  status.textContent = `${lines.length}行パース中…`;
  MASTER_MAP = new Map();
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      MASTER_MAP.set(rec.user_id, rec);
    } catch (e) {}
  }
  // discriminator 索引 (照合の任意ソース)。失敗しても続行 (照合時に fail-loud)。
  await loadDiscriminators();
  status.textContent = `マスター取得完了 (${MASTER_MAP.size} 名、${(performance.now()-t0).toFixed(0)}ms)`;
  return MASTER_MAP;
}

// ── start.gg API helpers ──
async function startggQuery(token, query, variables) {
  const res = await fetch('https://api.start.gg/gql/alpha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (e) {}
    const err = new Error(`start.gg HTTP ${res.status}`);
    err.rawError = `HTTP ${res.status}: ${body.substring(0, 1000)}`;
    throw err;
  }
  const body = await res.json();
  if (body.errors && body.errors.length) {
    const errMsgs = body.errors.map(e => e.message).join(' | ');
    const err = new Error('start.gg API エラー: ' + errMsgs);
    err.rawError = JSON.stringify(body.errors, null, 2);
    throw err;
  }
  return body.data;
}

// ── start.gg エラーメッセージのトラブルシューティング辞書 ──
const TROUBLESHOOTING = [
  { match: /401|unauthorized|invalid (api )?token|bad token/i,
    hint: '🔑 API トークンが無効/期限切れ。<a href="https://start.gg/admin/profile/developer" target="_blank" rel="noopener">start.gg で再発行</a> してください。' },
  { match: /403|forbidden|not (allowed|authorized)/i,
    hint: '🚫 権限不足。大会の管理者 (admin) でないとシード適用はできません。' },
  { match: /404|not found|event.*(not exist|does not exist)/i,
    hint: '🔍 URL のスペルや大会の公開状態 (publish) を確認してください。' },
  { match: /429|too many|rate.?limit/i,
    hint: '⏱ レート制限です。1〜2 分待ってから再試行してください。' },
  { match: /5\d\d|gateway|timeout|server error/i,
    hint: '🛠 start.gg 側の障害の可能性。少し時間を置いて再試行してください。' },
  { match: /invalid phase|phase.*(not found|invalid)|seeding.*not.*allowed/i,
    hint: '⚙ Phase ID/URL を再確認。シード設定可能な phase (大会のシード期間中) かどうか確認してください。' },
  { match: /network|fetch|failed to fetch/i,
    hint: '🌐 通信エラー。インターネット接続を確認、または広告ブロッカーが api.start.gg を妨害していないか確認してください。' },
];
function findTroubleshooting(msg) {
  const s = String(msg || '');
  const hits = TROUBLESHOOTING.filter(t => t.match.test(s));
  return hits.map(t => t.hint);
}
// showError(msg, rawError):
//   msg     = ユーザ向けの分かりやすい説明 (status に表示)
//   rawError = (optional) 生の API/system エラーメッセージ (debug 用 details に表示)
//             msg と異なる場合のみ <details> を出す. 省略時 OR 同じ場合は出さない.
function showError(msg, rawError) {
  const status = document.getElementById('status');
  status.textContent = '❌ ' + msg;
  const help = document.getElementById('error-help');
  if (!help) return;
  // hints は raw を優先 (= 英語 API error と matching する). 無ければ msg.
  const hints = findTroubleshooting(rawError || msg);
  const hasRawDetail = rawError && rawError !== msg;
  const detailsHtml = hasRawDetail
    ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:#9ca3af;font-size:11px">エラーメッセージ全文 (デバッグ用)</summary><pre style="white-space:pre-wrap;margin:6px 0 0;font-family:inherit;font-size:11px;color:#6b7280">${escapeHtml(rawError)}</pre></details>`
    : '';
  if (hints.length === 0) {
    if (hasRawDetail) {
      help.innerHTML = `<div style="font-size:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px">${detailsHtml}</div>`;
    } else {
      help.innerHTML = '';
    }
  } else {
    help.innerHTML = `<div style="font-size:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 12px">
      <div style="color:#dc2626;font-weight:600;margin-bottom:4px">💡 対処法</div>
      <ul style="margin:0;padding-left:1.4em;color:#374151">${hints.map(h => `<li>${h}</li>`).join('')}</ul>
      ${detailsHtml}
    </div>`;
  }
  help.style.display = (help.innerHTML ? '' : 'none');
}
function clearError() {
  const help = document.getElementById('error-help');
  if (help) { help.style.display = 'none'; help.innerHTML = ''; }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseEventUrl(input) {
  if (!input) return null;
  const s = String(input).trim();
  // Full URL or slug. Accept things like "tournament/X/event/Y" or "https://www.start.gg/tournament/X/event/Y[/...]"
  const m = s.match(/tournament\/([^\/\s?#]+)\/event\/([^\/\s?#]+)/);
  if (m) {
    return { slug: 'tournament/' + m[1] + '/event/' + m[2], tournamentSlug: m[1], eventSlug: m[2] };
  }
  // tournament-only URL (= event slug 無し). 末尾の /details, /events, /, "" などすべて吸収.
  // event slug を含まないように、tournament slug の直後が / + 非 "event" or 終端であることを要求.
  const t = s.match(/tournament\/([^\/\s?#]+)(?:\/(?!event\/)[^\s?#]*)?(?:[?#].*)?$/);
  if (t) {
    return { slug: null, tournamentSlug: t[1], eventSlug: null };
  }
  return null;
}

const EVENT_QUERY = `
  query EventDetail($slug: String!) {
    event(slug: $slug) {
      id name slug numEntrants
      tournament { id name slug startAt }
      phases { id name phaseOrder bracketType state groupCount numSeeds
               progressingInData { origin numProgressing } }
    }
  }
`;

const SEEDS_QUERY = `
  query PhaseSeeds($phaseId: ID!, $page: Int!, $perPage: Int!) {
    phase(id: $phaseId) {
      seeds(query: { page: $page, perPage: $perPage }) {
        pageInfo { totalPages total }
        nodes {
          id seedNum
          entrant {
            id name
            participants {
              user { id discriminator }
              player { id gamerTag prefix }
            }
          }
        }
      }
    }
  }
`;

// phase (ブラケット) 未作成の event 用フォールバック: 参加登録済み entrants を直接取得.
// seeds と違い phase 不要で、参加登録が始まっていれば取れる.
const ENTRANTS_QUERY = `
  query EventEntrants($slug: String!, $page: Int!, $perPage: Int!) {
    event(slug: $slug) {
      entrants(query: { page: $page, perPage: $perPage }) {
        pageInfo { totalPages total }
        nodes {
          id name
          participants {
            user { id discriminator }
            player { id gamerTag prefix }
          }
        }
      }
    }
  }
`;

async function fetchEvent(token, slug) {
  const data = await startggQuery(token, EVENT_QUERY, { slug });
  if (!data.event) throw new Error('event が見つかりません: ' + slug);
  return data.event;
}

const TOURNAMENT_EVENTS_QUERY = `
  query TournamentEvents($slug: String!) {
    tournament(slug: $slug) {
      id name slug
      events {
        id slug name numEntrants
        videogame { id name }
        type
      }
    }
  }
`;

// SSBU videogame id, 1on1 event type
const SSBU_VIDEOGAME_ID = 1386;
const SINGLES_EVENT_TYPE = 1;

async function fetchTournament(token, tournamentSlug) {
  const data = await startggQuery(token, TOURNAMENT_EVENTS_QUERY, { slug: tournamentSlug });
  if (!data.tournament) throw new Error('tournament が見つかりません: ' + tournamentSlug);
  return data.tournament;
}

async function fetchAllSeeds(token, phaseId, progressFn) {
  const all = [];
  let page = 1;
  const perPage = 64;
  while (true) {
    const data = await startggQuery(token, SEEDS_QUERY, { phaseId: String(phaseId), page, perPage });
    if (!data.phase) throw new Error('phase が取得できません');
    const seeds = data.phase.seeds || { nodes: [], pageInfo: { totalPages: 1 } };
    const nodes = seeds.nodes || [];
    all.push(...nodes);
    if (progressFn) progressFn(all.length, seeds.pageInfo.total || all.length);
    const tot = seeds.pageInfo.totalPages || 1;
    if (page >= tot || nodes.length === 0) break;
    page += 1;
    // small delay to avoid 429
    await new Promise(r => setTimeout(r, 500));
  }
  return all;
}

async function fetchAllEntrants(token, eventSlug, progressFn) {
  const all = [];
  let page = 1;
  const perPage = 64;
  while (true) {
    const data = await startggQuery(token, ENTRANTS_QUERY, { slug: eventSlug, page, perPage });
    if (!data.event) throw new Error('event が取得できません');
    const entrants = data.event.entrants || { nodes: [], pageInfo: { totalPages: 1 } };
    const nodes = entrants.nodes || [];
    all.push(...nodes);
    if (progressFn) progressFn(all.length, entrants.pageInfo.total || all.length);
    const tot = entrants.pageInfo.totalPages || 1;
    if (page >= tot || nodes.length === 0) break;
    page += 1;
    // small delay to avoid 429
    await new Promise(r => setTimeout(r, 500));
  }
  return all;
}

// entrant node → seedNodeToInfo と同じ shape. phase が無いので seedId / originalSeed は null
// (= シード適用は不可、閲覧 / CSV のみ).
function entrantNodeToInfo(node) {
  const ent = node || {};
  const parts = ent.participants || [];
  let uid = null, gamerTag = ent.name || '', prefix = '', disc = null;
  if (parts.length) {
    const p0 = parts[0];
    if (p0.user && p0.user.id != null) uid = Number(p0.user.id);
    if (p0.user && p0.user.discriminator) disc = String(p0.user.discriminator);
    if (p0.player) {
      gamerTag = p0.player.gamerTag || gamerTag;
      prefix = p0.player.prefix || '';
    }
  }
  const display = prefix ? (prefix + ' | ' + gamerTag) : gamerTag;
  return { seedId: null, originalSeed: null, userId: canonicalUserId(uid), display, discriminator: disc, entrantId: ent.id != null ? Number(ent.id) : null };
}

function seedNodeToInfo(seedNode) {
  const sid = seedNode.id;
  const sn = seedNode.seedNum;
  const ent = seedNode.entrant || {};
  const parts = ent.participants || [];
  let uid = null, gamerTag = ent.name || '', prefix = '', disc = null;
  if (parts.length) {
    const p0 = parts[0];
    if (p0.user && p0.user.id != null) uid = Number(p0.user.id);
    if (p0.user && p0.user.discriminator) disc = String(p0.user.discriminator);
    if (p0.player) {
      gamerTag = p0.player.gamerTag || gamerTag;
      prefix = p0.player.prefix || '';
    }
  }
  const display = prefix ? (prefix + ' | ' + gamerTag) : gamerTag;
  return { seedId: sid, originalSeed: sn, userId: canonicalUserId(uid), display, discriminator: disc, entrantId: ent.id != null ? Number(ent.id) : null };
}

function filterAndRerank(seedInfos) {
  // seedInfos = [{seedId, originalSeed, userId, display}]
  const ranked = [];
  const missing = [];
  for (const si of seedInfos) {
    if (si.userId != null && MASTER_MAP.has(si.userId)) {
      // Deep clone the master record so we don't pollute the shared map
      const rec = JSON.parse(JSON.stringify(MASTER_MAP.get(si.userId)));
      rec.ranks = rec.ranks || {};
      rec.ranks.global_ensemble = rec.ranks.ensemble;
      rec.ranks.global_tjpr = rec.ranks.tjpr;
      rec.ranks.global_bt_gated = rec.ranks.bt_gated;
      rec.seedId = si.seedId;
      rec.original_seed = si.originalSeed;
      rec.entrantId = si.entrantId;
      rec.discriminator = si.discriminator || null;   // start.gg 参加者データ由来 (CSV 照合用)
      ranked.push(rec);
    } else {
      missing.push(si);
    }
  }
  const n = ranked.length;
  // Ensemble は event-local で 1..N に再付番 (= シード順そのもの)
  ranked.sort((a, b) => (a.ranks.global_ensemble || 1e9) - (b.ranks.global_ensemble || 1e9));
  ranked.forEach((r, i) => { r.ranks.ensemble = i + 1; });
  // 順位評価 / 直対評価 は全体ランキングのまま保持 (re-rank しない)
  // 既存の rec.ranks.tjpr / rec.ranks.bt_gated は global 順位なのでそのまま使う
  // ensemble_avg_rank も既に global tjpr+bt の平均なのでそのまま
  // Append DB-missing players at the bottom (in start.gg seed order)
  missing.sort((a, b) => (a.originalSeed || 1e9) - (b.originalSeed || 1e9));
  let next = n + 1;
  for (const si of missing) {
    ranked.push({
      user_id: si.userId,
      display: si.display,
      unranked: true,
      seedId: si.seedId,
      original_seed: si.originalSeed,
      entrantId: si.entrantId,
      discriminator: si.discriminator || null,
      ranks: {
        // ensemble は event-local の連番 (最下位扱い)。tjpr/bt_gated は global 不明なので null
        ensemble: next, tjpr: null, bt_gated: null,
        global_ensemble: null, global_tjpr: null, global_bt_gated: null,
      },
      scores: {
        tjpr_score: 0.0, tjpr_elo: 0.0, tjpr_level: 0,
        bt_gated_ordinal: 0.0, bt_gated_elo: 0.0,
        ensemble_avg_rank: null, ensemble_avg_score: null,
      },
      metadata: { tour_count_3y: 0, bt_weekday_included: true, provisional: true, matches_count_3y: 0 },
    });
    next += 1;
  }
  return { records: ranked, rankedCount: n, missingCount: missing.length };
}

function downloadCsv() {
  if (!DATA.length) return;
  if (!EVENT_CONTEXT) return;
  const methodLabel = {
    ensemble: '総合評価', tjpr: '順位評価', bt_gated: '直対評価',
  }[currentMethod] || '総合評価';
  // Sort by current method's rank (or 被り回避適用順), then assign phaseseed 1..N
  const recs = orderedRecs();
  const lines = ['phaseseed,seedId,player,user_id,method,banzuke_rank,avg_rank,score,original_seed'];
  recs.forEach((r, i) => {
    const phaseseed = i + 1;
    const sid = r.seedId != null ? r.seedId : '';
    const player = (r.display || '').replace(/"/g, '""');
    const uid = r.user_id != null ? r.user_id : '';
    let bRank = '', avgR = '', score = '';
    if (!r.unranked) {
      bRank = r.ranks[currentMethod];
      const ar = r.scores.ensemble_avg_rank;
      avgR = ar != null ? ar.toFixed(2) : '';
      const sc = (currentMethod === 'tjpr') ? r.scores.tjpr_elo
                : (currentMethod === 'bt_gated') ? r.scores.bt_gated_elo
                : (r.scores.ensemble_avg_score != null ? r.scores.ensemble_avg_score
                  : (r.scores.tjpr_elo + r.scores.bt_gated_elo) / 2);
      score = typeof sc === 'number' ? sc.toFixed(2) : '';
    }
    const origSeed = r.original_seed != null ? r.original_seed : '';
    lines.push([phaseseed, sid, `"${player}"`, uid, methodLabel, bRank, avgR, score, origSeed].join(','));
  });
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tName = (EVENT_CONTEXT.eventName || 'seed').replace(/[^\w\-]/g, '_');
  a.href = url;
  // ファイル名に出力順の由来を付ける (手動調整 / 被り回避適用)。
  const orderTag = (MANUAL ? '_manual' : '') + (APPLIED_ORDER ? '_opt' : '');
  a.download = `spsp_seed_${tName}_${currentMethod}${orderTag}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function uploadToStartgg() {
  if (!DATA.length) return;
  // csv モード: start.gg 未接続なら大会 URL から自動で phase/seeds を取得する
  // (updatePhaseSeeding は phase の seedId が必須なため。表示用ではなく適用用)。
  if (!EVENT_CONTEXT && SEED_APP_CONFIG.mode === 'csv' && CSV_SOURCE) {
    const st = document.getElementById('status');
    if (st) st.textContent = '適用に必要な seedId を取得するため、大会から参加者を取得します…';
    await handleFetch();
    if (!EVENT_CONTEXT) return;   // 取得失敗 (エラーは handleFetch 側で表示済み)
  }
  if (!EVENT_CONTEXT) return;
  const token = getToken();
  if (!token) { alert('トークンを入力してください'); return; }
  if (EVENT_CONTEXT.phaseId == null) {
    // entrants フォールバックで取得した event (= phase 未作成)。
    // phase を作成してからシード適用する.
    await createPhaseThenUpload(token);
    return;
  }
  const methodLabel = {
    ensemble: '総合評価', tjpr: '順位評価', bt_gated: '直対評価',
  }[currentMethod] || '総合評価';
  const recs = orderedRecs();
  const mapping = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.seedId == null) continue;
    mapping.push({ seedId: r.seedId, seedNum: i + 1 });
  }
  if (!mapping.length) { alert('seedId 付きの行がありません'); return; }
  const msg = `${EVENT_CONTEXT.eventName} (phase ${EVENT_CONTEXT.phaseId}) に\n${methodLabel} の順 で ${mapping.length} 件のシードを上書きします。\n\n実行してよろしいですか?`;
  if (!confirm(msg)) return;
  const status = document.getElementById('status');
  clearError();
  status.textContent = `start.gg に ${mapping.length} 件送信中…`;
  const r = await SmashSeed.uploadSeeding(EVENT_CONTEXT.phaseId, token, mapping);
  if (r.ok) {
    status.textContent = `✅ シード適用成功 (${r.count} 件)`;
  } else {
    showError(r.error || 'unknown error');
  }
}

const UPSERT_PHASE_MUTATION = `
  mutation CreatePhase($eventId: ID!, $payload: PhaseUpsertInput!) {
    upsertPhase(eventId: $eventId, payload: $payload) { id name }
  }
`;

// phase 作成直前の再確認用 (= event id で phase 有無だけ取る)
const PHASES_RECHECK_QUERY = `
  query PhasesRecheck($eventId: ID!) {
    event(id: $eventId) { phases { id } }
  }
`;

// phase 未作成 event へのシード適用: phase (Double Elimination) を作成 → seeds 生成を待って
// entrantId → seedId を対応付け → updatePhaseSeeding。admin 権限が必要 (= 通常の適用と同じ).
async function createPhaseThenUpload(token) {
  const status = document.getElementById('status');
  const methodLabel = {
    ensemble: '総合評価', tjpr: '順位評価', bt_gated: '直対評価',
  }[currentMethod] || '総合評価';
  // UI からプール数 / phase 名を取得 (= phase-create-row)
  let groupCount = parseInt(document.getElementById('pc-group-count').value, 10);
  if (!Number.isFinite(groupCount) || groupCount < 1) groupCount = 1;
  if (groupCount > 128) groupCount = 128;
  const phaseName = (document.getElementById('pc-phase-name').value || '').trim() || 'Bracket';
  const msg = `${EVENT_CONTEXT.eventName} にはまだブラケット (phase) がありません。\n\n` +
    `Double Elimination の phase「${phaseName}」(プール数 ${groupCount}) を新規作成し、` +
    `続けて ${methodLabel} の順で ${DATA.length} 名のシードを適用します。\n` +
    `(bracket 形式や pool 分割は作成後に start.gg の Bracket Setup で変更できます)\n\n実行してよろしいですか?`;
  if (!confirm(msg)) return;
  clearError();
  // 直前ガード: 取得後に start.gg 側で phase が作られていたら新規作成しない
  // (= 既存 phase に重複追加したり設定を上書きしたりしないため)。
  status.textContent = 'phase の有無を再確認中…';
  const recheck = await startggQuery(token, PHASES_RECHECK_QUERY, { eventId: String(EVENT_CONTEXT.eventId) });
  const existing = (recheck.event && recheck.event.phases) || [];
  if (existing.length) {
    showError('この event には既に phase が作成されています (取得後に start.gg 側で作成された可能性)。phase の新規作成は行いません。「参加者を取得」をやり直して、通常のシード適用をしてください。');
    return;
  }
  status.textContent = `phase「${phaseName}」(Double Elimination, ${groupCount} pool) を作成中…`;
  const data = await startggQuery(token, UPSERT_PHASE_MUTATION, {
    eventId: String(EVENT_CONTEXT.eventId),
    payload: { name: phaseName, bracketType: 'DOUBLE_ELIMINATION', groupCount: groupCount },
  });
  const phase = data.upsertPhase;
  if (!phase || phase.id == null) throw new Error('phase の作成に失敗しました (= upsertPhase が null。大会の admin 権限があるか確認してください)');
  EVENT_CONTEXT.phaseId = phase.id;
  // seeds は phase 作成後に start.gg 側で生成される。生成完了まで少し待ちつつ polling.
  let seedNodes = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    status.textContent = `phase 作成完了。seeds 生成待ち (${attempt}/5) …`;
    await new Promise(r => setTimeout(r, attempt === 1 ? 1000 : 2000));
    seedNodes = await fetchAllSeeds(token, phase.id);
    if (seedNodes.length) break;
  }
  if (!seedNodes.length) {
    showError('phase は作成できましたが seeds がまだ生成されていません。少し待ってから「取得」をやり直し、再度シード適用してください。');
    return;
  }
  // 作成された seeds を entrantId で参加者行に対応付け
  const seedByEntrant = new Map();
  for (const n of seedNodes) {
    if (n.entrant && n.entrant.id != null) seedByEntrant.set(Number(n.entrant.id), n.id);
  }
  let matched = 0;
  for (const r of DATA) {
    if (r.entrantId != null && seedByEntrant.has(Number(r.entrantId))) {
      r.seedId = seedByEntrant.get(Number(r.entrantId));
      matched += 1;
    }
  }
  if (!matched) {
    showError('作成した phase の seeds と参加者の対応付けに失敗しました。「取得」をやり直してから再度シード適用してください。');
    return;
  }
  // 通常 path と同じ mapping 構築 + 送信 (= confirm は冒頭で済んでいる)
  const recs = DATA.slice().sort((a, b) => (a.ranks[currentMethod] || 1e9) - (b.ranks[currentMethod] || 1e9));
  const mapping = [];
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].seedId == null) continue;
    mapping.push({ seedId: recs[i].seedId, seedNum: i + 1 });
  }
  status.textContent = `start.gg に ${mapping.length} 件送信中…`;
  const r = await SmashSeed.uploadSeeding(phase.id, token, mapping);
  if (r.ok) {
    status.textContent = `✅ phase 作成 + シード適用成功 (${r.count} 件)`;
    document.getElementById('meta-info').textContent = `${EVENT_CONTEXT.eventName} (phase ${phase.id})`;
    // phase はもう存在するので自動作成の設定 UI は閉じる
    document.getElementById('phase-create-row').style.display = 'none';
  } else {
    showError(r.error || 'unknown error');
  }
}

function getToken() {
  const t = document.getElementById('token').value.trim();
  if (t) { try { sessionStorage.setItem('smash_banzuke_token', t); } catch (e) {} }
  return t;
}

// method-tabs / 検索 / CSV / upload ボタンを参加者取得後だけ表示する.
function setParticipantsUiVisible(visible) {
  const disp = visible ? '' : 'none';
  const mt = document.getElementById('method-tabs');
  const sr = document.getElementById('search');
  const cb = document.getElementById('csv-btn');
  const ub = document.getElementById('upload-btn');
  // csv モードでは基準タブ (SPSP評価の切替) は出さない — 基準は読み込んだ CSV。
  if (mt) mt.style.display = (visible && SEED_APP_CONFIG.mode !== 'csv') ? 'flex' : 'none';
  if (sr) sr.style.display = disp;
  if (cb) cb.style.display = disp;
  if (ub) ub.style.display = disp;
  const panel = document.getElementById('seedopt-panel');
  if (panel) panel.style.display = disp;
  const spec = document.getElementById('spec-panel');
  if (spec) spec.style.display = disp;
  if (visible) initSeedOptPanel();
}

async function handleFetch() {
  const status = document.getElementById('status');
  clearError();
  // Hide stale event-picker from previous failed run
  const epPrev = document.getElementById('event-picker');
  if (epPrev) epPrev.style.display = 'none';
  // Hide stale phase-select from previous multi-phase fetch
  // (= 別 event に切り替えたとき古い phase 一覧が残らないように)
  const prPrev = document.getElementById('phase-row');
  if (prPrev) prPrev.style.display = 'none';
  const pcPrev = document.getElementById('phase-create-row');
  if (pcPrev) pcPrev.style.display = 'none';
  const token = getToken();
  const urlVal = document.getElementById('event-url').value.trim();
  const parsed = parseEventUrl(urlVal);
  if (!token) { status.textContent = 'API トークンを入力してください'; return; }
  if (!parsed) { status.textContent = '大会 URL の形式が不正です'; return; }

  // 取得開始: ボタン無効 + 旧データクリア + 関連 UI 非表示
  // (= 新規 fetch がエラーで終わっても古い参加者ランキングや検索 UI が残らないように)
  document.getElementById('fetch-btn').disabled = true;
  document.getElementById('csv-btn').disabled = true;
  document.getElementById('upload-btn').disabled = true;
  setParticipantsUiVisible(false);
  DATA.length = 0;
  EVENT_CONTEXT = null;
  MANUAL = null;   // 新規取得中は手動調整をメモリから外す (保存は restoreManualForEvent が判定)
  SEED_SPEC = null;   // 指定・固定も同様 (restoreManualForEvent で復元)
  if (TABLE) render();
  try {
    await loadMasterData();
    // event 取得を試行. tournament-only URL or event slug が不正で見つからない場合は
    // tournament の events 一覧から SSBU 1on1 単独 event を自動選択する.
    let ev = null;
    if (parsed.eventSlug != null) {
      status.textContent = 'start.gg から event 情報を取得中…';
      try {
        ev = await fetchEvent(token, parsed.slug);
      } catch (e) {
        // event slug 不正 → tournament-only fallback に切替
        console.warn('event 取得失敗、tournament events から自動選択にフォールバック:', e.message);
        parsed.eventSlug = null;
        parsed.slug = null;
      }
    }
    if (ev == null) {
      status.textContent = 'tournament の event 一覧を取得中…';
      const tour = await fetchTournament(token, parsed.tournamentSlug);
      const ssbuEvents = (tour.events || []).filter(e =>
        e.videogame && Number(e.videogame.id) === SSBU_VIDEOGAME_ID && Number(e.type) === SINGLES_EVENT_TYPE
      );
      if (ssbuEvents.length === 0) {
        throw new Error('この大会には SSBU シングルス event がありません');
      }
      if (ssbuEvents.length > 1) {
        // 複数 SSBU 1on1 → inline picker で選択させて再 dispatch.
        // (error 文字列ではなく UI を出す)
        showEventPickerInline(parsed.tournamentSlug, ssbuEvents);
        status.textContent = 'SSBU シングルス event が複数あります。下のリストから選択してください';
        return;
      }
      // 単独イベント自動選択
      const tail = String(ssbuEvents[0].slug || '').split('/').pop();
      parsed.eventSlug = tail;
      parsed.slug = 'tournament/' + parsed.tournamentSlug + '/event/' + tail;
      status.textContent = `event 自動選択: ${ssbuEvents[0].name} → 取得中…`;
      ev = await fetchEvent(token, parsed.slug);
    }
    const phases = (ev.phases || []).slice().sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0));
    if (!phases.length) {
      // phase (ブラケット) 未作成 → entrants フォールバック (= 閲覧 / CSV のみ可、シード適用は不可).
      // 日本のウィークリーは当日までブラケットを組まない運用が多く、phase 無しは普通に起きる.
      await performEntrantsFetch(token, ev);
      return;
    }
    let phaseId;
    if (phases.length > 1) {
      const sel = document.getElementById('phase-select');
      sel.innerHTML = '';
      for (const p of phases) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.name} (phase ${p.id})`;
        sel.appendChild(opt);
      }
      document.getElementById('phase-row').style.display = '';
      phaseId = phases[0].id;
      sel.value = phaseId;
      // re-fetch on phase change（連打の並行実行と unhandled rejection を防ぐ:
      // fetch-btn と同様にボタン相当をロックし、失敗は showError に流す）。
      sel.onchange = async () => {
        phaseId = sel.value;
        sel.disabled = true;
        document.getElementById('fetch-btn').disabled = true;
        try {
          await performSeedFetch(token, ev, phaseId);
        } catch (err) {
          showError(err.message, err.rawError);
        } finally {
          sel.disabled = false;
          document.getElementById('fetch-btn').disabled = false;
        }
      };
    } else {
      phaseId = phases[0].id;
    }
    await performSeedFetch(token, ev, phaseId);
  } catch (e) {
    showError(e.message, e.rawError);
  } finally {
    document.getElementById('fetch-btn').disabled = false;
  }
}

// start.gg の phase 連鎖 (progressingInData) から、選択 phase を起点とした
// トーナメントプレビュー用のフェーズ構成 [{name, pools, adv}] を作る。
// adv = 次フェーズへの通過人数 ÷ このフェーズのプール数 (割り切れない場合はそこで打ち切り)。
// 進出設定が無い (単一フェーズ / 未設定) 場合は null を返し、発行側が既定にフォールバックする。
function buildPhasesConfig(ev, phaseId) {
  const all = (ev && ev.phases) || [];
  const byId = new Map(all.map((p) => [String(p.id), p]));
  if (!byId.has(String(phaseId))) return null;
  // next(p) = progressingInData に p.id を origin として持つ phase
  const nextOf = (p) => all.find((q) =>
    (q.progressingInData || []).some((d) => String(d.origin) === String(p.id))) || null;
  const chain = [byId.get(String(phaseId))];
  while (true) {
    const next = nextOf(chain[chain.length - 1]);
    if (!next || chain.includes(next)) break;
    chain.push(next);
  }
  if (chain.length < 2) return null;
  const out = [];
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    const pools = Math.max(1, p.groupCount | 0);
    const entry = { name: p.name || `フェーズ${i + 1}`, pools };
    if (i < chain.length - 1) {
      const numProg = (chain[i + 1].progressingInData || [])
        .filter((d) => String(d.origin) === String(p.id))
        .reduce((a, d) => a + (d.numProgressing || 0), 0);
      if (!numProg || numProg % pools !== 0) {
        // 通過人数が取れない / プール数で割り切れない → ここまでで打ち切り
        // (以降はプレビュー側のフェーズ構成エディタで編集してもらう)
        out.push(entry);
        break;
      }
      entry.adv = numProg / pools;
    }
    out.push(entry);
  }
  return out.length >= 2 ? out : null;
}

async function performSeedFetch(token, ev, phaseId) {
  const status = document.getElementById('status');
  status.textContent = `seeds 取得中 (phase ${phaseId}) …`;
  const seedNodes = await fetchAllSeeds(token, phaseId, (got, tot) => {
    status.textContent = `seeds 取得中 ${got}/${tot} …`;
  });
  const seedInfos = seedNodes.map(seedNodeToInfo);
  status.textContent = `${seedInfos.length} 名取得。フィルター中…`;
  const { records, rankedCount, missingCount } = filterAndRerank(seedInfos);
  const _phase = (ev.phases || []).find(p => String(p.id) === String(phaseId));
  // ウェーブ (プール名 A1,B2,… の先頭文字) の自動取得。失敗は黙殺せず error として保持し
  // パネルのラベルで明示する (手動設定は常に可能)。
  let waves = null;
  try {
    waves = await fetchPhaseWaves(token, phaseId);
  } catch (e) {
    waves = { error: String((e && e.message) || e) };
  }
  EVENT_CONTEXT = {
    phaseId, eventName: ev.name,
    eventId: ev.id, tournamentName: ev.tournament ? ev.tournament.name : '',
    bracketType: _phase ? _phase.bracketType : null,
    poolCount: (_phase && _phase.groupCount) ? _phase.groupCount : null,  // 取得できたプール数
    waves,   // {poolCount, waveCount, poolToWave, letters, identifiers} | {error} | null
    // start.gg のフェーズ連鎖 (選択 phase 起点)。トーナメントプレビューの初期構成に使う。
    phasesConfig: buildPhasesConfig(ev, phaseId),   // [{name, pools, adv?}] | null
  };
  dropAppliedOrder({ render: false });   // 新規取得で被り回避の反映をリセット
  // Repopulate DATA in place (preserve reference)
  DATA.length = 0;
  for (const r of records) DATA.push(r);
  document.getElementById('meta-info').textContent = `${ev.name} (phase ${phaseId})`;
  status.textContent = `${ev.name}: ${rankedCount} 名ランク + ${missingCount} 名 DB 不在 = ${records.length} 名`;
  document.getElementById('csv-btn').disabled = false;
  document.getElementById('upload-btn').disabled = false;
  setParticipantsUiVisible(true);
  const tbl = ensureTable();
  tbl.setSort('rank', 'asc');
  render();  restoreManualForEvent();
}

// phase 未作成 event 用: entrants から参加者一覧を表示する.
// シード適用 (= upload) は phase が無いと不可能なので disabled のまま、閲覧と CSV だけ有効化.
async function performEntrantsFetch(token, ev) {
  const status = document.getElementById('status');
  status.textContent = 'ブラケット未作成のため参加者 (entrants) から取得中…';
  const slug = ev.slug || (document.getElementById('event-url').value.trim().match(/tournament\/[^\/\s?#]+\/event\/[^\/\s?#]+/) || [''])[0];
  const nodes = await fetchAllEntrants(token, slug, (got, tot) => {
    status.textContent = `参加者取得中 ${got}/${tot} …`;
  });
  if (!nodes.length) {
    throw new Error('この event にはまだブラケット (phase) も参加登録者もありません。参加登録が始まってから、または start.gg の Bracket Setup で phase を作成してから再度取得してください。');
  }
  const seedInfos = nodes.map(entrantNodeToInfo);
  status.textContent = `${seedInfos.length} 名取得。フィルター中…`;
  const { records, rankedCount, missingCount } = filterAndRerank(seedInfos);
  EVENT_CONTEXT = {
    phaseId: null, eventName: ev.name,
    eventId: ev.id, tournamentName: ev.tournament ? ev.tournament.name : '',
    bracketType: null,   // phase 未作成 → 形式不明 → 既定 DE 想定
    poolCount: null,     // phase 未作成 → プール数不明
    waves: null,         // phase 未作成 → ウェーブ不明 (手動設定可)
  };
  dropAppliedOrder({ render: false });
  DATA.length = 0;
  for (const r of records) DATA.push(r);
  document.getElementById('meta-info').textContent = `${ev.name} (参加者一覧 / ブラケット未作成)`;
  status.textContent = `${ev.name}: ${rankedCount} 名ランク + ${missingCount} 名 DB 不在 = ${records.length} 名 ⚠ ブラケット未作成 (シード適用時に phase を自動作成します)`;
  document.getElementById('csv-btn').disabled = false;
  document.getElementById('upload-btn').disabled = false;
  // phase 自動作成の設定 UI (プール数 / phase 名) を表示
  document.getElementById('phase-create-row').style.display = '';
  setParticipantsUiVisible(true);
  const tbl = ensureTable();
  tbl.setSort('rank', 'asc');
  render();  restoreManualForEvent();
}

// Backwards-compat aliases (= 内部の detail builder で使われている).
const getRank = window.SPSPRankingTable.getRank;
const getScore = window.SPSPRankingTable.getScore;
const formatScore = window.SPSPRankingTable.formatScore;
function formatAvgRank(rec, _method) {
  return window.SPSPRankingTable.formatAvgRank(rec);
}

function render() {
  const tbl = ensureTable();
  tbl.setRows(DATA);
  tbl.setMethod(currentMethod);
  tbl.setFilterText(filterText);
  renderManualUI();
}
// 手動調整のクリック操作 (動的要素はデリゲーションで拾う)。
document.getElementById('manual-bar').addEventListener('click', manualClickHandler);
// 固定設定バーの種別セレクト変更 → 対象セレクト (プール一覧/ウェーブ一覧) を組み直す。
// バーは表 (行の直下) と manual-bar の両方に出し得るので両方で拾う。
function _lockKindChangeHandler(e) {
  const el = e.target.closest('[data-mn-lock-kind]');
  if (el && MANUAL && MANUAL.editing && MANUAL.lockSel != null) {
    MANUAL.lockKind = el.value;
    renderManualUI();
  }
}
document.getElementById('manual-bar').addEventListener('change', _lockKindChangeHandler);
document.getElementById('ranktable').addEventListener('change', _lockKindChangeHandler);
// 手動調整バーのプール数 / ウェーブ数 → 被り回避パネルの入力 (so-pools/so-waves) に反映。
// 値は 1 箇所 (パネル) が正なので、こちらは同期して再描画するだけ。
document.getElementById('manual-bar').addEventListener('input', (e) => {
  const p = e.target.closest('[data-mn-pools]'), w = e.target.closest('[data-mn-waves]');
  if (!p && !w) return;
  const src = p || w;
  const dst = document.getElementById(p ? 'so-pools' : 'so-waves');
  const v = parseInt(src.value, 10);
  if (!dst || !Number.isFinite(v) || v < 1) return;
  dst.value = String(v);
  if (p) updateIntraToggleState();
  renderManualUI();
  // 再描画で input が作り直されるのでフォーカスとカーソルを戻す。
  const again = document.getElementById('manual-bar')
    .querySelector(p ? '[data-mn-pools]' : '[data-mn-waves]');
  if (again) { again.focus(); again.select(); }
});
// プレイヤーページへのリンク (表・詳細展開内とも) は常に新しいタブで開く。
document.getElementById('ranktable').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a && /p\/\?uid=/.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noopener'; }
}, true);
// テーブル内の手動調整コントロール ([data-mn] = 選択ボタン/挿入スロット) は
// capture で先取りして、行クリック (詳細展開) やソートに食われないようにする。
document.getElementById('ranktable').addEventListener('click', (e) => {
  if (!MANUAL) return;
  const mn = e.target.closest('[data-mn]');
  if (mn) {
    e.stopPropagation();
    e.preventDefault();
    manualClickHandler(e);
    return;
  }
  // 編集中はヘッダソートを無効化 (手動順の表示が崩れて挿入位置が分からなくなるため)。
  if (MANUAL.editing && e.target.closest('th.sortable')) {
    e.stopPropagation();
  }
}, true);


// ── Events ──
document.getElementById('search').addEventListener('input', e => {
  filterText = e.target.value;
  const tbl = TABLE; if (tbl) tbl.setFilterText(filterText);
});

document.getElementById('method-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.method-tab');
  if (!tab || tab.dataset.method === currentMethod) return;
  // 手動調整がある場合は破棄確認を先に (キャンセルならタブ切替自体を中止)。
  if (MANUAL && !confirm('基準ランキングを変更すると手動調整 (履歴含む) を破棄します。よろしいですか？')) return;
  document.querySelectorAll('.method-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  currentMethod = tab.dataset.method;
  dropAppliedOrder();  // 基準が変わるので適用解除
  // 被り回避の結果も基準ランキング前提なので破棄（残すと再適用できない死に状態になる）。
  if (SEEDOPT_RESULT) resetSeedOptResultPanel('基準ランキングが変わったため被り回避の結果をクリアしました。再実行してください。');
  // 手動調整も旧基準前提なので破棄 (保存も消す)。
  if (MANUAL) {
    MANUAL = null; saveManual(); renderManualUI();
    const st = document.getElementById('status');
    if (st) st.textContent = '基準ランキングが変わったため手動調整を破棄しました。';
  }
  const tbl = TABLE; if (tbl) tbl.setMethod(currentMethod);
});

// 注: sortable / 無限スクロール / クリック handler は SPSPRankingTable コンポーネントが
// 内部で扱う. main-row クリック時は rowClick callback (= seedRowClickHandler) が呼ばれる.

// ── Detail パネル (大会別 / 直接対決) ──
// 詳細パネル本体は SPSPDetail.buildDetailContent (= ../player-detail.js) に集約.
// canonical = site/index.html の inline 実装. 大会内ランクや Lv 内訳 / charts は
// 表示しない (= main canonical との一致を優先).
function getDetailCfg() {
  return {
    getMeta: () => META || {},
    getDataArray: () => DATA,
    getMasterMap: () => MASTER_MAP,
    pathPrefix: '../',
  };
}

// Open 中の tour-table 再描画 (= tour-sort-toggle 押下時).
function refreshOpenTournamentTables() {
  document.querySelectorAll('.tour-sort-toggle').forEach(el => {
    const uid = el.dataset.uid;
    const rec = DATA.find(r => String(r.user_id) === String(uid));
    if (!rec) return;
    const tabContent = el.closest('.tab-tour');
    if (!tabContent) return;
    tabContent.innerHTML = window.SPSPDetail.buildTournamentTable(rec, getDetailCfg());
  });
}

// ── Detail-row 内部のクリック処理 (tab 切替 / H2H expand / 並べ替え / 行展開) ──
document.getElementById('tbody').addEventListener('click', e => {
  // Detail tab switch (大会別 / 直接対決)
  const tabBtn = e.target.closest('.detail-tab');
  if (tabBtn) {
    e.stopPropagation();
    const section = tabBtn.closest('.detail-section');
    if (!section) return;
    const key = tabBtn.dataset.tab;
    section.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === key));
    section.querySelectorAll('.detail-tab-content').forEach(c => {
      c.style.display = c.classList.contains('tab-' + key) ? '' : 'none';
    });
    return;
  }
  // H2H 共通「もっと見る」 → 勝/負 両方の hidden を表示
  const h2hBtn = e.target.closest('.h2h-expand-btn');
  if (h2hBtn) {
    e.stopPropagation();
    const wrap = h2hBtn.closest('.tab-h2h');
    if (!wrap) return;
    wrap.querySelectorAll('.h2h-extra').forEach(x => x.style.display = '');
    const expandDiv = h2hBtn.closest('.h2h-expand');
    if (expandDiv) expandDiv.remove();
    return;
  }
  // Tournament sort toggle (page-level, applies to all open detail rows)
  const toggle = e.target.closest('.tour-sort-toggle');
  if (toggle) {
    e.stopPropagation();
    window.SPSPDetail.toggleSortMode();
    refreshOpenTournamentTables();
    return;
  }
  // Expand hidden rows in tour-table
  const expand = e.target.closest('.expand-rows');
  if (expand) {
    e.stopPropagation();
    const section = expand.parentElement;
    section.querySelectorAll('tr.extra-row').forEach(r => r.classList.remove('hidden-row'));
    expand.remove();
    return;
  }
});

// main-row クリック → detail-row 展開 (大会別 / 直接対決 タブ含む).
// RankingTable の rowClick callback として呼ばれる.
function seedRowClickHandler(rec, tr, _ev) {
  if (!rec) return;
  const next = tr.nextElementSibling;
  if (next && next.classList && next.classList.contains('detail-row')) {
    next.remove();
    tr.classList.remove('expanded');
    return;
  }
  // 既に他の行が展開中ならそれを閉じる
  const table = tr.closest('table');
  const open = table.querySelector('tr.detail-row');
  if (open) {
    const prev = open.previousElementSibling;
    if (prev) prev.classList.remove('expanded');
    open.remove();
  }
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  if (rec.unranked) {
    detail.innerHTML = `<td colspan="9"><div class="detail-inner" style="padding:14px;font-size:12px;color:#6b7280">
      このプレイヤーは SPSP DB に履歴がないため、詳細情報は表示できません。<br>
      最下位扱いで CSV / アップロードには含まれます。
    </div></td>`;
    tr.classList.add('expanded');
    tr.after(detail);
    return;
  }
  detail.innerHTML = `<td colspan="9"><div class="detail-inner">
    <div class="loading-msg" style="padding:14px;color:#6b7280;font-size:12px">詳細情報を取得中…</div>
  </div></td>`;
  tr.classList.add('expanded');
  tr.after(detail);
  const cfg = getDetailCfg();
  window.SPSPDetail.fetchPlayerDetail(rec.user_id, cfg).then(detailData => {
    if (!detailData) return;
    rec.tournaments = detailData.tournaments || [];
    rec.history = detailData.history || [];
    rec.recent_matches = detailData.recent_matches || [];
    if (rec.scores) rec.scores.tjpr_lv_breakdown = detailData.tjpr_lv_breakdown || {};
    const inner = detail.querySelector('.detail-inner');
    if (inner) inner.innerHTML = window.SPSPDetail.buildDetailContent(rec, cfg);
  }).catch(err => {
    const inner = detail.querySelector('.loading-msg');
    if (inner) inner.textContent = '詳細情報の取得に失敗: ' + err.message;
  });
}

// ── 今後の大会ピッカー ─────────────────────────
// data/upcoming.json を lazy fetch して 5件/ページで表示.
// 単独 SSBU event の大会 → クリックで URL 入力 + handleFetch 自動起動.
// 複数 SSBU event の大会 → inline で event 選択肢を展開.
const UPCOMING_PAGE_SIZE = 5;
let UPCOMING_DATA = null;       // { tournaments: [...] } or null while loading
let UPCOMING_LOAD_PROMISE = null;
let UPCOMING_PAGE = 0;          // 0-indexed

function formatUpcomingDate(unixTs) {
  if (!unixTs) return '?';
  const d = new Date(unixTs * 1000);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const wk = ['日','月','火','水','木','金','土'][d.getDay()];
  return `${m}/${day}(${wk})`;
}

async function loadUpcomingData() {
  if (UPCOMING_DATA) return UPCOMING_DATA;
  if (UPCOMING_LOAD_PROMISE) return UPCOMING_LOAD_PROMISE;
  UPCOMING_LOAD_PROMISE = (async () => {
    const res = await fetch('../data/upcoming.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('upcoming.json HTTP ' + res.status);
    UPCOMING_DATA = await res.json();
    return UPCOMING_DATA;
  })();
  return UPCOMING_LOAD_PROMISE;
}

function buildEventUrl(tournamentSlug, eventSlug) {
  const tail = String(eventSlug || '').split('/').pop();
  // tournament_slug は "tournament/xxx" or "xxx"。後者なら prefix を付ける.
  const tslug = tournamentSlug.startsWith('tournament/')
    ? tournamentSlug : ('tournament/' + tournamentSlug);
  return 'https://www.start.gg/' + tslug + '/event/' + tail;
}

function renderUpcomingPage() {
  const list = document.getElementById('upcoming-list');
  const pager = document.getElementById('upcoming-pager');
  if (!list || !pager) return;
  if (!UPCOMING_DATA || !UPCOMING_DATA.tournaments) return;
  // 現在 epoch 秒より startAt が前の大会は表示しない (= 既に過去になった大会).
  // upcoming.json は download 時点で過去除外済だが、build と閲覧の時間差で過ぎたものも除外.
  const nowSec = Math.floor(Date.now() / 1000);
  const tours = (UPCOMING_DATA.tournaments || []).filter(t => {
    const st = Number(t.start_at);
    return Number.isFinite(st) && st >= nowSec;
  });
  const total = tours.length;
  const totalPages = Math.max(1, Math.ceil(total / UPCOMING_PAGE_SIZE));
  if (UPCOMING_PAGE >= totalPages) UPCOMING_PAGE = totalPages - 1;
  if (UPCOMING_PAGE < 0) UPCOMING_PAGE = 0;
  const start = UPCOMING_PAGE * UPCOMING_PAGE_SIZE;
  const slice = tours.slice(start, start + UPCOMING_PAGE_SIZE);
  list.innerHTML = '';
  for (const t of slice) {
    const row = document.createElement('div');
    row.className = 'upcoming-item';
    row.dataset.tslug = t.tournament_slug;
    const tslugBare = String(t.tournament_slug || '').replace(/^tournament\//, '');
    const ttoUrl = `https://www.start.gg/${t.tournament_slug || ('tournament/' + tslugBare)}`;
    const cityHtml = t.city ? `<span class="city">${escapeHtml(t.city)}</span>` : '';
    const onlineHtml = t.is_online ? '<span class="city">🌐 オンライン</span>' : '';
    row.innerHTML = `
      <div class="row-1">
        <span class="ev-date">${formatUpcomingDate(t.start_at)}</span>
        <span class="ev-name">${escapeHtml(t.tournament_name)}</span>
        <a class="ev-link" href="${escapeHtml(ttoUrl)}" target="_blank" rel="noopener" title="start.gg で開く" aria-label="start.gg で開く">↗</a>
      </div>
      <div class="row-2">
        ${cityHtml}${onlineHtml}
        <span>${(t.events || []).length} event</span>
      </div>
      <div class="upcoming-events"></div>
    `;
    row.addEventListener('click', (ev) => {
      // start.gg リンクアイコンは通常リンク動作 (= 新規タブで開く)
      if (ev.target.closest('.ev-link')) return;
      // event 行クリックは個別 handler が処理 (stopPropagation)
      handleUpcomingItemClick(t, row);
    });
    list.appendChild(row);
  }
  list.style.display = '';
  pager.style.display = totalPages > 1 ? '' : 'none';
  document.getElementById('upcoming-pageinfo').textContent = `${UPCOMING_PAGE + 1} / ${totalPages}`;
  document.getElementById('upcoming-prev').disabled = UPCOMING_PAGE === 0;
  document.getElementById('upcoming-next').disabled = UPCOMING_PAGE >= totalPages - 1;
}

function handleUpcomingItemClick(tournament, rowEl) {
  const events = tournament.events || [];
  if (events.length === 0) return;
  if (events.length === 1) {
    // 単独 event → URL 入力 + 自動取得
    const url = buildEventUrl(tournament.tournament_slug, events[0].event_slug);
    fillEventUrlAndFetch(url);
    return;
  }
  // 複数 event → inline 展開 (= toggle)
  const wrap = rowEl.querySelector('.upcoming-events');
  if (rowEl.classList.contains('expanded')) {
    rowEl.classList.remove('expanded');
    return;
  }
  // ほかの展開を閉じる
  document.querySelectorAll('.upcoming-item.expanded').forEach(it => {
    if (it !== rowEl) it.classList.remove('expanded');
  });
  wrap.innerHTML = renderEventChoicesHtml(events);
  // bind clicks
  wrap.querySelectorAll('.upcoming-event-row').forEach((er, idx) => {
    er.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const e = events[idx];
      const url = buildEventUrl(tournament.tournament_slug, e.event_slug);
      fillEventUrlAndFetch(url);
    });
  });
  rowEl.classList.add('expanded');
}

function renderEventChoicesHtml(events) {
  return events.map(e => {
    const name = escapeHtml(e.event_name || e.name || '');
    const entrants = e.num_entrants != null ? e.num_entrants : (e.numEntrants || 0);
    return `<div class="upcoming-event-row">
      <span class="ev-event-name">${name}</span>
      <span class="ev-event-entrants">${entrants} 名</span>
    </div>`;
  }).join('');
}

function fillEventUrlAndFetch(url) {
  const inp = document.getElementById('event-url');
  if (!inp) return;
  inp.value = url;
  // Hide any prior event-picker
  const ep = document.getElementById('event-picker');
  if (ep) ep.style.display = 'none';
  // Trigger fetch
  handleFetch();
  // Scroll user to the table for feedback
  const status = document.getElementById('status');
  if (status) status.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 現在時刻以降の大会だけカウント (= 過去大会を除外).
function countUpcomingFuture() {
  const nowSec = Math.floor(Date.now() / 1000);
  return ((UPCOMING_DATA || {}).tournaments || []).filter(t => {
    const st = Number(t.start_at);
    return Number.isFinite(st) && st >= nowSec;
  }).length;
}

async function openUpcomingBox() {
  const box = document.getElementById('upcoming-box');
  box.classList.add('open');
  const loading = document.getElementById('upcoming-loading');
  const list = document.getElementById('upcoming-list');
  const countBadge = document.getElementById('upcoming-count');
  if (UPCOMING_DATA) {
    loading.style.display = 'none';
    renderUpcomingPage();
    countBadge.textContent = countUpcomingFuture();
    countBadge.style.display = '';
    return;
  }
  loading.style.display = '';
  list.style.display = 'none';
  try {
    await loadUpcomingData();
    loading.style.display = 'none';
    const n = countUpcomingFuture();
    countBadge.textContent = n;
    countBadge.style.display = '';
    if (n === 0) {
      loading.textContent = '直近 3 週間の SSBU 大会は見つかりませんでした';
      loading.style.display = '';
      return;
    }
    renderUpcomingPage();
  } catch (e) {
    loading.innerHTML = '<span style="color:#dc2626">upcoming.json の取得に失敗: ' + escapeHtml(e.message) + '</span>';
  }
}

function toggleUpcomingBox() {
  const box = document.getElementById('upcoming-box');
  if (box.classList.contains('open')) {
    box.classList.remove('open');
  } else {
    openUpcomingBox();
  }
}

// ── event-picker (= handleFetch 複数 event 警告の inline UI) ─────
// 上記 renderEventChoicesHtml を再利用.
function showEventPickerInline(tournamentSlug, events) {
  const ep = document.getElementById('event-picker');
  const listEl = document.getElementById('event-picker-list');
  if (!ep || !listEl) return;
  listEl.innerHTML = renderEventChoicesHtml(events.map(e => ({
    event_name: e.name, num_entrants: e.numEntrants, event_slug: e.slug,
  })));
  // CSS は #event-picker { display: none } なので '' (= unset) だと CSS が効いて非表示のまま.
  // 'block' で override する.
  ep.style.display = 'block';
  // bind clicks
  Array.from(listEl.querySelectorAll('.upcoming-event-row')).forEach((er, idx) => {
    er.addEventListener('click', () => {
      const e = events[idx];
      const url = buildEventUrl(tournamentSlug, e.slug);
      fillEventUrlAndFetch(url);
    });
  });
  ep.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Seed page bootstrap ──
(function () {
  const tokenEl = document.getElementById('token');
  const hintEl = document.getElementById('token-hint');
  const revealBtn = document.getElementById('token-reveal');
  const saveBtn = document.getElementById('token-save');
  const TOKEN_KEY = 'spsp_startgg_token';

  function updateHint() {
    const v = tokenEl.value.trim();
    if (!v) { hintEl.textContent = ''; return; }
    const tail = v.slice(-4);
    hintEl.textContent = `末尾: ${tail} (${v.length} 文字)`;
  }
  // Restore token: localStorage 優先 (永続化)、なければ sessionStorage (タブ単位)
  try {
    const t = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem('smash_banzuke_token');
    if (t) { tokenEl.value = t; updateHint(); }
  } catch (e) {}
  tokenEl.addEventListener('input', () => {
    updateHint();
    try { sessionStorage.setItem('smash_banzuke_token', tokenEl.value); } catch (e) {}
  });
  revealBtn.addEventListener('click', () => {
    const isPwd = tokenEl.type === 'password';
    tokenEl.type = isPwd ? 'text' : 'password';
    revealBtn.textContent = isPwd ? '🙈' : '👁';
  });
  saveBtn.addEventListener('click', () => {
    const v = tokenEl.value.trim();
    if (!v) { hintEl.textContent = 'トークン未入力'; return; }
    try {
      localStorage.setItem(TOKEN_KEY, v);
      const orig = saveBtn.textContent;
      saveBtn.textContent = '✅ 保存済み';
      saveBtn.disabled = true;
      setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 1500);
    } catch (e) { hintEl.textContent = '保存失敗: ' + e.message; }
  });

  document.getElementById('seed-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleFetch();
  });
  document.getElementById('csv-btn').addEventListener('click', downloadCsv);
  // createPhaseThenUpload 等の throw を握りつぶさず status に出す
  document.getElementById('upload-btn').addEventListener('click', () => {
    uploadToStartgg().catch(e => showError(e.message, e.rawError));
  });
  // 被り回避最適化パネル
  document.getElementById('so-run').addEventListener('click', () => {
    runSeedOptimize().catch(e => {
      document.getElementById('so-progress').textContent = '⚠ ' + e.message;
      cleanupSeedOptWorker();   // 途中 throw でも実行ボタンを必ず戻す
    });
  });
  document.getElementById('so-stop').addEventListener('click', stopSeedOptimize);
  document.getElementById('so-cancel').addEventListener('click', cancelSeedOptimize);
  document.getElementById('so-mode').addEventListener('change', applyModeDefaults);
  document.getElementById('so-orderpow').addEventListener('input', () => {
    document.getElementById('so-orderpow-val').textContent = document.getElementById('so-orderpow').value;
  });
  // プール数に応じて「プール内変動」トグルの有効/無効を切り替える（2プール以上のみ指定可能）。
  document.getElementById('so-pools').addEventListener('input', updateIntraToggleState);

  // ── 直近の大会ピッカー: イベント binding ──
  const upToggle = document.getElementById('upcoming-toggle');
  if (upToggle) upToggle.addEventListener('click', toggleUpcomingBox);
  const upPrev = document.getElementById('upcoming-prev');
  if (upPrev) upPrev.addEventListener('click', () => {
    if (UPCOMING_PAGE > 0) { UPCOMING_PAGE -= 1; renderUpcomingPage(); }
  });
  const upNext = document.getElementById('upcoming-next');
  if (upNext) upNext.addEventListener('click', () => {
    const total = (UPCOMING_DATA && UPCOMING_DATA.tournaments) ? UPCOMING_DATA.tournaments.length : 0;
    const totalPages = Math.max(1, Math.ceil(total / UPCOMING_PAGE_SIZE));
    if (UPCOMING_PAGE < totalPages - 1) { UPCOMING_PAGE += 1; renderUpcomingPage(); }
  });
  // 開いた状態で起動するので初期 load を即実行
  if (document.getElementById('upcoming-box').classList.contains('open')) {
    openUpcomingBox();
  }
})();

// ───────────────────────── 被り回避最適化パネル ─────────────────────────
let SEEDOPT_WORKER = null;
let SEEDOPT_RESULT = null;
let SEEDOPT_ROUND_STATS = [];   // 各最適化ラウンドのステップ統計 [{round, iters, maxIters}]

// データ取得後にパネルを初期化（プール数 / 形式を既定で埋める）。
function soFormat() {
  // 形式は start.gg の bracketType から自動。取得できなければ DE 想定。
  const bt = EVENT_CONTEXT && EVENT_CONTEXT.bracketType;
  return (bt === 'SINGLE_ELIMINATION' || bt === 'ROUND_ROBIN') ? bt : 'DOUBLE_ELIMINATION';
}
// 探索モードに応じて多点数/SA冷却率の既定をミラー（optimizer の MODE_DEFAULTS と一致）。
function applyModeDefaults() {
  const md = (window.SeedOptimizer && SeedOptimizer.MODE_DEFAULTS) || {};
  const m = document.getElementById('so-mode').value;
  const d = md[m] || {};
  if (d.restarts != null) document.getElementById('so-restarts').value = d.restarts;
  if (d.saCooling != null) document.getElementById('so-cooling').value = d.saCooling;
  if (d.maxItersScale != null) document.getElementById('so-itersscale').value = d.maxItersScale;
}
// 大会規模ごとのシードズレ上限の既定値 [±0, ±1, ±2, ±3, ±4 それぞれ「〜位まで」]。
// 上位ほど絶対的な意味が強いので厳しく、規模が大きいほど深い帯まで段階をかける。
function shiftPresetForSize(n) {
  if (!n) return null;
  if (n <= 48) return [null, 8, 16, 24, null];     // 〜32人規模: ±1≤8 / ±2≤16 / ±3≤24 / 25位〜無制限
  if (n <= 160) return [null, 16, 32, 64, null];   // 〜128人規模
  if (n <= 320) return [null, 16, 32, 64, 128];    // 〜256人規模
  if (n <= 640) return [null, 24, 48, 96, 192];    // 〜512人規模
  return [null, 32, 64, 128, 256];                 // 1024人規模〜
}
// 規模別既定を入れる。全欄が空、または「前回の自動プリセットのまま (手入力なし)」の
// ときだけ上書きする — 別の大会を読み込み直したら新しい規模の既定に更新される。
// ユーザーが1欄でも書き換えていたら触らない。
let _lastShiftPrefill = null;   // 直近に自動で入れた値 (['','16',…] 形式)
function prefillShiftLimits(n) {
  const els = ['so-shift0', 'so-shift1', 'so-shift2', 'so-shift3', 'so-shift4']
    .map(id => document.getElementById(id));
  if (els.some(e => !e)) return;
  const cur = els.map(e => (e.value || '').trim());
  const untouched = cur.every(v => v === '') ||
    (_lastShiftPrefill != null && cur.every((v, k) => v === _lastShiftPrefill[k]));
  if (!untouched) return;
  const p = shiftPresetForSize(n);
  if (!p) return;
  const vals = p.map(v => (v != null ? String(v) : ''));
  els.forEach((e, k) => { e.value = vals[k]; });
  _lastShiftPrefill = vals;
}
// 「プール内変動」トグルは 2プール以上のときだけ指定可能。
// 1プール×DE では intra が唯一の被り回避なので常に実行＝チェックは固定・無効表示。
function updateIntraToggleState() {
  const cb = document.getElementById('so-enable-intra');
  if (!cb) return;
  const pools = Math.max(1, parseInt((document.getElementById('so-pools') || {}).value, 10) || 1);
  const lbl = cb.closest('label');
  cb.disabled = pools < 2;
  if (lbl) lbl.style.opacity = pools < 2 ? '0.4' : '';
}
function initSeedOptPanel() {
  const poolsEl = document.getElementById('so-pools');
  if (!poolsEl) return;
  // 別イベント/フェーズの取得で呼ばれる。走行中の worker が残っていると
  // 古い結果が新しいデータの上に done で届いて適用できてしまうため、必ず止める。
  cleanupSeedOptWorker();
  applyModeDefaults();
  // プール数の既定: start.gg から取得できたプール数 → なければ phase 作成 UI のプール数 → 1。
  const fetched = EVENT_CONTEXT && EVENT_CONTEXT.poolCount;
  if (Number.isFinite(fetched) && fetched >= 1) {
    poolsEl.value = fetched;
  } else {
    const pc = parseInt((document.getElementById('pc-group-count') || {}).value, 10);
    if (Number.isFinite(pc) && pc >= 1) poolsEl.value = pc;
  }
  // 形式は自動取得 → ラベル表示のみ。
  const fmtJa = { DOUBLE_ELIMINATION: 'ダブルイリミネーション', SINGLE_ELIMINATION: 'シングルイリミネーション', ROUND_ROBIN: '総当たり' }[soFormat()];
  const bt = EVENT_CONTEXT && EVENT_CONTEXT.bracketType;
  document.getElementById('so-format-label').textContent = `形式: ${fmtJa}${bt ? '（自動取得）' : '（未取得→DE想定）'}`;
  // ウェーブ数: start.gg のプール名 (A1,B2,…) から自動取得できたらそれを既定に。
  // 取得できない/失敗はラベルで明示し、手動設定に任せる (黙ってウェーブなし扱いにしない)。
  const wavesEl = document.getElementById('so-waves');
  const wavesLbl = document.getElementById('so-waves-label');
  const wv = EVENT_CONTEXT && EVENT_CONTEXT.waves;
  if (wavesEl && wavesLbl) {
    if (wv && Array.isArray(wv.poolToWave)) {
      wavesEl.value = wv.waveCount;
      wavesLbl.textContent = wv.waveCount >= 2
        ? `（自動取得: ${wv.identifiers[0]}〜${wv.identifiers[wv.identifiers.length - 1]} / ${wv.poolCount}プール）`
        : '（自動取得: ウェーブ分けなし）';
    } else {
      wavesEl.value = 1;
      wavesLbl.textContent = (wv && wv.error)
        ? '（自動取得失敗 → 手動設定してください）'
        : '（自動取得なし → 手動設定可）';
    }
  }
  // シードズレ上限の規模別既定 (全欄が空のときだけ)。
  prefillShiftLimits(DATA.length);
  document.getElementById('so-report').innerHTML = '';
  document.getElementById('so-progress').textContent = '';
  showOptCancelBtn(false);
  SEEDOPT_ROUND_STATS = [];
  updateIntraToggleState();
  SEEDOPT_RESULT = null;
}

function clearSeedOptApplied() {
  const r = document.getElementById('so-report');
  if (r) {
    const banner = r.querySelector('.seedopt-applied-banner');
    if (banner) banner.remove();
  }
  render();
}

/** 「最適化を取り消す」ボタンの表示。 */
function showOptCancelBtn(on) {
  const b = document.getElementById('so-cancel');
  if (!b) return;
  b.style.display = on ? '' : 'none';
  b.disabled = !on;
}

/**
 * 反映中の最適化順を解除する (= 基準ランキングが変わったとき)。
 * 取り消しボタンで戻る先も一緒に捨てる (基準が変わっているので戻せない)。
 * opts.render === false なら描画しない (DATA 入れ替え中など)。
 */
function dropAppliedOrder(opts) {
  const had = !!APPLIED_ORDER;
  APPLIED_ORDER = null;
  PRE_OPT = null;
  showOptCancelBtn(false);
  if (had && (!opts || opts.render !== false)) clearSeedOptApplied();
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function runSeedOptimize() {
  if (!DATA.length || !EVENT_CONTEXT) { return; }
  const progress = document.getElementById('so-progress');
  const reportEl = document.getElementById('so-report');
  reportEl.innerHTML = '';
  showOptCancelBtn(false);

  const poolCount = Math.max(1, parseInt(document.getElementById('so-pools').value, 10) || 1);
  const format = soFormat();   // start.gg bracketType から自動

  // 入力ランキング = 現在の基準順。手動調整があればそれを基準にする
  // (「手動調整 → 被り回避」の流れ)。無ければ currentMethod 順 (適用済み最適化は解除して基準に戻す)。
  const baseRecs = MANUAL
    ? (() => {
        const pos = new Map(manualOrder().map((u, i) => [u, i]));
        return DATA.slice().sort((a, b) =>
          (pos.has(a.user_id) ? pos.get(a.user_id) : 1e9) - (pos.has(b.user_id) ? pos.get(b.user_id) : 1e9));
      })()
    : DATA.slice().sort((a, b) => (a.ranks[currentMethod] || 1e9) - (b.ranks[currentMethod] || 1e9));
  // 固定射影を基準にも適用 (manualOrder 経由は適用済みだが冪等なので常にかける)。
  // これで optimizer の origRank プール == 固定対象プールになり、ハード制約と整合する。
  const ranking = _projectSeedLocks(baseRecs.map(r => r.user_id).filter(u => u != null));
  const displayOf = {};
  for (const r of DATA) displayOf[r.user_id] = r.display;

  // 非対応形式を事前判定（worker でも返るが、取得前に弾く）。
  const scopeWinners = document.getElementById('so-scope-winners').checked;
  if (scopeWinners && format !== 'DOUBLE_ELIMINATION') {
    progress.textContent = '⚠ 勝者側ブラケット最適化はダブルイリミネーションのみ対応です。';
    return;
  }
  if (poolCount === 1 && format !== 'DOUBLE_ELIMINATION') {
    progress.textContent = '⚠ 1プール×ダブルイリミネーション以外は被り回避非対応です。';
    return;
  }

  // CSV → 数値配列（空欄なら undefined＝既定を使う）。
  const csvNums = (id) => {
    const v = (document.getElementById(id).value || '').trim();
    if (!v) return undefined;
    const arr = v.split(',').map(s => parseFloat(s.trim())).filter(x => Number.isFinite(x));
    return arr.length ? arr : undefined;
  };
  // 主要トグル（地域被り/直近対戦を避けるか・プール内変動するか）。
  const avoidRegion = document.getElementById('so-avoid-region').checked;
  const avoidRecent = document.getElementById('so-avoid-recent').checked;
  const enableIntra = document.getElementById('so-enable-intra').checked;
  // 追加制約トグル: DE 想定順位不変 / 平日大会（実質平日・プレ含む）の対戦を考慮しない。
  const keepDePlace = document.getElementById('so-keep-deplace').checked;
  // 「平日大会を含む」(既定OFF) の反転が excludeWeekday (= 既定で平日を除外)。
  const excludeWeekday = !document.getElementById('so-include-weekday').checked;
  // 地域グルーピングのトグル（南関東 / 兵庫・大阪・京都）。
  const groupMinamiKanto = document.getElementById('so-group-minamikanto').checked;
  const groupKeihanshin = document.getElementById('so-group-keihanshin').checked;
  // 数値入力: 「0」を有効値として受ける（`|| 既定` だと 0 が黙って既定に化ける）。
  // 空欄/非数のときだけ既定へ。
  const numDef = (id, def) => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? v : def; };
  const intDef = (id, def) => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? v : def; };
  const params = {
    mode: document.getElementById('so-mode').value,
    restarts: Math.max(1, intDef('so-restarts', 15)),
    saCooling: Math.min(0.9999, Math.max(0.5, numDef('so-cooling', 0.999))),
    maxItersScale: Math.max(10, intDef('so-itersscale', 1000)),
    rngSeed: intDef('so-rngseed', 12345),
    avoidRegion, avoidRecent, enableIntra, keepDePlace,
    bracketScope: scopeWinners ? 'winners' : undefined,   // undefined→既定 'pools'
    // シードズレ上限の段階指定 ([±0,±1,±2,±3,±4] それぞれ「何位まで」)。全空欄なら未指定。
    shiftLimitRanks: (() => {
      const arr = ['so-shift0', 'so-shift1', 'so-shift2', 'so-shift3', 'so-shift4']
        .map(id => { const v = parseInt(document.getElementById(id).value, 10); return Number.isFinite(v) ? Math.max(1, v) : null; });
      return arr.some(v => v != null) ? arr : undefined;
    })(),
    W_region: numDef('so-wregion', 1.0),
    W_recent: numDef('so-wrecent', 0.3),
    W_order: Math.max(0, numDef('so-worder', 0)),
    orderPow: Math.max(0, numDef('so-orderpow', 2)),   // ズレ数調整スライダー (0〜5, 0.5刻み。0=ズレを罰しない)
    prefWeight: document.getElementById('so-prefweight').value,
    roundWeights: csvNums('so-roundweights'),   // undefined→既定
    kInter: csvNums('so-kinter'),
    kIntra: csvNums('so-kintra'),
    // 空欄＝制限なし(null)。0 は「一切動かさない」として有効。
    maxSeedShift: (() => { const v = intDef('so-maxshift', null); return v != null ? Math.max(0, v) : undefined; })(),
  };
  // プール/ウェーブ固定 (シード指定・固定パネル / 手動調整の📌)。ranking に居る uid のみ渡す。
  const waveMap = currentWaveMap(poolCount);
  const rankingSet = new Set(ranking);
  const seedLocks = {};
  if (SEED_SPEC && SEED_SPEC.locks) {
    for (const k in SEED_SPEC.locks) {
      const u = manualParseUid(k);
      if (!rankingSet.has(u)) continue;
      const v = SEED_SPEC.locks[k];
      // optimizer へは種別のみ渡す ('pool'|'wave')。対象は射影済みの基準位置に反映済み。
      seedLocks[u] = (v && v.kind) || v;
    }
  }
  const lockUids = Object.keys(seedLocks);
  if (lockUids.length) {
    params.seedLocks = seedLocks;
    params.poolWaves = waveMap;
  }
  // undefined のキーは optimizer 既定に任せる（明示的に消す）。
  Object.keys(params).forEach(k => { if (params[k] === undefined) delete params[k]; });
  // シードズレ上限の昇順チェック (optimizer でも throw するが、取得前にわかりやすく弾く)。
  if (params.shiftLimitRanks) {
    let prev = 0;
    for (const v of params.shiftLimitRanks) {
      if (v == null) continue;
      if (v <= prev) { progress.textContent = '⚠ シードズレ上限は左の欄 (小さいズレ幅) ほど小さい順位にしてください。'; return; }
      prev = v;
    }
  }
  // 減衰の制御点 "日:重み,..." をパース（空欄なら既定）。
  const dpRaw = (document.getElementById('so-decaypoints').value || '').trim();
  let recentDecayPoints;
  if (dpRaw) {
    const pts = dpRaw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
      const [d, w] = s.split(':').map(x => parseFloat(x));
      return [d, w];
    }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (pts.length >= 2) recentDecayPoints = pts;
  }
  const sizeWeight = document.getElementById('so-sizeweight').value;
  const recentAgg = document.getElementById('so-recentagg').value;

  document.getElementById('so-run').disabled = true;
  progress.textContent = `データ取得中… (${ranking.length} 名の居住地・対戦履歴)`;

  // 1) 取得・集計（メインスレッド。fetch はここだけ）。
  let bundle;
  try {
    const dataParams = { sizeWeight, recentAgg, excludeWeekday };
    if (recentDecayPoints) dataParams.recentDecayPoints = recentDecayPoints;  // 空欄なら既定を使う
    // 地域グルーピング表をトグルから構築（避けない地域があっても prefByUid 計算は行い、罰則側で無効化）。
    const regionGroups = SeedData.buildRegionGroups({ minamiKanto: groupMinamiKanto, keihanshin: groupKeihanshin });
    bundle = await SeedData.buildSeedData(ranking, {
      prefix: '../',
      regionGroups,
      // 地域被り回避 OFF のときは居住地データはレポート表示にしか使わないので、
      // 取得失敗で全体を止めない（meta.prefsError で明示される）。
      prefsOptional: !avoidRegion,
      params: dataParams,
      onProgress: (p) => {
        if (p.phase === 'fetch') progress.textContent = `選手データ取得中 ${p.done}/${p.total}…`;
      },
    });
  } catch (e) {
    progress.textContent = '⚠ データ取得に失敗: ' + e.message;
    document.getElementById('so-run').disabled = false;
    return;
  }
  // 取得状況（同意なきフォールバック禁止 → missing/errors を明示）。
  const m = bundle.meta;
  let note = `居住地特定 ${m.prefIdentified}/${m.attendees} 名`;
  if (excludeWeekday) note += ` · 平日大会の対戦 ${m.weekdayExcludedMatches || 0} 試合を考慮外`;
  if (m.missing.length) note += ` · DB未登録 ${m.missing.length} 名（対戦履歴なし扱い）`;
  if (m.errors.length) note += ` · ⚠ 取得失敗 ${m.errors.length} 名`;
  if (m.prefsError) note += ` · ⚠ 居住地データ取得失敗（地域表示なし）`;
  if (lockUids.length) {
    const nPool = lockUids.filter(u => seedLocks[u] === 'pool').length;
    const nWave = lockUids.length - nPool;
    note += ` · 📌固定 ${[nPool ? `プール${nPool}名` : '', nWave ? `ウェーブ${nWave}名` : ''].filter(Boolean).join('/')}`;
    if (nWave && waveMap.every(w => w === 0)) note += `（⚠ ウェーブ数1のためウェーブ固定は無制約）`;
  }

  // 2) Worker で最適化。生成/起動の失敗（404, CSP, clone不能など）は onmessage に
  //    乗らないため、onerror と try/catch の両方で必ず cleanup してボタンを戻す。
  try {
    if (SEEDOPT_WORKER) { SEEDOPT_WORKER.terminate(); SEEDOPT_WORKER = null; }
    SEEDOPT_WORKER = new Worker('../seeding/seed_worker.js');
    document.getElementById('so-stop').style.display = '';
    document.getElementById('so-stop').disabled = false;

    SEEDOPT_WORKER.onerror = (err) => {
      progress.textContent = '⚠ Worker エラー: ' + (err && err.message ? err.message : 'seed_worker.js の読み込み/実行に失敗しました');
      cleanupSeedOptWorker();
    };
    SEEDOPT_WORKER.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'progress') {
        // このラウンドの何%処理中か (iter/maxIters)。phase 単位で 0→100% が進む。
        const pct = (msg.iter != null && msg.maxIters > 0)
          ? ` ${Math.min(100, msg.iter / msg.maxIters * 100).toFixed(0)}%` : '';
        progress.textContent = msg.stage === 'stop-requested'
          ? `${note} ｜ 停止要求受付 — 現在のラウンド完了後に停止します`
          : `${note} ｜ 最適化中 ラウンド ${msg.round + 1}/${msg.restarts} (${msg.phase || ''}${pct})`;
      } else if (msg.type === 'checkpoint') {
        const imp = msg.beforeScore > 0 ? ((1 - msg.bestScore / msg.beforeScore) * 100).toFixed(1) : '0.0';
        // このラウンドのステップ数% を蓄積 (phase 合算)。
        let stepTxt = '';
        if (Array.isArray(msg.roundStats)) {
          const it = msg.roundStats.reduce((s, x) => s + (x.iters || 0), 0);
          const mx = msg.roundStats.reduce((s, x) => s + (x.maxIters || 0), 0);
          SEEDOPT_ROUND_STATS.push({ round: msg.round + 1, iters: it, maxIters: mx });
          if (mx > 0) stepTxt = ` ｜ このラウンドのステップ ${(it / mx * 100).toFixed(0)}%`;
        }
        progress.textContent = `${note} ｜ 最適化中 (${msg.round + 1}/${msg.restarts}) 暫定改善 ${imp}%${stepTxt}`;
        // 各ラウンド終了時の中間レポート (ここまでのベスト解)。
        if (msg.intermediate) {
          finishSeedOptimize(msg.intermediate, displayOf, note, ranking,
            { round: msg.round + 1, restarts: msg.restarts });
        }
      } else if (msg.type === 'done') {
        finishSeedOptimize(msg.result, displayOf, note, ranking);
      } else if (msg.type === 'error') {
        progress.textContent = '⚠ 最適化エラー: ' + msg.message;
        cleanupSeedOptWorker();
      }
    };
    SEEDOPT_WORKER.postMessage({ type: 'start', input: {
      poolCount, format, ranking,
      prefByUid: bundle.prefByUid, prefCounts: bundle.prefCounts,
      recentPair: bundle.recentPair, recentMeta: bundle.recentMeta,
      params,
    } });
  } catch (e) {
    progress.textContent = '⚠ Worker 起動に失敗: ' + e.message;
    cleanupSeedOptWorker();
  }
}

function stopSeedOptimize() {
  if (!SEEDOPT_WORKER) return;
  SEEDOPT_WORKER.postMessage({ type: 'stop' });
  // 停止はリスタート境界でしか効かない（worker 内の optimize は同期実行）。
  // 二重押し防止とフィードバックのためボタンを無効化して状況を表示する。
  const stopBtn = document.getElementById('so-stop');
  if (stopBtn) stopBtn.disabled = true;
  const progress = document.getElementById('so-progress');
  if (progress) progress.textContent = '停止要求送信 — 現在の探索ラウンド完了後に停止します…';
}

// 結果パネルを破棄して初期状態へ（基準ランキング変更時など）。
function resetSeedOptResultPanel(msg) {
  SEEDOPT_RESULT = null;
  const r = document.getElementById('so-report'); if (r) r.innerHTML = '';
  showOptCancelBtn(false);
  const p = document.getElementById('so-progress'); if (p) p.textContent = msg || '';
}
function cleanupSeedOptWorker() {
  document.getElementById('so-run').disabled = false;
  document.getElementById('so-stop').style.display = 'none';
  // 実行開始時に隠した取り消しボタンを戻す。前回の反映が残ったまま失敗・中断した
  // ときに「反映中なのに取り消せない」状態にしないため。
  showOptCancelBtn(!!APPLIED_ORDER);
  if (SEEDOPT_WORKER) {
    // terminate 前にハンドラを外す: キュー済みの done/error が terminate 後に
    // 届いて古い結果を描画するのを防ぐ。
    SEEDOPT_WORKER.onmessage = null;
    SEEDOPT_WORKER.onerror = null;
    SEEDOPT_WORKER.terminate();
    SEEDOPT_WORKER = null;
  }
}

function finishSeedOptimize(result, displayOf, note, ranking, interInfo) {
  // interInfo = {round, restarts} のとき「各ラウンド終了時の中間レポート」描画:
  // worker は動かしたまま、apply は最終完了まで無効のままレポートだけ更新する。
  const progress = document.getElementById('so-progress');
  if (result && result.unsupported) {
    cleanupSeedOptWorker();
    progress.textContent = '⚠ ' + result.reason;
    return;
  }
  if (!interInfo) {
    cleanupSeedOptWorker();
    SEEDOPT_RESULT = result;
    progress.textContent = `${note} ｜ 完了${result.stoppedEarly ? '（中断）' : ''}`;
  }
  const rep = result.report;
  const imp = rep.improvementPct.toFixed(1);

  // レポート描画: {プール間, プール内} × {同一地域, 直近対戦} の4セル。
  const dn = (u) => escHtml(displayOf[u] || u);
  const rc = rep.residualConcerns;
  const rcB = rep.residualConcernsBefore || null;   // 最適化前 (前後比較用)
  // 各項目 = 最適化後 (薄緑) + 折りたたみの「最適化前」(グレー・タップで展開)。
  // key は再描画時の開閉状態保持 (data-k) に使う。
  function beforeAfter(key, beforeHtml, afterHtml) {
    if (beforeHtml == null) return afterHtml;
    return `<div style="border:1px solid #dcfce7;border-radius:6px;padding:6px 8px;background:#f0fdf4;margin-top:3px">` +
        `<div style="font-size:10px;font-weight:700;color:#16a34a;margin-bottom:2px">最適化後</div>${afterHtml}</div>` +
      `<details data-k="ba-${key}" style="margin-top:3px"><summary style="cursor:pointer;font-size:10px;font-weight:700;color:#6b7280">最適化前を表示</summary>` +
        `<div style="border:1px solid #e5e7eb;border-radius:6px;padding:6px 8px;background:#f3f4f6;margin-top:2px">${beforeHtml}</div></details>`;
  }
  const sectionHead = (t) => `<div style="margin-top:10px;padding-top:6px;border-top:1px solid #e5e7eb;font-weight:700;font-size:12px;color:#111827">${t}</div>`;
  const ul = (items) => items.length ? `<ul style="margin:3px 0 0;padding-left:18px;font-size:11px;color:#374151">${items.map(x => `<li>${x}</li>`).join('')}</ul>` : '';
  const ok = (t) => `<div style="margin-top:3px;font-size:11px;color:#16a34a">✅ ${t}</div>`;
  const warn = (t) => `<div style="margin-top:5px;font-weight:600;font-size:11px;color:#b91c1c">⚠ ${t}</div>`;

  // 同一地域セルの描画（separable=要改善, majority=不可避）。
  function regionCell(reg, withRound) {
    let h = '';
    const sep = reg.separable || {}, prefs = Object.keys(sep);
    const sepN = reg.separablePairs != null ? reg.separablePairs : (reg.separableEarlyPairs || 0);
    const sepObj = reg.separable || reg.separableEarly || {};
    const sepK = Object.keys(sepObj);
    if (sepK.length) {
      h += warn(`分散できるはずの地域に残る被り ${sepN} 組`);
      h += ul(sepK.map(pf => `<strong>${escHtml(pf)}</strong>（${sepObj[pf][0].prefCount}名）: ` +
        sepObj[pf].map(x => `${dn(x.a)}×${dn(x.b)}(P${x.pool + 1}${withRound ? '/' + x.round + '回戦' : ''})`).join('、')));
    } else {
      h += ok('分散できる地域はすべて別プール（少人数地域の被りなし）');
    }
    if (reg.majority && Object.keys(reg.majority).length) {
      const mp = Object.keys(reg.majority);
      h += `<div style="margin-top:3px;font-size:11px;color:#9ca3af">人数が多く回避不能な地域: ${mp.map(pf => `${escHtml(pf)} ${reg.majority[pf]}組`).join('、')}（計${reg.majorityPairs}組）</div>`;
    }
    return h;
  }
  // ③ プール内×同一地域: 早期回戦で当たる同地域ペアを列挙（最多地域は除外）。
  function intraRegionCell(reg, earlyRound) {
    const ex = reg.excludedRegion ? `（最多地域 ${escHtml(reg.excludedRegion)} は除外）` : '';
    if (!reg.earlyPairs) {
      return ok(`同地域が ${earlyRound}回戦以内で当たる組み合わせなし${ex}`);
    }
    let h = warn(`同地域が ${earlyRound}回戦以内で当たる: ${reg.earlyPairs} 組${ex}`);
    h += ul(reg.earlyMatchups.map(x =>
      `<strong>${escHtml(x.region)}</strong>: ${dn(x.a)} × ${dn(x.b)}（P${x.pool + 1} / ${x.round}回戦）`));
    if (reg.earlyPairs > reg.earlyMatchups.length) {
      h += `<div style="font-size:11px;color:#9ca3af">…ほか ${reg.earlyPairs - reg.earlyMatchups.length} 組</div>`;
    }
    return h;
  }
  // 直近対戦セルの描画。
  function recentCell(recent, withRound) {
    let h = `<div style="margin-top:5px;font-size:11px;color:#374151">同プールに残る直近対戦: <strong>${recent.pairs}</strong> 組${recent.top.length ? '（上位）' : ''}</div>`;
    if (!recent.top.length) return h;
    // 各ペアはタップで過去の対戦履歴（日付・大会名・規模）を展開できる <details>。
    h += `<div style="margin:3px 0 0;padding-left:6px;font-size:11px;color:#374151">`;
    h += recent.top.map(c => {
      const t = c.lastTournament
        ? ` ${escHtml(c.lastTournament)}${c.lastNent != null ? `〈${c.lastNent}人〉` : ''}`
        : '';
      const line = `${dn(c.a)} × ${dn(c.b)}（P${c.pool + 1}${withRound ? ' / ' + c.round + '回戦' : ''} / ${c.count}回, 最終${c.lastDate}${t}）`;
      const ms = Array.isArray(c.matches) ? c.matches : [];
      if (!ms.length) return `<div style="padding:1px 0 1px 12px">${line}</div>`;
      const hist = ms.map(m =>
        `<div>${escHtml(m.date || '?')} ${m.tournament ? escHtml(m.tournament) : '（大会名不明）'}${m.nent != null ? `〈${m.nent}人〉` : ''}</div>`
      ).join('');
      return `<details style="padding:1px 0"><summary style="cursor:pointer">${line}</summary>` +
        `<div style="margin:2px 0 4px 18px;color:#6b7280">${hist}</div></details>`;
    }).join('');
    h += `</div>`;
    return h;
  }

  // 各プールの地域バランス（① 用）。地域ごとのプール間分布と、各プールの内訳。
  function regionBalanceCell(reg) {
    const spread = reg.spread || {};
    const regs = Object.keys(spread).sort((a, b) => spread[b].total - spread[a].total);
    let h = '';
    if (!regs.length) { return ok('地域データのある選手がいません'); }
    // 地域ごとの分布（min–max/プール）。完全均等なら max−min ≤ 1。
    const uneven = regs.filter(r => spread[r].max - spread[r].min >= 2);
    h += uneven.length
      ? warn(`プール間でばらつきの大きい地域 ${uneven.length} 件（下表で確認）`)
      : ok('全地域がプール間でほぼ均等（各プールの差 ≤ 1名）');
    h += ul(regs.map(r => {
      const s = spread[r];
      const bad = (s.max - s.min) >= 2;
      const mark = bad ? '⚠' : '';
      return `<span style="${bad ? 'color:#b91c1c;font-weight:600' : ''}">${escHtml(r)}（計${s.total}名）: 各プール ${s.min}–${s.max}名 ${mark}</span>`;
    }));
    // 各プールの内訳（detail）。
    const comp = reg.poolComposition || [];
    h += `<details style="margin-top:4px"><summary style="font-size:11px;color:#6b7280;cursor:pointer">各プールの地域内訳</summary>`;
    h += `<div style="font-size:11px;color:#374151;margin-top:3px">`;
    comp.forEach((pc, i) => {
      const parts = Object.keys(pc.counts).sort((a, b) => pc.counts[b] - pc.counts[a])
        .map(r => `${escHtml(r)}${pc.counts[r]}`);
      if (pc.unknown) parts.push(`不明${pc.unknown}`);
      h += `<div>P${i + 1}（${pc.size}名）: ${parts.join(' / ')}</div>`;
    });
    h += `</div></details>`;
    return h;
  }

  // 各セルの評価値変化 before→after を小さく添える。
  const ev = (k) => `<span style="font-size:10px;color:#6b7280">評価 ${rep.before[k].toFixed(1)}→${rep.after[k].toFixed(1)}</span>`;
  const ordTxt = (rep.before.order != null)
    ? ` ／ 元順位ズレ罰則 ${rep.before.order.toFixed(1)}→${rep.after.order.toFixed(1)}` : '';
  let html = '';
  if (interInfo) {
    html += `<div style="font-size:11px;color:#b45309;font-weight:600">⏳ 中間レポート（ラウンド ${interInfo.round}/${interInfo.restarts} 終了時点のベスト解。完了まで自動更新）</div>`;
  }
  html += `<div style="font-weight:600;color:#111827">改善: 罰則合計 ${rep.before.total.toFixed(2)} → ${rep.after.total.toFixed(2)}（<span style="color:#16a34a">${imp}% 改善</span>）<span style="font-size:10px;color:#9ca3af">${ordTxt}</span></div>`;
  // 各ラウンドのステップ数% (= 実行ステップ / 上限。early stop で収束したラウンドは低くなる)
  if (SEEDOPT_ROUND_STATS.length) {
    const parts = SEEDOPT_ROUND_STATS.map(s =>
      `<span title="${s.iters.toLocaleString()} / ${s.maxIters.toLocaleString()} ステップ">R${s.round} ${s.maxIters > 0 ? (s.iters / s.maxIters * 100).toFixed(0) : 0}%</span>`);
    html += `<div style="margin-top:2px;font-size:10px;color:#6b7280">📈 各ラウンドのステップ数: ${parts.join(' / ')} <span style="color:#9ca3af">（上限比。100%未満は収束による早期終了）</span></div>`;
  }

  // ── レポート本体（デフォルト折りたたみ） ──
  html += `<details style="margin-top:6px"><summary style="cursor:pointer;font-weight:600;color:#374151">📋 レポート（プール間/内の被り）</summary>`;
  // ⑤ 予選抜け後セル (再対戦 = ②④ と同じタップ展開付き)。
  function postRecentCell(pRec) {
    let h = `<div style="font-size:11px;color:#374151">予選抜け後の再対戦想定: <strong>${pRec.pairs}</strong> 組${pRec.top.length ? '（早い回戦順）' : ''}</div>`;
    if (!pRec.top.length) return h;
    h += `<div style="margin:3px 0 0;padding-left:6px;font-size:11px;color:#374151">`;
    h += pRec.top.map(c => {
      const t = c.lastTournament ? ` ${escHtml(c.lastTournament)}${c.lastNent != null ? `〈${c.lastNent}人〉` : ''}` : '';
      const line = `${dn(c.a)} × ${dn(c.b)}（seed${c.seedA}×${c.seedB} / ${c.round}回戦${c.count != null ? ' / ' + c.count + '回' : ''}, 最終${c.lastDate || '?'}${t}）`;
      const ms = Array.isArray(c.matches) ? c.matches : [];
      if (!ms.length) return `<div style="padding:1px 0 1px 12px">${line}</div>`;
      const hist = ms.map(m =>
        `<div>${escHtml(m.date || '?')} ${m.tournament ? escHtml(m.tournament) : '（大会名不明）'}${m.nent != null ? `〈${m.nent}人〉` : ''}</div>`
      ).join('');
      return `<details style="padding:1px 0"><summary style="cursor:pointer">${line}</summary>` +
        `<div style="margin:2px 0 4px 18px;color:#6b7280">${hist}</div></details>`;
    }).join('');
    h += `</div>`;
    if (pRec.pairs > pRec.top.length) h += `<div style="font-size:11px;color:#9ca3af">…ほか ${pRec.pairs - pRec.top.length} 組</div>`;
    return h;
  }
  function postRegionCell(pReg) {
    const exR = pReg.excludedRegion ? `（最多地域 ${escHtml(pReg.excludedRegion)} は除外）` : '';
    let h = `<div style="margin-top:5px;font-size:11px;color:#374151">予選抜け後の同一地域の当たり想定: <strong>${pReg.pairs}</strong> 組${exR}</div>`;
    if (pReg.top.length) {
      h += ul(pReg.top.map(x =>
        `<strong>${escHtml(x.region)}</strong>: ${dn(x.a)} × ${dn(x.b)}（seed${x.seedA}×${x.seedB} / ${x.round}回戦）`));
      if (pReg.pairs > pReg.top.length) h += `<div style="font-size:11px;color:#9ca3af">…ほか ${pReg.pairs - pReg.top.length} 組</div>`;
    }
    return h;
  }

  // ① プール間 × 同一地域 ＝ 各プールの地域バランス
  html += sectionHead(`① プール間 × 同一地域（各プールの地域バランス） ${ev('interRegion')}`) + `<div style="font-size:10px;color:#9ca3af">各地域がプール間で均等に散っているか（同一地域＝都道府県/南関東等）</div>`;
  html += beforeAfter('1', rcB && regionBalanceCell(rcB.inter.region), regionBalanceCell(rc.inter.region));
  // ② プール間 × 直近対戦
  html += sectionHead(`② プール間 × 直近対戦 ${ev('interRecent')}`) + `<div style="font-size:10px;color:#9ca3af">最近(1年内)対戦した相手が同じプールにいないか</div>`;
  html += beforeAfter('2', rcB && recentCell(rcB.inter.recent, false), recentCell(rc.inter.recent, false));

  if (rc.intra) {
    const er = rc.intra.earlyRound;
    // intra 最適化をオフにした場合もレポートは出す（既定ブラケット順の当たり）が、
    // 評価値は目的関数に含まれない(常に0)ので添えない。
    const ranIntra = result.ranAfter && result.ranAfter.runIntra;
    const evIntra = (k) => ranIntra ? ev(k) : '<span style="font-size:10px;color:#9ca3af">（プール内変動オフ＝既定ブラケット順の当たり）</span>';
    // ③ プール内 × 同一地域 ＝ 同一地域が当たる最早回戦の分布
    html += sectionHead(`③ プール内 × 同一地域（ブラケット内の当たり回戦バランス） ${evIntra('intraRegion')}`) + `<div style="font-size:10px;color:#9ca3af">同プールの同一地域同士がなるべく遅い回戦で当たるか</div>`;
    html += beforeAfter('3', rcB && rcB.intra && intraRegionCell(rcB.intra.region, er), intraRegionCell(rc.intra.region, er));
    // ④ プール内 × 直近対戦
    html += sectionHead(`④ プール内 × 直近対戦（${er}回戦以内） ${evIntra('intraRecent')}`) + `<div style="font-size:10px;color:#9ca3af">同プール内でも直近対戦相手と早期回戦で当たらないか</div>`;
    html += beforeAfter('4', rcB && rcB.intra && recentCell(rcB.intra.recent, true), recentCell(rc.intra.recent, true));
  }
  // ⑤ 予選抜け後 (本戦想定): 全体を1つの勝者側ブラケットとみなし、シード通り
  // 勝ち進んだ場合に閾値より後の回戦で当たる 直近対戦/同一地域 ペア。
  if (rc.postPool) {
    const th = rc.postPool.threshold;
    html += sectionHead(`⑤ 予選抜け後 × 直近対戦 / 同一地域（本戦想定・${th}回戦超）`) +
      `<div style="font-size:10px;color:#9ca3af">全員をシード順の1つの勝者側ブラケットとみなし、シード通り勝ち進んだ場合に${th}回戦より後で当たるペア（プール構造とは独立の見積もり）</div>`;
    const postHtml = (pc) => postRecentCell(pc.recent) + postRegionCell(pc.region);
    html += beforeAfter('5', rcB && rcB.postPool && postHtml(rcB.postPool), postHtml(rc.postPool));
  }
  html += `</details>`;

  // ── 最適化前後の順位比較（デフォルト折りたたみ） ──
  if (ranking && ranking.length) {
    const P = result.pools.length;
    // P 列の表記: ウェーブ設定時は A3 形式 (ウェーブ文字+ウェーブ内プール番号)、無ければ数字。
    const wmapCmp = currentWaveMap(P);
    const poolTag = (pool1) => wmapCmp.some(w => w > 0)
      ? escHtml(poolLabel(pool1 - 1, wmapCmp)) : String(pool1);
    const origRank = {};
    ranking.forEach((u, i) => { origRank[u] = i + 1; });
    // DE 想定順位 (1,2,3,4,5,5,7,7,9,9,9,9,13,…): シード番号を1つの DE ブラケットと
    // 見なしたときの「シードどおりなら何位で終わるか」。シード番号の ± が実質的な
    // 順位変化を伴うかどうかがここで分かる (同じタイ帯内の移動なら想定順位は不変)。
    const dePlace = (s) => (window.SeedOptimizer ? SeedOptimizer.dePlaceOfSeed(s) : s);
    // プール内順位 = snake の行番号+1（プール p の r 行目 = そのプールの r 番手）。
    const poolRank = (s) => (window.SeedOptimizer ? SeedOptimizer.rowOfSeed(s - 1, P) : 0) + 1;
    const rows = result.seedOrder.map((u, i) => {
      const seed = i + 1, orig = origRank[u] || null;
      const delta = orig != null ? (seed - orig) : null;   // +は元より下のシードへ
      const pool = (window.SeedOptimizer ? SeedOptimizer.poolOfSeed(i, P) : 0) + 1;
      const origDe = orig != null ? dePlace(orig) : null;
      const newDe = dePlace(seed);
      const origPool = orig != null ? (window.SeedOptimizer ? SeedOptimizer.poolOfSeed(orig - 1, P) : 0) + 1 : null;
      const origPr = orig != null ? poolRank(orig) : null;
      const newPr = poolRank(seed);
      return { u, seed, orig, delta, pool, origDe, newDe, origPool, origPr, newPr };
    });
    const moved = rows.filter(r => r.delta != null && r.delta !== 0).length;
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.delta || 0)), 0);
    const deMoved = rows.filter(r => r.origDe != null && r.origDe !== r.newDe).length;
    const prMoved = rows.filter(r => r.origPr != null && r.origPr !== r.newPr).length;
    let t = `<details style="margin-top:6px"><summary style="cursor:pointer;font-weight:600;color:#374151">🔄 最適化前後の順位比較</summary>`;
    t += `<div style="font-size:10px;color:#9ca3af">元ランキング順位 → 最適化後のシード順位（${moved}名が移動・最大±${maxAbs}、うち DE 想定順位が変わるのは ${deMoved}名・プール内順位が変わるのは ${prMoved}名）</div>`;
    t += `<table style="margin-top:4px;border-collapse:collapse;font-size:11px;width:100%"><thead><tr style="color:#6b7280;text-align:left">`;
    t += `<th style="padding:2px 6px">シード</th><th style="padding:2px 6px">P</th><th style="padding:2px 6px">プレイヤー</th><th style="padding:2px 6px">元順位</th><th style="padding:2px 6px">差分</th><th style="padding:2px 6px" title="シード番号を1つのダブルイリミネーションブラケットとして見たときの想定順位 (1,2,3,4,5,5,7,7,9,…)。同じタイ帯内の移動なら実質的な順位は変わらない">DE想定順位</th><th style="padding:2px 6px" title="プール内の何番手かが変わった人だけ矢印で表示（プール自体の移動は P 列と差分で分かる）">プール内順位</th></tr></thead><tbody>`;
    for (const r of rows) {
      const dcol = r.delta > 0 ? '#b91c1c' : (r.delta < 0 ? '#2563eb' : '#9ca3af');
      const dtxt = r.delta == null ? '—' : (r.delta > 0 ? '↓+' + r.delta : (r.delta < 0 ? '↑' + r.delta : '0'));
      // 表記は数値のみ（「位」「番手」は書かない）。不変はグレー数値、変動は色付き矢印。
      let deTxt;
      if (r.origDe == null || r.origDe === r.newDe) {
        deTxt = `<span style="color:#9ca3af">${r.newDe}</span>`;
      } else {
        const deCol = r.newDe > r.origDe ? '#b91c1c' : '#2563eb';
        deTxt = `<span style="color:${deCol};font-weight:600">${r.origDe} → ${r.newDe}</span>`;
      }
      let prTxt;
      if (r.origPr == null || r.origPr === r.newPr) {
        prTxt = `<span style="color:#9ca3af">${r.newPr}</span>`;
      } else {
        const prCol = r.newPr > r.origPr ? '#b91c1c' : '#2563eb';
        prTxt = `<span style="color:${prCol};font-weight:600">${r.origPr} → ${r.newPr}</span>`;
      }
      t += `<tr><td style="padding:2px 6px">${r.seed}</td><td style="padding:2px 6px;color:#9ca3af">${poolTag(r.pool)}</td><td style="padding:2px 6px">${escHtml((displayOf[r.u] || r.u))}</td><td style="padding:2px 6px">${r.orig == null ? '—' : r.orig}</td><td style="padding:2px 6px;color:${dcol}">${dtxt}</td><td style="padding:2px 6px">${deTxt}</td><td style="padding:2px 6px">${prTxt}</td></tr>`;
    }
    t += `</tbody></table></details>`;
    html += t;
  }
  // 中間レポートの再描画で開いていた <details> が閉じないよう、開閉状態を
  // キー (data-k、無ければ summary テキスト) で保存して復元する。
  const reportEl2 = document.getElementById('so-report');
  const detailKey = (d) => {
    if (d.dataset && d.dataset.k) return d.dataset.k;
    const s = d.querySelector('summary');
    return s ? s.textContent : '';
  };
  const openKeys = new Set();
  reportEl2.querySelectorAll('details[open]').forEach(d => openKeys.add(detailKey(d)));
  reportEl2.innerHTML = html;
  if (openKeys.size) {
    reportEl2.querySelectorAll('details').forEach(d => {
      if (openKeys.has(detailKey(d))) d.open = true;
    });
  }
  if (!interInfo) {
    // 完了したら自動で反映する。「最適化したのにプレビューや CSV が元のまま」を
    // 起こさないため (2026-08-14)。戻したいときは「最適化を取り消す」。
    applySeedOptimize();
  }
}

/**
 * 最適化の結果を反映する。**完了時に自動で呼ばれる** (= 実行したら反映される)。
 * 戻したいときは「最適化を取り消す」(cancelSeedOptimize)。
 */
function applySeedOptimize() {
  if (!SEEDOPT_RESULT || !SEEDOPT_RESULT.seedOrder) return;
  // 取り消し用に、反映する直前の並びと手動調整の状態を控えておく。
  if (!PRE_OPT) {
    PRE_OPT = {
      order: DATA.map((r) => r.user_id),
      manual: MANUAL ? JSON.parse(JSON.stringify(MANUAL)) : null,
    };
  }
  APPLIED_ORDER = SEEDOPT_RESULT.seedOrder.slice();
  // 被り回避を反映したら手動編集は閉じる (表は最適化後の順序になるので、
  // 編集バーだけ出したままだと状態が食い違う)。編集の再開で反映が解除される。
  if (MANUAL && MANUAL.editing) { MANUAL.editing = false; MANUAL.committed = true; MANUAL.sel = null; }
  // 表示順も最適化後に合わせる。
  const pos = new Map(APPLIED_ORDER.map((u, i) => [u, i]));
  DATA.sort((a, b) =>
    (pos.has(a.user_id) ? pos.get(a.user_id) : 1e9) - (pos.has(b.user_id) ? pos.get(b.user_id) : 1e9));
  render();
  const reportEl = document.getElementById('so-report');
  if (!reportEl.querySelector('.seedopt-applied-banner')) {
    const div = document.createElement('div');
    div.className = 'seedopt-applied-banner';
    div.style.cssText = 'margin-top:10px;padding:6px 10px;background:#dcfce7;border:1px solid #16a34a;border-radius:6px;color:#166534;font-size:12px;font-weight:600';
    div.textContent = '✅ 被り回避を反映しました。トーナメントプレビュー / CSV ダウンロード / start.gg 適用は、この最適化後の順序になります。';
    reportEl.appendChild(div);
  }
  showOptCancelBtn(true);
  renderManualUI();   // 手動調整リスト表示中なら通常表 (最適化後順序) に切り替える
}

/**
 * 最適化を無かったことにする。実行する直前の並び・手動調整の状態に戻し、
 * レポートも実行前 (= 何も出ていない状態) に戻す。
 * トーナメントプレビューや CSV も、以後は元の順序で出る。
 */
function cancelSeedOptimize() {
  const had = !!APPLIED_ORDER || !!SEEDOPT_RESULT;
  APPLIED_ORDER = null;
  if (PRE_OPT) {
    const pos = new Map(PRE_OPT.order.map((u, i) => [u, i]));
    DATA.sort((a, b) =>
      (pos.has(a.user_id) ? pos.get(a.user_id) : 1e9) - (pos.has(b.user_id) ? pos.get(b.user_id) : 1e9));
    MANUAL = PRE_OPT.manual ? JSON.parse(JSON.stringify(PRE_OPT.manual)) : null;
    PRE_OPT = null;
    saveManual();
  }
  showOptCancelBtn(false);
  resetSeedOptResultPanel(had ? '最適化を取り消しました（実行前の並びに戻しました）。' : '');
  render();
  renderManualUI();
}

// ── csv モード: 基準順位ソース (CSV / Google Sheets) ─────────────────────────
// 読み込んだ行を参加者 (DATA) と照合し、その順序を手動調整の base として取り込む。
// 以降は spsp モードと完全に同じ (手動調整で微修正 → 被り回避 → CSV / start.gg 適用)。
let CSV_SOURCE = null;   // { rows: object[], label: string }

function _csvPick(row, names) {
  for (const k of Object.keys(row)) {
    if (names.includes(String(k).trim().toLowerCase())) {
      const v = row[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}
function _csvNormName(s) {
  const t = String(s).trim().toLowerCase();
  const i = t.lastIndexOf('|');           // チームタグ (zeta | あcola) は最後の | 以降を本体とみなす
  return i >= 0 ? t.slice(i + 1).trim() : t;
}
// seed/順位系の列があれば昇順、無ければ行順に並べた行リスト。
function _csvSortedRows(rows) {
  const numOf = (row) => {
    const v = _csvPick(row, CSV_SEAT_COLS);
    const n = v != null ? parseFloat(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const withNum = rows.map((row, i) => ({ row, i, n: numOf(row) }));
  if (withNum.every(x => x.n != null)) withNum.sort((a, b) => a.n - b.n || a.i - b.i);
  return withNum.map(x => x.row);
}

// CSV 列名 (小文字比較)。csv モードの基準 CSV と 📌シード指定 CSV で共通。
const CSV_NAME_COLS = ['player', 'name', 'display', 'tag', 'プレイヤー', '名前'];
const CSV_SEAT_COLS = ['seednum', 'seed_num', 'seed', 'phaseseed', 'phase_seed', '順位', 'シード'];
const CSV_DISC_COLS = ['discriminator', 'disc'];
// テンプレートの記入例 (実在しない disc = 先頭7桁が 0)。読み込み時は無視し警告を出す。
// 出力は ASCII 名にする: Shift_JIS 前提で CSV を開くアプリ (Excel for Mac 等) でも
// 化けないため。判定側は旧テンプレの日本語名も引き続き例として扱う。
const CSV_TPL_OUT_NAMES = ['Taro Yamada', 'Hanako Suzuki'];
const CSV_TPL_NAMES = CSV_TPL_OUT_NAMES.concat(['山田太郎', '鈴木花子']);
function isCsvTemplateSample(row) {
  const nm = _csvPick(row, CSV_NAME_COLS);
  if (nm != null && CSV_TPL_NAMES.indexOf(String(nm).trim()) >= 0) return true;
  const d = _csvPick(row, CSV_DISC_COLS);
  return d != null && /^0{7}[0-9a-f]$/i.test(_csvNormDisc(d));
}
// CSV テンプレートをダウンロードする (BOM 付き UTF-8 = Excel で文字化けしない)。
function downloadCsvTemplate(lines, filename) {
  const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'],
    { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// DATA から CSV 照合用の索引を作る (uid / seedId / 正規化名)。uid null 行は uid 照合不可。
// 正規化名 (タグ省略) が複数参加者に重なる名前は dupNames に載せ、名前照合ではエラー扱いにする
// (黙って先勝ちの1人に照合すると別人にシードを付けかねないため)。
function _csvRecLookups() {
  const byUid = new Map(DATA.filter(r => r.user_id != null).map(r => [r.user_id, r]));
  const bySeedId = new Map(DATA.filter(r => r.seedId != null).map(r => [String(r.seedId), r]));
  const byName = new Map();
  const dupNames = new Set();
  for (const r of DATA) {
    const n = _csvNormName(r.display || '');
    if (!n) continue;
    if (byName.has(n)) dupNames.add(n);
    else byName.set(n, r);
  }
  // discriminator → rec (disc は一意)。第一ソースは参加者データそのもの
  // (start.gg user.discriminator = rec.discriminator。DB 未登録の参加者も照合できる)。
  // rec に disc が無いとき (CSV 単独リスト構築など) は discriminators.json で補完。
  // どちらのソースも無いときだけ null (= disc 列があれば discUnavailable エラー)。
  let hasOwnDisc = false;
  const byDisc = new Map();
  for (const r of DATA) {
    if (r.user_id == null) continue;
    let d = r.discriminator || null;
    if (d) hasOwnDisc = true;
    else if (DISCRIMINATORS) d = DISCRIMINATORS[String(r.user_id)] || null;
    if (d) byDisc.set(String(d).toLowerCase(), r);
  }
  return { byUid, bySeedId, byName, dupNames,
           byDisc: (hasOwnDisc || DISCRIMINATORS) ? byDisc : null };
}
// CSV 1 行 → {rec, ambiguousName, discUnavailable}。
// 優先: uid 列 → discriminator 列 → seedId 列 → 名前列 (タグ省略照合)。
//   rec = 照合できた参加者 (不可なら null)。
//   ambiguousName = 名前照合で同名の参加者が複数いた場合にその名前 (呼び出し側でエラーにする)。
//   discUnavailable = discriminator 列があるのに discriminators.json が無くて照合不能
//                     (呼び出し側でエラーにする。黙って名前照合等に劣化させない)。
function _csvMatchRow(row, lk) {
  const uid = _csvPick(row, ['uid', 'user_id', 'userid']);
  if (uid != null) {
    const rec = lk.byUid.get(canonicalUserId(Number(uid))) || lk.byUid.get(Number(uid)) || null;
    if (rec) return { rec, ambiguousName: null };
  }
  const dv = _csvPick(row, CSV_DISC_COLS);
  if (dv != null) {
    if (!lk.byDisc) return { rec: null, ambiguousName: null, discUnavailable: true };
    const rec = lk.byDisc.get(_csvNormDisc(dv)) || null;
    if (rec) return { rec, ambiguousName: null };
  }
  const sid = _csvPick(row, ['seedid', 'seed_id', 'sid']);
  if (sid != null) {
    const rec = lk.bySeedId.get(String(parseInt(sid, 10))) || lk.bySeedId.get(sid) || null;
    if (rec) return { rec, ambiguousName: null };
  }
  const nm = _csvPick(row, CSV_NAME_COLS);
  if (nm != null) {
    const n = _csvNormName(nm);
    if (lk.dupNames.has(n)) return { rec: null, ambiguousName: nm };
    return { rec: lk.byName.get(n) || null, ambiguousName: null };
  }
  return { rec: null, ambiguousName: null };
}
function _csvRowLabel(row) {
  return _csvPick(row, CSV_NAME_COLS.concat(['uid', 'user_id', 'seedid'])) || '(不明行)';
}

// CSV 行列 → 参加者 uid 順序。優先: uid 列 → seedId 列 → 名前列 (タグ省略照合)。
function csvRowsToOrder(rows) {
  const lk = _csvRecLookups();
  const order = [];
  const used = new Set();
  const unmatched = [];
  const ambiguous = [];   // 名前照合で複数参加者に該当した名前 (エラー扱い、適用しない)
  let discUnavailable = false;   // disc 列があるのに discriminators.json 無し (エラー扱い)
  let sampleRows = 0;            // テンプレートの記入例が残っていた行 (無視 + 警告)
  for (const row of _csvSortedRows(rows)) {
    if (isCsvTemplateSample(row)) { sampleRows++; continue; }
    const m = _csvMatchRow(row, lk);
    if (m.discUnavailable) { discUnavailable = true; continue; }
    if (m.ambiguousName != null) { ambiguous.push(m.ambiguousName); continue; }
    const rec = m.rec;
    if (rec && !used.has(rec.user_id)) { order.push(rec.user_id); used.add(rec.user_id); }
    else if (!rec) unmatched.push(_csvRowLabel(row));
  }
  // CSV に無い参加者は現在の SPSP 順位順で末尾に。
  const rest = DATA.slice()
    .sort((a, b) => (a.ranks[currentMethod] || 1e9) - (b.ranks[currentMethod] || 1e9))
    .map(r => r.user_id).filter(u => !used.has(u));
  return { order: order.concat(rest), matched: order.length, unmatched, ambiguous, discUnavailable,
           sampleRows, restCount: rest.length };
}
function _csvStatus(msg, isErr) {
  const el = document.getElementById('csv-src-status');
  if (el) { el.textContent = msg; el.style.color = isErr ? '#dc2626' : '#374151'; }
}
// 参加者取得済みなら CSV 順を基準 (手動調整の base) に反映する。
// fromFetch=true (取得直後の自動適用) では復元済みの手動調整を上書きしない。
function applyCsvOrderIfReady(fromFetch) {
  if (SEED_APP_CONFIG.mode !== 'csv' || !CSV_SOURCE || !DATA.length) return;
  if (fromFetch && MANUAL) {
    _csvStatus('保存済みの手動調整を復元したため CSV は未適用です。CSV 順を基準にし直すには「読み込み」を押してください。');
    return;
  }
  if (!fromFetch && MANUAL && manualMovedSet().size > 0 &&
      !confirm('CSV 順を基準に再適用すると、現在の手動調整 (履歴含む) は破棄されます。よろしいですか？')) return;
  const { order, matched, unmatched, ambiguous, discUnavailable, sampleRows, restCount } = csvRowsToOrder(CSV_SOURCE.rows);
  if (discUnavailable) {
    _csvStatus(`discriminator 列がありますが照合データ (discriminators.json) を取得できていないため適用しません` +
      `${DISC_LOAD_ERROR ? ` (${DISC_LOAD_ERROR})` : ''}。再読み込みするか uid / 名前列で指定してください。`, true);
    return;
  }
  if (ambiguous.length) {
    _csvStatus(`名前が複数の参加者に該当するため適用しません: ${[...new Set(ambiguous)].slice(0, 5).join(', ')}${ambiguous.length > 5 ? ' …' : ''}` +
      ' — 該当行に uid / discriminator / seedId 列を付けて区別してください。', true);
    return;
  }
  if (!matched) { _csvStatus('CSV の行を参加者と1件も照合できませんでした (uid / seedId / 名前列を確認してください)。', true); return; }
  MANUAL = { base: order, ops: [], hpos: 0, committed: true, editing: false, sel: null, src: 'csv' };
  // 後から読み込んだ CSV が最新の作業なので、適用済みの被り回避結果は解除する
  // (これをしないと CSV 順が出力に反映されない)。
  dropAppliedOrder();
  if (SEEDOPT_RESULT) resetSeedOptResultPanel('CSV を読み込んだため被り回避の結果をクリアしました。再実行してください。');
  saveManual(); renderManualUI();
  let msg = `✅ ${CSV_SOURCE.label}: ${matched}人を照合し基準順位に反映しました。`;
  if (restCount) msg += ` CSV に無い参加者 ${restCount}人は SPSP 順で末尾。`;
  if (settingNotes.length) msg += ` (CSV の設定で${settingNotes.join('・')})`;
  if (sampleRows) msg += ` ⚠ テンプレートの記入例 ${sampleRows}行は無視しました。`;
  if (unmatched.length) msg += ` 未照合 ${unmatched.length}行: ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? ' …' : ''}`;
  _csvStatus(msg, false);
  const st = document.getElementById('status');
  if (st) st.textContent = 'CSV 順を基準順位に反映しました。手動調整で微修正 → 被り回避最適化 → 適用ができます。';
}
// csv モード: start.gg 未取得でも CSV の行だけで参加者リストを構築して表示する。
// uid 列 → SPSP マスター直引き、名前列 → マスター全体との正規化名照合 (曖昧名 =
// 複数 uid に当たる名前は使わない)。どちらも照合できない行は DB 不在扱いで末尾。
// start.gg への適用は後からイベントを取得すれば可能 (CSV は自動で再適用される)。
let _MASTER_NAME_IDX = null;   // normName → uid (曖昧名は null)
function _masterNameIdx() {
  if (_MASTER_NAME_IDX) return _MASTER_NAME_IDX;
  const idx = new Map();
  for (const [uid, rec] of MASTER_MAP.entries()) {
    const n = _csvNormName(rec.display || '');
    if (!n) continue;
    idx.set(n, idx.has(n) ? null : uid);   // 2回目以降 = 曖昧 → null
  }
  _MASTER_NAME_IDX = idx;
  return idx;
}
async function buildParticipantsFromCsv() {
  const status = document.getElementById('status');
  await loadMasterData();
  // discriminator 列があるのに照合データが無い場合は fail-loud (黙って名前照合に劣化させない)。
  if (!DISCRIMINATORS && CSV_SOURCE.rows.some(row => _csvPick(row, CSV_DISC_COLS) != null)) {
    if (status) status.textContent = '❌ discriminator 列がありますが照合データ (discriminators.json) を' +
      `取得できていないため読み込めません${DISC_LOAD_ERROR ? ` (${DISC_LOAD_ERROR})` : ''}。`;
    return;
  }
  const nameIdx = _masterNameIdx();
  const seedInfos = [];
  const seen = new Set();
  let sampleRows = 0;   // テンプレートの記入例が残っていた行 (無視 + 警告)
  let synth = 0;   // uid 不明行用の合成 id (負数・重複防止)
  _csvSortedRows(CSV_SOURCE.rows).forEach((row, i) => {
    if (isCsvTemplateSample(row)) { sampleRows++; return; }
    let userId = null;
    const uidV = _csvPick(row, ['uid', 'user_id', 'userid']);
    if (uidV != null) {
      const u = canonicalUserId(Number(uidV));
      if (MASTER_MAP.has(u)) userId = u;
    }
    if (userId == null) {
      const dV = _csvPick(row, CSV_DISC_COLS);
      if (dV != null && DISCRIMINATORS) {
        const u = _disc2uid().get(_csvNormDisc(dV));
        if (u != null && MASTER_MAP.has(canonicalUserId(u))) userId = canonicalUserId(u);
      }
    }
    const nameV = _csvPick(row, ['player', 'name', 'display', 'tag', 'プレイヤー', '名前']);
    if (userId == null && nameV != null) {
      const u = nameIdx.get(_csvNormName(nameV));
      if (u != null) userId = u;
    }
    if (userId != null && seen.has(userId)) return;   // 重複行はスキップ
    if (userId != null) seen.add(userId);
    if (userId == null) { synth -= 1; userId = synth; }
    const sidV = _csvPick(row, ['seedid', 'seed_id', 'sid']);
    seedInfos.push({
      userId,
      display: nameV || (userId > 0 && MASTER_MAP.has(userId) ? MASTER_MAP.get(userId).display : `uid:${uidV || '?'}`),
      seedId: sidV != null ? sidV : null,
      originalSeed: i + 1,
      entrantId: null,
    });
  });
  const { records, rankedCount, missingCount } = filterAndRerank(seedInfos);
  // 表示名は CSV の名前を優先 (このツールの役割は「読み込んだものを出す」)。
  const csvNameByUid = new Map(seedInfos.filter(si => si.display != null).map(si => [si.userId, si.display]));
  for (const r of records) {
    const nm = csvNameByUid.get(r.user_id);
    if (nm) r.display = nm;
  }
  EVENT_CONTEXT = null;
  dropAppliedOrder({ render: false });
  MANUAL = null;
  SEED_SPEC = null;
  DATA.length = 0;
  for (const r of records) DATA.push(r);
  document.getElementById('meta-info').textContent = `${CSV_SOURCE.label} (start.gg 未接続)`;
  if (status) status.textContent =
    `CSV から ${records.length} 名を表示 (SPSP 照合 ${rankedCount} 名 + DB 不在 ${missingCount} 名)。` +
    (sampleRows ? ` ⚠ テンプレートの記入例 ${sampleRows}行は無視しました。` : '') +
    ` CSV ダウンロード・被り回避・手動調整が使えます。start.gg に適用するには大会 URL から参加者を取得してください。`;
  document.getElementById('csv-btn').disabled = false;
  // 適用は可能 (押した時に大会 URL から seedId を自動取得する)。
  document.getElementById('upload-btn').disabled = false;
  setParticipantsUiVisible(true);
  const tbl = ensureTable();
  tbl.setSort('rank', 'asc');
  render();
  applyCsvOrderIfReady(false);
}

async function loadCsvSource() {
  try {
    const fileEl = document.getElementById('csv-src-file');
    const url = (document.getElementById('csv-src-url').value || '').trim();
    let text, label;
    if (fileEl && fileEl.files && fileEl.files.length) {
      text = await SmashSeed.readCsvFile(fileEl.files[0]);
      label = fileEl.files[0].name;
    } else if (url) {
      const sheets = SmashSeed.getSheetsCsvUrl(url);
      if (sheets) {
        text = await SmashSeed.fetchSheetsCsv(url);
        label = 'Google Sheets';
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        text = await res.text();
        label = 'CSV URL';
      }
    } else {
      _csvStatus('URL を入力するかファイルを選択してください。', true);
      return;
    }
    const parsed = SmashSeed.parseCsv(text);   // {rows, headers}
    const rows = parsed.rows || [];
    if (!rows.length) throw new Error('CSV に行がありません');
    CSV_SOURCE = { rows, label };
    if (DATA.length) {
      applyCsvOrderIfReady(false);
    } else {
      // 参加者未取得でも CSV だけでリスト表示する (start.gg 適用は取得後)。
      _csvStatus(`📄 ${label}: ${rows.length}行を読み込みました。リストを構築中…`);
      await buildParticipantsFromCsv();
      _csvStatus(`✅ ${label}: ${rows.length}行から参加者リストを構築しました。大会 URL から参加者を取得すると start.gg 適用も可能になります (CSV 順は自動で再適用)。`);
    }
  } catch (e) {
    _csvStatus('読み込みエラー: ' + (e && e.message ? e.message : e), true);
  }
}
if (SEED_APP_CONFIG.mode === 'csv') {
  const btn = document.getElementById('csv-src-load');
  if (btn) btn.addEventListener('click', loadCsvSource);
  const tpl = document.getElementById('csv-tpl');
  // seed は任意 (省略時は行順。2 行目が空欄可の例)。
  if (tpl) tpl.addEventListener('click', () => downloadCsvTemplate([
    'name,discriminator,seed',
    `${CSV_TPL_OUT_NAMES[0]},="00000000",1`,
    `${CSV_TPL_OUT_NAMES[1]},="00000001",`,
  ], 'spsp_seed_template.csv'));
}

// ── ウェーブ (= 連続するプールの塊 A,B,C,…) ─────────────────────────
// start.gg の phaseGroups (プール) から displayIdentifier / wave.identifier を読み、
// プール順 (識別子の自然順 = serpentine のプール順) とウェーブ対応を自動取得する。
// 取得できない場合はパネルの「ウェーブ数」手動設定で連続チャンク割りにする。
const PHASE_GROUPS_QUERY = `
  query PhaseGroups($phaseId: ID!, $page: Int!, $perPage: Int!) {
    phase(id: $phaseId) {
      phaseGroups(query: { page: $page, perPage: $perPage }) {
        pageInfo { totalPages }
        nodes { id displayIdentifier wave { identifier } }
      }
    }
  }
`;

// phaseGroup ノード配列 → ウェーブ情報 (純関数)。
// 返り値: {poolCount, waveCount, poolToWave, letters, identifiers} または null (プールなし)。
// ウェーブ文字は wave.identifier 優先、無ければ displayIdentifier の先頭アルファベット。
// どのプールにも文字が無い (= "1","2",… のみ) ならウェーブ分けなし (waveCount=1)。
function wavesFromGroupNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const parsed = nodes.map((n) => {
    const disp = String((n && n.displayIdentifier) || '');
    const m = disp.match(/^([A-Za-z]+)?\s*0*(\d+)?/) || [];
    const letter = (n && n.wave && n.wave.identifier != null && String(n.wave.identifier).trim())
      ? String(n.wave.identifier).trim().toUpperCase()
      : (m[1] ? m[1].toUpperCase() : null);
    const num = m[2] != null ? parseInt(m[2], 10) : null;
    return { disp, letter, num };
  });
  // 識別子の自然順 (A1, A2, …, A10, B1, …)。文字なしは先頭に数値順で並ぶ。
  parsed.sort((a, b) => {
    const la = a.letter || '', lb = b.letter || '';
    if (la !== lb) return la < lb ? -1 : 1;
    return (a.num || 0) - (b.num || 0);
  });
  const letters = [];
  for (const p of parsed) {
    if (p.letter && !letters.includes(p.letter)) letters.push(p.letter);
  }
  if (!letters.length) {
    return { poolCount: parsed.length, waveCount: 1, poolToWave: parsed.map(() => 0),
             letters: [], identifiers: parsed.map(p => p.disp) };
  }
  const li = new Map(letters.map((l, i) => [l, i]));
  return {
    poolCount: parsed.length,
    waveCount: letters.length,
    poolToWave: parsed.map(p => (p.letter != null ? li.get(p.letter) : 0)),
    letters,
    identifiers: parsed.map(p => p.disp),
  };
}

async function fetchPhaseWaves(token, phaseId) {
  const nodes = [];
  let page = 1;
  while (true) {
    const data = await startggQuery(token, PHASE_GROUPS_QUERY,
      { phaseId: String(phaseId), page, perPage: 64 });
    const pg = data.phase && data.phase.phaseGroups;
    if (!pg) return null;
    nodes.push(...(pg.nodes || []));
    const tot = (pg.pageInfo && pg.pageInfo.totalPages) || 1;
    if (page >= tot || !(pg.nodes || []).length) break;
    page += 1;
    await new Promise(r => setTimeout(r, 300));
  }
  return wavesFromGroupNodes(nodes);
}

// 現在の設定でのプール index → ウェーブ index。自動取得のマップがプール数・ウェーブ数と
// 整合するならそれを使い、そうでなければ連続チャンク割り (先頭側のウェーブから
// floor(P/W)+1 or floor(P/W) プールずつ)。W<=1 なら全プール同一ウェーブ (= 制約なし)。
function currentWaveMap(P) {
  const W = Math.max(1, parseInt((document.getElementById('so-waves') || {}).value, 10) || 1);
  const wv = EVENT_CONTEXT && EVENT_CONTEXT.waves;
  if (wv && Array.isArray(wv.poolToWave) && wv.poolCount === P && wv.waveCount === W) {
    return wv.poolToWave.slice();
  }
  return chunkWaveMap(P, W);
}
// P プールを W 個の連続チャンクに分ける (純関数)。
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
// プール表示名: ウェーブありなら A3 (ウェーブ文字 + ウェーブ内プール番号)、なしなら P3。
function poolLabel(poolIdx, waveMap) {
  if (!waveMap || !waveMap.some(w => w > 0)) return 'P' + (poolIdx + 1);
  const w = waveMap[poolIdx];
  let k = 0;
  for (let p = 0; p < poolIdx; p++) if (waveMap[p] === w) k++;
  return waveLetter(w) + (k + 1);
}

// ── 📌 シード指定・固定 (spec-panel) ─────────────────────────
// CSV で一部プレイヤーの 順位 (シード番号) / ウェーブ を指定して並びを組み直し、
// 固定 (プール/ウェーブ) を被り回避最適化のハード制約として登録する。
const SPEC_WAVE_COLS = ['wave', 'ウェーブ', 'w'];
const SPEC_FIX_COLS = ['固定', 'fix', 'lock', 'pin'];

// ウェーブ指定値 → ウェーブ index (0始まり)。'A'〜'Z' または 1始まり数値。不正は null。
function parseWaveValue(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (/^[A-Z]$/.test(s)) return s.charCodeAt(0) - 65;
  const n = parseInt(s, 10);
  return (Number.isFinite(n) && String(n) === s && n >= 1) ? n - 1 : null;
}
// 固定指定値 → 'pool' | 'wave' | null。明示 (プール/ウェーブ) 優先、
// 汎用 truthy (1/○/true/固定 …) はウェーブ指定行ならウェーブ固定、それ以外はプール固定。
function parseFixValue(v, hasWave) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === '0' || s === 'no' || s === 'false' || s === 'none' || s === '-' || s === '×') return null;
  if (s === 'wave' || s === 'ウェーブ' || s === 'w') return 'wave';
  if (s === 'pool' || s === 'プール' || s === 'p') return 'pool';
  return hasWave ? 'wave' : 'pool';
}

// 指定 (順位ピン + ウェーブ割当) を現在の並びに適用した新しい並びを作る (純関数)。
//   curOrder: uid 配列 / pins: [uid, seat1][] / waveOf: [uid, waveIdx][] /
//   P: プール数 / waveMap: プール→ウェーブ / poolOf: (seedIdx0, P) => poolIdx。
// ピンはそのシード位置に固定配置し、残りは現在順のまま空き位置へ。ウェーブ指定者は
// そのウェーブのプールに落ちる最初の空き位置まで待つ (= 現在順位付近に収まる)。
// 満たせない指定は notes (人が読める説明) で返す (黙って握りつぶさない)。
function buildSpecOrder(curOrder, pins, waveOf, P, waveMap, poolOf) {
  const N = curOrder.length;
  const out = new Array(N).fill(null);
  const notes = [];
  const pinned = new Set();
  for (const [uid, seat] of pins) {
    const s = seat - 1;
    if (s < 0 || s >= N) { notes.push(`順位 #${seat} は範囲外のため無視`); continue; }
    if (out[s] != null) { notes.push(`順位 #${seat} が重複 (後の指定を無視)`); continue; }
    if (pinned.has(uid)) continue;
    out[s] = uid;
    pinned.add(uid);
  }
  const wanted = new Map(waveOf);
  const queue = curOrder.filter((u) => !pinned.has(u));
  let waveGaveUp = 0;   // ウェーブの枠が足りず指定を諦めた人数
  for (let s = 0; s < N; s++) {
    if (out[s] != null) continue;
    const wv = waveMap ? waveMap[poolOf(s, P)] : 0;
    let k = -1;
    for (let q = 0; q < queue.length; q++) {
      const want = wanted.get(queue[q]);
      if (want == null || want === wv) { k = q; break; }
    }
    // 置ける人が居ない (= そのウェーブの枠が足りない) ときは先頭の 1 人だけ諦める。
    if (k < 0) k = 0;
    const picked = queue.splice(k, 1)[0];
    if (wanted.has(picked) && wanted.get(picked) !== wv) { waveGaveUp++; wanted.delete(picked); }
    out[s] = picked;
  }
  if (waveGaveUp) notes.push(`ウェーブの枠が足りず ${waveGaveUp}人は指定どおりに置けませんでした`);
  return { order: out, notes };
}

// 固定 (対象付き) を満たすよう並びを組み直す (純関数・挿入ソート方式)。
//   order: uid 配列 / locks: {uid: {kind:'pool'|'wave', target} | 'pool'|'wave' (旧形式=移動なし)}
//   / P: プール数 / waveMap: プール→ウェーブ / poolOf: (seedIdx0, P) => poolIdx。
// 位置を前から埋め、固定者は対象プール/ウェーブのスロットが来るまで待つ (他は現在順のまま)。
// 入力が既に固定を満たしていれば恒等 (冪等)。枠が足りない対象は overflow で返す
// ({kind, target, cap, want})。入りきらない人は元の位置に残す。
function enforceSeedLocks(order, locks, P, waveMap, poolOf) {
  const N = order.length;
  const need = new Map();   // uid → {pool} | {wave}
  for (const u of order) {
    const l = locks[u];
    if (!l) continue;
    const kind = l.kind || l;
    const target = (l && l.target != null) ? l.target : null;
    if (target == null) continue;   // 旧形式/対象なし: 現位置のまま (移動しない)
    need.set(u, kind === 'pool' ? { pool: target } : { wave: target });
  }
  if (!need.size) return { order: order.slice(), overflow: [] };
  // 枠数 (= その対象に落ちるシード位置の数) と固定人数を数え、超過分を overflow で返す。
  const capOf = new Map();   // 'pool:3' → 枠数
  for (let s2 = 0; s2 < N; s2++) {
    const pool = poolOf(s2, P);
    const wave = waveMap ? waveMap[pool] : 0;
    capOf.set('pool:' + pool, (capOf.get('pool:' + pool) || 0) + 1);
    capOf.set('wave:' + wave, (capOf.get('wave:' + wave) || 0) + 1);
  }
  const wantOf = new Map();
  need.forEach((nd) => {
    const key = nd.pool != null ? 'pool:' + nd.pool : 'wave:' + nd.wave;
    wantOf.set(key, (wantOf.get(key) || 0) + 1);
  });
  const overflow = [];
  wantOf.forEach((want, key) => {
    const cap = capOf.get(key) || 0;
    if (want > cap) {
      const [kind, t] = key.split(':');
      // uids は「その対象に固定された全員」。実際に諦めた人は下の配置ループで dropped に入る。
      const uids = [];
      need.forEach((nd, u) => {
        if ((nd.pool != null ? 'pool:' + nd.pool : 'wave:' + nd.wave) === key) uids.push(u);
      });
      overflow.push({ kind, target: Number(t), cap, want, uids, dropped: [] });
    }
  });
  const overflowByKey = new Map(overflow.map((o) => [o.kind + ':' + o.target, o]));
  const out = new Array(N).fill(null);
  const queue = order.slice();
  let lockedLeft = need.size;
  for (let s = 0; s < N; s++) {
    if (!lockedLeft) { out[s] = queue.shift(); continue; }   // 残り固定なし: そのまま流す
    const pool = poolOf(s, P);
    const wave = waveMap ? waveMap[pool] : 0;
    let k = -1;
    for (let q = 0; q < queue.length; q++) {
      const nd = need.get(queue[q]);
      if (!nd || (nd.pool != null ? nd.pool === pool : nd.wave === wave)) { k = q; break; }
    }
    // 置ける人が居ない (= 枠不足) ときは先頭の 1 人だけ諦めてここに置く。
    // 他の固定は活かす (以前は全部諦めていた)。
    const gaveUp = k < 0;
    if (gaveUp) k = 0;
    const picked = queue.splice(k, 1)[0];
    if (need.has(picked)) {
      if (gaveUp) {   // 指定どおりに置けなかった人 (= 誰が影響を受けたか) を記録
        const nd = need.get(picked);
        const o = overflowByKey.get(nd.pool != null ? 'pool:' + nd.pool : 'wave:' + nd.wave);
        if (o) o.dropped.push(picked);
      }
      need.delete(picked); lockedLeft--;
    }
    out[s] = picked;
  }
  // 対象が存在しない (cap 0) 場合は全員が指定を反映できていない。
  for (const o of overflow) if (o.cap === 0) o.dropped = o.uids.slice();
  return { order: out, overflow };
}

function _specStatus(html, isErr) {
  const el = document.getElementById('spec-status');
  if (el) { el.innerHTML = html || ''; el.style.color = isErr ? '#dc2626' : '#374151'; }
}
// 現在の SEED_SPEC の要約を表示 (復元時・クリア時)。
function renderSpecStatus() {
  if (!SEED_SPEC) { _specStatus(''); return; }
  const n = (o) => Object.keys(o || {}).length;
  _specStatus(`📌 ${SEED_SPEC.label ? escHtml(SEED_SPEC.label) + ': ' : ''}` +
    `順位指定 ${n(SEED_SPEC.pins)} / ウェーブ指定 ${n(SEED_SPEC.waves)} / 固定 ${n(SEED_SPEC.locks)}名 を保持中。`);
}

// spec CSV の行を適用: 照合 → 順位/ウェーブ/固定を抽出 → 並び組み直し + SEED_SPEC 更新。
function applySpecRows(rows, label) {
  if (!DATA.length) { _specStatus('先に参加者を読み込んでください。', true); return; }
  // 作業状況 CSV (エクスポート) の pools / waves 列があれば設定に反映してから解釈する。
  // 共有された CSV を読むだけで同じプール構成になる。
  const settingNotes = [];
  for (const [col, id, label2] of [['pools', 'so-pools', 'プール数'], ['waves', 'so-waves', 'ウェーブ数']]) {
    const row = rows.find((r) => _csvPick(r, [col]) != null);
    const v = row ? parseInt(_csvPick(row, [col]), 10) : NaN;
    const el = document.getElementById(id);
    if (el && Number.isFinite(v) && v >= 1 && String(v) !== String(el.value)) {
      el.value = String(v);
      settingNotes.push(`${label2}を ${v} に変更`);
    }
  }
  if (settingNotes.length) updateIntraToggleState();
  const P = Math.max(1, parseInt((document.getElementById('so-pools') || {}).value, 10) || 1);
  const waveMap = currentWaveMap(P);
  const W = waveMap.reduce((mx, w) => Math.max(mx, w), 0) + 1;
  const lk = _csvRecLookups();
  const pins = new Map(), waveOf = new Map(), locks = {};
  const unmatched = [], problems = [], ambiguous = [];
  let discUnavailable = false;
  let sampleRows = 0;   // テンプレートの記入例が残っていた行 (無視 + 警告)
  let matchedRows = 0;
  for (const row of rows) {
    if (isCsvTemplateSample(row)) { sampleRows++; continue; }
    const m = _csvMatchRow(row, lk);
    if (m.discUnavailable) { discUnavailable = true; continue; }
    const rec = m.rec;
    if (m.ambiguousName != null) { ambiguous.push(m.ambiguousName); continue; }
    if (!rec) { unmatched.push(_csvRowLabel(row)); continue; }
    if (rec.user_id == null) { problems.push(`${rec.display}: uid 不明のため指定できません`); continue; }
    matchedRows++;
    const u = rec.user_id;
    let seat = null;
    const seatV = _csvPick(row, CSV_SEAT_COLS);
    if (seatV != null) {
      const nn = parseInt(seatV, 10);
      if (Number.isFinite(nn) && nn >= 1 && nn <= DATA.length) seat = nn;
      else problems.push(`${rec.display}: 順位が不正 (${seatV})`);
    }
    let wIdx = null;
    const waveV = _csvPick(row, SPEC_WAVE_COLS);
    if (waveV != null) {
      wIdx = parseWaveValue(waveV);
      if (wIdx == null || wIdx >= W) { problems.push(`${rec.display}: ウェーブが不正 (${waveV})`); wIdx = null; }
    }
    if (seat != null) {
      pins.set(u, seat);
      if (wIdx != null && window.SeedOptimizer &&
          waveMap[SeedOptimizer.poolOfSeed(seat - 1, P)] !== wIdx) {
        problems.push(`${rec.display}: 順位 #${seat} はウェーブ ${waveLetter(wIdx)} 外 (順位を優先)`);
      }
    } else if (wIdx != null) {
      waveOf.set(u, wIdx);
    }
    const fx = parseFixValue(_csvPick(row, SPEC_FIX_COLS), wIdx != null);
    if (fx === 'wave' && W < 2) {
      problems.push(`${rec.display}: ウェーブ数が1のためウェーブ固定をプール固定に変更`);
      locks[u] = 'pool';
    } else if (fx) {
      locks[u] = fx;
    }
  }
  // discriminator 列があるのに照合データが無い = エラー (黙って名前照合等に劣化させない)。
  if (discUnavailable) {
    _specStatus(`discriminator 列がありますが照合データ (discriminators.json) を取得できていないため適用しません` +
      `${DISC_LOAD_ERROR ? ` (${escHtml(DISC_LOAD_ERROR)})` : ''}。再読み込みするか uid / 名前列で指定してください。`, true);
    return;
  }
  // 名前の被り = エラー (何も適用しない)。黙って別人に指定が付くのを防ぐ。
  if (ambiguous.length) {
    _specStatus(`名前が複数の参加者に該当するため適用しません: ` +
      `${[...new Set(ambiguous)].slice(0, 5).map(escHtml).join(', ')}${ambiguous.length > 5 ? ' …' : ''}` +
      ' — 該当行に uid / discriminator / seedId 列を付けて区別してください。', true);
    return;
  }
  if (!matchedRows) {
    _specStatus('CSV の行を参加者と1件も照合できませんでした (uid / seedId / 名前列を確認してください)。', true);
    return;
  }
  // 順位/ウェーブ指定があれば現在の出力順を組み直して手動調整 base に取り込む。
  if (pins.size || waveOf.size) {
    if (MANUAL && manualMovedSet().size > 0 &&
        !confirm('シード指定を適用すると現在の手動調整 (履歴含む) を組み直します。よろしいですか？')) return;
    const curOrder = orderedRecs().map(r => r.user_id);
    const { order, notes } = buildSpecOrder(curOrder, [...pins], [...waveOf], P, waveMap,
      (s, PP) => (window.SeedOptimizer ? SeedOptimizer.poolOfSeed(s, PP) : 0));
    problems.push(...notes);
    MANUAL = { base: order, ops: [], hpos: 0, committed: true, editing: false, sel: null, src: 'spec' };
    dropAppliedOrder();
    if (SEEDOPT_RESULT) resetSeedOptResultPanel('シード指定を適用したため被り回避の結果をクリアしました。再実行してください。');
  } else if (Object.keys(locks).length && !MANUAL) {
    // 固定のみの CSV: 現在の並びを手動調整として取り込む (手動列に射影後の位置と
    // 📌バッジが出て、固定の効果が見えるようにする)。
    MANUAL = { base: orderedRecs().map(r => r.user_id), ops: [], hpos: 0, committed: true, editing: false, sel: null, src: 'spec' };
    dropAppliedOrder();
  }
  // 固定を {kind, target} 形式で確定する。対象 = ウェーブ列があればその値、無ければ
  // 配置後の位置のプール/ウェーブ。以後は読み取り時射影が並びを常にこの対象へ寄せる。
  const lockObjs = {};
  if (Object.keys(locks).length) {
    const placedOrder = (pins.size || waveOf.size)
      ? MANUAL.base
      : orderedRecs().map(r => r.user_id);
    const poolOfS = (s) => (window.SeedOptimizer ? SeedOptimizer.poolOfSeed(s, P) : 0);
    for (const k in locks) {
      const u = manualParseUid(k);
      const kind = locks[k];
      let target;
      if (kind === 'wave' && waveOf.has(u)) {
        target = waveOf.get(u);
      } else {
        const pos = placedOrder.indexOf(u);
        const pool = pos >= 0 ? poolOfS(pos) : 0;
        target = kind === 'pool' ? pool : waveMap[pool];
      }
      lockObjs[u] = { kind, target };
    }
  }
  SEED_SPEC = {
    label,
    pins: Object.fromEntries(pins),
    waves: Object.fromEntries(waveOf),
    locks: lockObjs,
  };
  saveManual();
  render();
  let msg = `✅ ${escHtml(label)}: ${matchedRows}行を照合 — ` +
    `順位指定 ${pins.size} / ウェーブ指定 ${waveOf.size} / 固定 ${Object.keys(locks).length}名。`;
  if (settingNotes.length) msg += ` (CSV の設定で${settingNotes.join('・')})`;
  if (sampleRows) msg += ` ⚠ テンプレートの記入例 ${sampleRows}行は無視しました。`;
  if (unmatched.length) {
    msg += ` 未照合 ${unmatched.length}行: ${unmatched.slice(0, 5).map(escHtml).join(', ')}${unmatched.length > 5 ? ' …' : ''}`;
  }
  if (problems.length) {
    msg += `<br>⚠ ${problems.slice(0, 8).map(escHtml).join(' ／ ')}${problems.length > 8 ? ' …' : ''}`;
  }
  _specStatus(msg, false);
  const st = document.getElementById('status');
  if (st) st.textContent = '📌 シード指定を反映しました。手動調整で微修正 → 被り回避最適化 (固定は動かしません) → 適用ができます。';
}

async function loadSpecSource() {
  try {
    const fileEl = document.getElementById('spec-src-file');
    const url = (document.getElementById('spec-src-url').value || '').trim();
    let text, label;
    if (fileEl && fileEl.files && fileEl.files.length) {
      text = await SmashSeed.readCsvFile(fileEl.files[0]);
      label = fileEl.files[0].name;
    } else if (url) {
      const sheets = SmashSeed.getSheetsCsvUrl(url);
      if (sheets) {
        text = await SmashSeed.fetchSheetsCsv(url);
        label = 'Google Sheets';
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        text = await res.text();
        label = 'CSV URL';
      }
    } else {
      _specStatus('URL を入力するかファイルを選択してください。', true);
      return;
    }
    const parsed = SmashSeed.parseCsv(text);
    const rows = parsed.rows || [];
    if (!rows.length) throw new Error('CSV に行がありません');
    applySpecRows(rows, label);
  } catch (e) {
    _specStatus('読み込みエラー: ' + escHtml((e && e.message) ? e.message : e), true);
  }
}

// 現在の作業状況 (シード順 + 固定 + プール/ウェーブ設定) を CSV に書き出す。
// 読み込み側 (applySpecRows) が理解する列だけを使うので、そのままインポートすれば
// 同じ状態を再現できる = 他の人との共有に使える。
//   seed  : シード番号 (順序の復元に使う)
//   name / discriminator / uid : 参加者の照合 (uid → disc → name の順で使われる)
//   lock  : pool / wave / 空 (固定の種別。対象は seed 順から決まる)
//   pool  : 参考表示 (A3 / P3。読み込み時は無視される)
//   pools / waves : プール数・ウェーブ数 (1 行目のみ。読み込み時に設定へ反映)
function exportSeedWorkCsv() {
  if (!DATA.length) { _specStatus('参加者が読み込まれていません。', true); return; }
  const recs = orderedRecs();
  const P = Math.max(1, parseInt((document.getElementById('so-pools') || {}).value, 10) || 1);
  const waveMap = currentWaveMap(P);
  const W = waveMap.reduce((m, w) => Math.max(m, w), 0) + 1;
  const locks = (SEED_SPEC && SEED_SPEC.locks) || {};
  const field = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ['seed,name,discriminator,uid,lock,pool,pools,waves'];
  recs.forEach((r, i) => {
    const lk = locks[r.user_id];
    const kind = lk ? (lk.kind || lk) : '';
    // disc は ="..." で書く (Excel / Sheets が指数表記の数値に化けさせるのを防ぐ)。
    const disc = r.discriminator || (DISCRIMINATORS && DISCRIMINATORS[String(r.user_id)]) || '';
    lines.push([
      i + 1,
      field(r.display),
      disc ? '="' + disc + '"' : '',
      (r.user_id != null && r.user_id > 0) ? r.user_id : '',
      kind,
      field(P >= 2 ? poolLabel(SeedOptimizer.poolOfSeed(i, P), waveMap) : ''),
      i === 0 ? P : '',
      i === 0 ? W : '',
    ].join(','));
  });
  const name = ((EVENT_CONTEXT && EVENT_CONTEXT.eventName) || (CSV_SOURCE && CSV_SOURCE.label) || 'seed')
    .replace(/[^\w\-]/g, '_').slice(0, 40);
  downloadCsvTemplate(lines, `spsp_seed_work_${name}.csv`);
  const nLock = recs.filter(r => locks[r.user_id]).length;
  const msg = `${recs.length}人のシード順${nLock ? ` + 固定 ${nLock}人` : ''}` +
    `${APPLIED_ORDER ? ' (被り回避を適用した並び)' : ''} を保存しました。読み込めば同じ状態を再現できます。`;
  const note = document.getElementById('work-note');
  if (note) note.textContent = '✅ ' + msg;
  _specStatus('💾 ' + msg);
}

// 🏆 トーナメントプレビュー: 現在の出力順 (orderedRecs) + プール数/ウェーブを
// ペイロード化して site/bracket/ へのリンクを発行する (別タブ + クリップボード)。
// フェーズ区切り (Top カット) の追加はプレビューページ側で編集できる。
// プレビュー URL の長さ上限 (これを超えたら名前の同梱を DB 未登録者だけに落とす)。
// プレビュー側も 9,500 字超で「共有には CSV 推奨」と出すので、それと揃えている。
const BRACKET_URL_BUDGET = 9500;

async function issueBracketPreview() {
  const note = document.getElementById('work-note');
  const say = (m) => { if (note) note.textContent = m; };
  if (!DATA.length) { say('参加者が読み込まれていません。'); return; }
  if (typeof SeedShare === 'undefined') { say('❌ seed_share.js が読み込まれていません。'); return; }
  try {
    const recs = orderedRecs();
    const P = Math.max(1, parseInt((document.getElementById('so-pools') || {}).value, 10) || 1);
    const waveMap = currentWaveMap(P);
    const uids = recs.map((r) => (r.user_id != null && r.user_id > 0) ? r.user_id : null);
    // 表示名。uid が無い参加者は URL に名前が無いと誰か分からなくなるので必ず入れる。
    const nameAt = (r, i) => r.display || (uids[i] == null ? '参加者' + (i + 1) : '');
    // 名前は原則 全員分を URL に載せる。プレビュー側が players/<uid>.json を
    // 取れなくても (回線・DB 未登録・上位帯の巨大 JSON) 名前だけは必ず出せるようにするため。
    // 規模が大きく URL が共有に耐えなくなる場合だけ、DB 登録者を落として uid 復元に任せる
    // (そのときはプール当たりの人数が小さいので、プレビュー側の取得も軽い)。
    const fullNames = {}, minimalNames = {};
    recs.forEach((r, i) => {
      const nm = nameAt(r, i);
      if (!nm) return;
      fullNames[String(i)] = nm;
      if (uids[i] == null || !MASTER_MAP || !MASTER_MAP.has(uids[i])) minimalNames[String(i)] = nm;
    });
    // フェーズ構成: start.gg から取れた連鎖 (通過人数込み) があればそれを初期値にする。
    // 取れない / プール数がシード画面の値と食い違う / 検証が通らない場合は従来の既定
    // (adv=2 + 自動最終フェーズ) にフォールバックする。
    let phases = null;
    let phasesFromGg = false;
    const fetched = EVENT_CONTEXT && EVENT_CONTEXT.phasesConfig;
    if (fetched && fetched.length >= 2 && (fetched[0].pools | 0) === P) {
      const cand = SeedShare.withFinalPhase(fetched.map((p) => Object.assign({}, p)), recs.length);
      if (!SeedShare.validatePhases(cand, recs.length).length) {
        phases = cand;
        phasesFromGg = true;
      }
    }
    if (!phases) {
      // プールが 2 つ以上なら、その先の 1 プールのフェーズまで作る (そこで終われないため)
      phases = SeedShare.withFinalPhase([{ name: P >= 2 ? '予選' : 'ブラケット', pools: P, adv: 2 }], recs.length);
    }
    const payload = {
      v: 1,
      ev: (EVENT_CONTEXT && EVENT_CONTEXT.eventName) || (CSV_SOURCE && CSV_SOURCE.label) || 'シードプレビュー',
      src: SEED_APP_CONFIG.mode,
      phases,
      wv: waveMap,
      uids, names: fullNames,
    };
    const bracketUrl = new URL('../bracket/', location.href).toString();
    let blob = await SeedShare.encodePayload(payload);
    let url = bracketUrl + SeedShare.buildFragment({ ph: 0, wd: 1 }, blob);
    let trimmed = false;
    if (url.length > BRACKET_URL_BUDGET) {
      payload.names = minimalNames;
      blob = await SeedShare.encodePayload(payload);
      url = bracketUrl + SeedShare.buildFragment({ ph: 0, wd: 1 }, blob);
      trimmed = true;
    }
    window.open(url, '_blank', 'noopener');
    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch (e) { /* clipboard 不可の環境 */ }
    say(`🏆 プレビューを開きました (${recs.length}人 / URL ${url.length.toLocaleString()}字${copied ? '・コピー済み' : ''})。` +
      (trimmed ? ' 人数が多いため URL には SPSP 未登録者の名前だけを入れ、登録者名はプレビュー側で復元します。' : '') +
      (phasesFromGg
        ? `フェーズ構成 (${phases.map((p) => p.name).join(' → ')}) は start.gg の進出設定から自動設定しました。`
        : 'Top カットの区切りはプレビューページの「フェーズ構成」で設定できます。'));
  } catch (e) {
    say('❌ プレビュー発行に失敗: ' + (e && e.message));
  }
}

function clearSeedSpec() {
  if (!SEED_SPEC) { _specStatus('クリアする指定・固定はありません。'); return; }
  SEED_SPEC = null;
  saveManual();
  render();
  _specStatus('指定・固定をクリアしました (並び自体は現在の手動調整のまま。並びも戻す場合は手動調整を破棄してください)。');
}

// SEED_SPEC が空になったら null に戻す (保存・表示の簡素化)。
function _pruneSeedSpec() {
  if (!SEED_SPEC) return;
  const n = (o) => Object.keys(o || {}).length;
  if (!n(SEED_SPEC.locks) && !n(SEED_SPEC.pins) && !n(SEED_SPEC.waves)) SEED_SPEC = null;
}

// 固定設定バーの「適用」: 種別 (なし/プール/ウェーブ) と対象を SEED_SPEC.locks に保存する。
// 並びへの反映は読み取り時射影 (_projectSeedLocks) が常時行う = 最適化しなくても
// 固定者は指定プール/ウェーブへ挿入ソート的に移動し、解除すれば元の位置付近に戻る。
function applySeedLockChoice(uid) {
  // 固定バーは表 (行の直下) にある。以前の manual-bar 内も一応拾えるよう document 全体で探す。
  const kindEl = document.querySelector('[data-mn-lock-kind]');
  const targetEl = document.querySelector('[data-mn-lock-target]');
  const kind = kindEl ? kindEl.value : 'none';
  if (kind === 'none') {
    if (SEED_SPEC && SEED_SPEC.locks) delete SEED_SPEC.locks[uid];
    _pruneSeedSpec();
  } else {
    const target = targetEl ? parseInt(targetEl.value, 10) : 0;
    if (!SEED_SPEC) SEED_SPEC = { label: null, pins: {}, waves: {}, locks: {} };
    if (!SEED_SPEC.locks) SEED_SPEC.locks = {};
    SEED_SPEC.locks[uid] = { kind, target: Number.isFinite(target) ? target : 0 };
  }
  MANUAL.lockSel = null;
  MANUAL.lockKind = null;
  saveManual();
  renderManualUI();
  renderSpecStatus();
}

// spec パネルの配線 (スケルトンは mount 済みなので要素は常に存在する)。
(function () {
  const loadBtn = document.getElementById('spec-src-load');
  if (loadBtn) loadBtn.addEventListener('click', () => { loadSpecSource(); });
  const tplBtn = document.getElementById('spec-tpl');
  // seed / wave / lock はすべて任意 (2 行目が空欄可の例)。
  if (tplBtn) tplBtn.addEventListener('click', () => downloadCsvTemplate([
    'name,discriminator,seed,wave,lock',
    `${CSV_TPL_OUT_NAMES[0]},="00000000",1,A,pool`,
    `${CSV_TPL_OUT_NAMES[1]},="00000001",,,wave`,
  ], 'spsp_seed_spec_template.csv'));
  const exportBtn = document.getElementById('spec-export');
  if (exportBtn) exportBtn.addEventListener('click', exportSeedWorkCsv);
  const bracketBtn = document.getElementById('bracket-preview');
  if (bracketBtn) bracketBtn.addEventListener('click', issueBracketPreview);
  const clearBtn = document.getElementById('spec-clear');
  if (clearBtn) clearBtn.addEventListener('click', clearSeedSpec);
  // プール数/ウェーブ数の変更は手動列のプール表示 (A3/P3) に反映する。
  const poolsEl = document.getElementById('so-pools');
  if (poolsEl) poolsEl.addEventListener('input', () => renderManualUI());
  const wavesEl = document.getElementById('so-waves');
  if (wavesEl) wavesEl.addEventListener('input', () => renderManualUI());
})();
