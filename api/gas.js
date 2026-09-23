/**
 * Vercel server-side proxy to Google Apps Script.
 * Browser -> /api/gas -> GAS Web App -> Google Sheets
 *
 * Secrets remain in Vercel Environment Variables and never reach the browser.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'Gunakan GET atau POST.' });
  }

  const gasUrl = process.env.GAS_WEB_APP_URL;
  const apiKey = process.env.GAS_API_KEY;

  if (!gasUrl || !apiKey) {
    return send(res, 500, {
      ok: false,
      error: 'VERCEL_ENV_MISSING',
      message: 'Environment Variable GAS_WEB_APP_URL atau GAS_API_KEY belum diisi di Vercel.'
    });
  }

  try {
    const body = normalizeBody(req);
    const action = req.method === 'GET'
      ? String((req.query && req.query.action) || 'health')
      : String(body.action || 'health');

    const payload = {
      ...body,
      action,
      apiKey
    };

    const controller = new AbortController();
    const upstreamTimeoutMs = action === 'health' ? 20000 : 45000;
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);

    const startedAt = Date.now();
    const upstream = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timer);
    res.setHeader('X-NC-Upstream-Ms', String(Date.now() - startedAt));
    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return send(res, 502, {
        ok: false,
        error: 'GAS_INVALID_RESPONSE',
        message: 'GAS merespons, tetapi bukan JSON. Pastikan URL berakhiran /exec dan deployment masih aktif.',
        preview: text.slice(0, 160)
      });
    }

    return send(res, data && data.ok === false ? 400 : 200, data);
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    return send(res, isAbort ? 504 : 502, {
      ok: false,
      error: isAbort ? 'GAS_TIMEOUT' : 'GAS_UNREACHABLE',
      message: isAbort
        ? 'GAS terlalu lama merespons. Coba lagi.'
        : 'Vercel tidak dapat menghubungi GAS. Periksa deployment URL dan akses Web App.',
      detail: err && err.message ? err.message : String(err)
    });
  }
};

function normalizeBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return {};
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}
