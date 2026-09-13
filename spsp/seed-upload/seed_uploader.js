// seed_uploader.js — shared start.gg seeding upload + CSV parsing helpers.
// Usable from both /banzuke/seed/ (dynamic ranking) and /banzuke/seed-upload/ (generic uploader).
// All requests go directly to start.gg from the user's browser. No data is sent anywhere else.

(function (global) {
  'use strict';

  const STARTGG_API = 'https://api.start.gg/gql/alpha';

  const UPDATE_MUTATION = `
    mutation UpdatePhaseSeeding($phaseId: ID!, $seedMapping: [UpdatePhaseSeedInfo]!) {
      updatePhaseSeeding(phaseId: $phaseId, seedMapping: $seedMapping) {
        id
      }
    }
  `;

  /**
   * Send updatePhaseSeeding mutation.
   * @param {string|number} phaseId
   * @param {string} token start.gg API token
   * @param {Array<{seedId: any, seedNum: any}>} mapping
   * @returns {Promise<{ok: true} | {ok: false, error: string}>}
   */
  async function uploadSeeding(phaseId, token, mapping) {
    if (!phaseId) return { ok: false, error: 'phaseId が空です' };
    if (!token) return { ok: false, error: 'API token が空です' };
    if (!Array.isArray(mapping) || mapping.length === 0) {
      return { ok: false, error: 'seedMapping が空です' };
    }
    // Normalize: ensure seedId and seedNum are numbers (start.gg requires int)
    const normalized = [];
    for (const m of mapping) {
      const sid = Number(m.seedId);
      const sn = Number(m.seedNum);
      if (!Number.isFinite(sid) || !Number.isFinite(sn)) {
        return {
          ok: false,
          error: `seedId/seedNum が数値として解釈できません: ${JSON.stringify(m)}`,
        };
      }
      normalized.push({ seedId: sid, seedNum: sn });
    }

    let res;
    try {
      res = await fetch(STARTGG_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({
          query: UPDATE_MUTATION,
          variables: { phaseId: String(phaseId), seedMapping: normalized },
        }),
      });
    } catch (e) {
      return { ok: false, error: 'ネットワークエラー: ' + e.message };
    }
    if (!res.ok) {
      return { ok: false, error: 'HTTP ' + res.status + ' ' + res.statusText };
    }
    let body;
    try { body = await res.json(); } catch (e) {
      return { ok: false, error: 'レスポンスが JSON ではありません' };
    }
    if (body.errors && body.errors.length) {
      return { ok: false, error: 'GraphQL: ' + body.errors[0].message };
    }
    return { ok: true, count: normalized.length };
  }

  /**
   * Extract Google Sheets CSV export URL from a Sheets URL or ID.
   * Returns null if input doesn't look like a valid Sheets reference.
   */
  function getSheetsCsvUrl(urlOrId) {
    if (!urlOrId) return null;
    const s = String(urlOrId).trim();
    // If it's already a sheets URL or just an ID
    if (/docs\.google\.com\/spreadsheets/.test(s) || /^[-\w]{25,}$/.test(s)) {
      const m = s.match(/[-\w]{25,}/);
      if (!m) return null;
      return 'https://docs.google.com/spreadsheets/d/' + m[0] + '/export?format=csv';
    }
    return null;
  }

  /**
   * Fetch CSV text from input that may be a Sheets URL/ID or a direct CSV URL.
   * For direct CSV URLs, fetch as-is (CORS must be permitted by the server).
   */
  async function fetchSheetsCsv(urlOrId) {
    const s = String(urlOrId || '').trim();
    let url;
    const sheetsUrl = getSheetsCsvUrl(s);
    if (sheetsUrl) {
      url = sheetsUrl;
    } else if (/^https?:\/\//i.test(s)) {
      // Direct CSV URL — fetch as-is
      url = s;
    } else {
      throw new Error('Google Sheets URL / CSV URL / Sheets ID のいずれかを入力してください');
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error('CSV/Sheets の取得に失敗 (' + r.status + ' ' + r.statusText + ')');
    return await r.text();
  }

  /**
   * Read CSV text from a File (e.g. from <input type="file">).
   */
  function readCsvFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('ファイル読み込みに失敗'));
      fr.readAsText(file, 'utf-8');
    });
  }

  /**
   * Parse CSV text via PapaParse (must be loaded as global Papa).
   * @returns {{rows: Array<Object>, headers: string[]}}
   */
  function parseCsv(csvText) {
    if (typeof Papa === 'undefined') {
      throw new Error('PapaParse が読み込まれていません');
    }
    const res = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    if (res.errors && res.errors.length) {
      // Non-fatal errors are sometimes returned; surface only the first.
      const e = res.errors[0];
      throw new Error('CSV パースエラー: ' + e.message + ' (row ' + e.row + ')');
    }
    return { rows: res.data || [], headers: res.meta.fields || [] };
  }

  /**
   * Parse event slug pair from URL.
   */
  function parseEventSlug(input) {
    if (!input) return null;
    const m = String(input).match(/tournament\/([^\/\s?#]+)\/event\/([^\/\s?#]+)/);
    if (!m) return null;
    return { slug: 'tournament/' + m[1] + '/event/' + m[2] };
  }

  const PHASE_LOOKUP_QUERY = `
    query EventPhases($slug: String) {
      event(slug: $slug) {
        id
        name
        phases { id name bracketType state }
      }
    }
  `;

  global.SmashSeed = {
    STARTGG_API,
    UPDATE_MUTATION,
    uploadSeeding,
    getSheetsCsvUrl,
    fetchSheetsCsv,
    readCsvFile,
    parseCsv,
  };
})(typeof window !== 'undefined' ? window : globalThis);
