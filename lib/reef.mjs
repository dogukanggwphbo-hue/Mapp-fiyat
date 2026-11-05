// ReefAPI istemcisi. Anahtar YALNIZCA ortam değişkeninden (REEFAPI_KEY) gelir; hiçbir dosyaya yazılmaz, günlüğe basılmaz.
// Bunlar mağazaların resmi API'si değildir: ReefAPI üçüncü taraf bir veri geçididir, site yapısı değişirse bozulabilir.
// İstek: POST https://api.reefapi.com/<engine>/v1/<action>   başlık: x-api-key

export class BudgetError extends Error {}
export class ReefError extends Error {
  constructor(msg, { status = 0, code = '' } = {}) { super(msg); this.status = status; this.code = code; }
}

export function createClient({
  key,
  fetchImpl = globalThis.fetch,
  maxCredits = Infinity,
  base = 'https://api.reefapi.com',
  timeoutMs = 90000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const st = { spent: 0, calls: 0, bodyMode: 'direct' };
  const redact = (s) => { s = String(s == null ? '' : s); return key ? s.split(key).join('***') : s; };

  async function once(engine, action, params, mode) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/${engine}/v1/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(mode === 'wrapped' ? { params } : params),
        signal: ctl.signal,
      });
      const text = await res.text();
      let j = null;
      try { j = JSON.parse(text); } catch { /* json değil */ }
      return { res, j, text };
    } finally { clearTimeout(tm); }
  }

  async function call(engine, action, params, { cost = 1 } = {}) {
    if (!key) throw new ReefError('REEFAPI_KEY tanımlı değil (GitHub gizli kasasına eklenmeli).');
    if (st.spent + cost > maxCredits) throw new BudgetError(`Kredi sınırı (${maxCredits}) dolacağı için durduruldu.`);
    let attempt = 0;
    let mode = st.bodyMode;
    for (;;) {
      attempt++;
      let r;
      try { r = await once(engine, action, params, mode); }
      catch (e) {
        if (attempt < 3) { await sleep(2000 * attempt); continue; }
        throw new ReefError('Ağ hatası: ' + redact(e && e.message ? e.message : e));
      }
      const { res, j, text } = r;
      if (res.ok && j && j.ok === true) {
        st.calls++;
        st.spent += Number(j.meta && j.meta.charged_credits) || 0;
        st.bodyMode = mode;
        return j;
      }
      const msg = redact((j && j.error && (j.error.message || j.error.code)) || text.slice(0, 200));
      if ((res.status === 400 || res.status === 422) && mode === 'direct' && /params/i.test(msg)) { mode = 'wrapped'; continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2 * attempt;
        await sleep(Math.min(ra, 30) * 1000);
        continue;
      }
      throw new ReefError(`${engine}/${action}: HTTP ${res.status} ${msg.slice(0, 200)}`, { status: res.status, code: j && j.error && j.error.code });
    }
  }

  return {
    call,
    get spent() { return st.spent; },
    get calls() { return st.calls; },
    get remaining() { return maxCredits - st.spent; },
  };
}
