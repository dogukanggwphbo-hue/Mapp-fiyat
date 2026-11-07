// ReefAPI istemcisi. Anahtar YALNIZCA ortam değişkeninden (REEFAPI_KEY) gelir; hiçbir dosyaya yazılmaz, günlüğe basılmaz.
// Bunlar mağazaların resmi API'si değildir: ReefAPI üçüncü taraf bir veri geçididir, site yapısı değişirse bozulabilir.
// İstek: POST https://api.reefapi.com/<engine>/v1/<action>   başlık: x-api-key

import { createHash } from 'node:crypto';

export class BudgetError extends Error {}
export class ReefError extends Error {
  constructor(msg, { status = 0, code = '', keyProblem = '' } = {}) { super(msg); this.status = status; this.code = code; this.keyProblem = keyProblem; }
}

/** Anahtarın kısa parmak izi (günlükte/durum dosyasında anahtarın kendisi yerine kullanılır; anahtar geri çıkarılamaz). */
export const keyFp = (k) => createHash('sha256').update(String(k)).digest('hex').slice(0, 10);
const CREDIT_RE = /credit|kredi|quota|kota|balance|bakiye|insufficient|payment|usage limit|upgrade|out of/i;   // 'rate limit exceeded' (hız sınırı) kasıtlı olarak dışarıda
/**
 * Yanıt "bu anahtar kullanılamıyor" anlamına geliyorsa { why, persist } döner, yoksa null.
 * kredi: 402 ya da kredi/kota mesajı (401/403/429) · gecersiz: 401 · yetki: 403 (geçici olabilir, kalıcı işaretlenmez).
 * Mesajsız 429 kredi bitti değil, hız sınırıdır: yeniden denenir.
 */
export function keyProblem(status, msg) {
  msg = String(msg == null ? '' : msg);
  if (status === 402 || ((status === 401 || status === 403 || status === 429) && CREDIT_RE.test(msg))) return { why: 'kredi', persist: true };
  if (status === 401) return { why: 'gecersiz', persist: true };
  if (status === 403) return { why: 'yetki', persist: false };
  return null;
}

/** Mağaza o aramada hiç ürün listesi döndürmediyse (boş sonuç): hata değil, "bu aramada ürün yok" demektir. */
export function isEmptyResult(e) {
  return e instanceof ReefError && /without a product grid|no product listing|no results|no products/i.test(String(e.message));
}
/** Tüm turu durdurması gereken hatalar: kredi sınırı, anahtar/yetki sorunu. */
export function isFatal(e) {
  return e instanceof BudgetError || (e instanceof ReefError && (!!e.keyProblem || e.status === 401 || e.status === 402 || e.status === 403 || /REEFAPI_KEY/.test(String(e.message))));
}

export function createClient({
  key,
  keys,   // birden çok anahtar (öncelik sırasıyla): biri biterse/geçersizse sıradaki ile kesintisiz devam edilir
  slots,  // isteğe bağlı: anahtarların kasadaki yuva numaraları (1, 2, 3); yalnızca kayıt/günlük içindir
  fetchImpl = globalThis.fetch,
  maxCredits = Infinity,
  base = 'https://api.reefapi.com',
  timeoutMs = 90000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const pairs = (Array.isArray(keys) && keys.length ? keys : [key]).map((k, i) => [String(k || '').trim(), Array.isArray(slots) ? slots[i] : undefined]).filter((p, i, a) => p[0] && a.findIndex((x) => x[0] === p[0]) === i);
  const ks = pairs.map((p) => p[0]), sl = pairs.map((p) => p[1]);
  const st = { spent: 0, calls: 0, bodyMode: 'direct', idx: 0, bad: [] };
  const redact = (s) => { s = String(s == null ? '' : s); ks.forEach((k) => { s = s.split(k).join('***'); }); return s; };

  async function once(engine, action, params, mode) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/${engine}/v1/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ks[st.idx] },
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
    if (!ks.length) throw new ReefError('REEFAPI_KEY tanımlı değil (GitHub gizli kasasına eklenmeli).');
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
      const kp = keyProblem(res.status, msg);
      if (kp) {
        const fp = keyFp(ks[st.idx]);
        if (!st.bad.some((b) => b.fp === fp)) st.bad.push({ fp, why: kp.why, persist: kp.persist, status: res.status });
        if (st.idx + 1 < ks.length) { st.idx++; attempt--; continue; }   // sıradaki anahtarla aynı isteği tekrarla
      }
      if (!kp && (res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2 * attempt;
        await sleep(Math.min(ra, 30) * 1000);
        continue;
      }
      throw new ReefError(`${engine}/${action}: HTTP ${res.status} ${msg.slice(0, 200)}`, { status: res.status, code: j && j.error && j.error.code, keyProblem: kp ? kp.why : '' });
    }
  }

  return {
    call,
    get spent() { return st.spent; },
    get calls() { return st.calls; },
    get remaining() { return maxCredits - st.spent; },
    get badKeys() { return st.bad; },                 // bu turda kullanılamaz çıkan anahtarlar (parmak izi)
    get keyIndex() { return st.idx; },                // kaçıncı anahtarla çalışıldı (0 = ilk)
    get keyCount() { return ks.length; },
    get activeFp() { return ks.length ? keyFp(ks[st.idx]) : ''; },
    get activeSlot() { return sl[st.idx]; },
  };
}
