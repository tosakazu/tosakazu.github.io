// post_config.js — 投稿機能の設定値。**人間が実値を入れる唯一のファイル**。
//
// ここに秘匿値は置かない。client secret は GAS のスクリプトプロパティのみ (INV-3)。
//
// 反映手順は docs/DEPLOY.md 参照。
(function (global) {
  'use strict';

  global.SPSP_POST_CONFIG = {
    // start.gg アプリの Application ID (公開値)。
    CLIENT_ID: '582',

    // GAS Web アプリの /exec URL。デプロイ ID を固定して使う (docs/DEPLOY.md)。
    GAS_ENDPOINT: 'https://script.google.com/macros/s/AKfycbzipXG5iAMHR7YwV-p9RALpxlAGWJcPizpfMbxX58nSNAm_H5CNkdN-diGN1QaBVwRzNQ/exec',

    // 認可エンドポイント。api. が付かない点に注意 (token 側は api.start.gg)。
    // start.gg のアプリ設定にある URL 生成ツールの出力と食い違う場合はそちらを正とする。
    AUTHORIZE_URL: 'https://start.gg/oauth/authorize',

    // start.gg アプリに登録した redirect URI と **完全一致**していること。
    REDIRECT_URI: 'https://tosakazu.github.io/spsp/callback.html',

    SCOPE: 'user.identity',

    // 投稿ページを正規に配信している場所。ここ以外 (spsp.games などの
    // 検証・ビルド用配信) では認証を開始せず、正規 URL へ案内する。
    CANONICAL_ORIGIN: 'https://tosakazu.github.io',
    CANONICAL_BASE: '/spsp/',

    // GAS 側の BODY_MAX と同じ数え方 (UTF-16 code unit)。
    BODY_MAX: 1000,

    // ダブルメイン圏の判定閾値 (characters[].pct のトップとの差)。
    // gas/config.gs の DOUBLE_MAIN_PCT_GAP と同じ値にすること (テストが検査する)。
    DOUBLE_MAIN_PCT_GAP: 0.10,
  };
})(typeof window !== 'undefined' ? window : globalThis);
