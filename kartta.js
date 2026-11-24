/* Pilkkitutka – kartta.js v008 (24.11.2026)
 * v008 (Hannu 24.11.: "Miksi ei käyriä kartoissa. Merellä on?"): järvien syvyyskäyrät samaan kerrokseen kuin meren käyrät, tummempi tyyli.
 *      Omat Lowrance-käyrät (luotaus.js) ruskeina, pilkkipaikan rajaus katkoviivalla.
 * v006 (Hannu 24.11.: Lappajärvi, Varpula, Hirvijärvi omiin ikkunoihin): järvien syvyysruudukot (uistelututkasta) kuvana.
 * v005 (Hannu 23.11.: "Oma salmien mittaus kartalta ja nimeäminen. Arvo ja suunta kartalle salmen keskelle. Copernicus pohjan
 *   lämpödata kartalle … virtauksetkin voisi visualisoida mitä voi. Väylät ja merimerkit"):
 *   omat salmet (viiva, lahti, nuoli ja arvo), pohjan lämpö, virtaviiva-animaatio, Väyläviraston väylät ja turvalaitteet
 *   (piirto merilohitutkan v61:n mukaan), piirtotila ilman kaksoisnapautusta.
 * v004: tilannekuvakerrokset – jää (Copernicus-malli), virta (0,5 m / ~5 m, 3 h välein), tuuli (HARMONIE) ja aikavalinta.
 * v003: reikäloki (vaihe 3): reiät kartalla syvyysnumerolla, väri pääkalan mukaan, aktiivinen reikä kultarenkaalla.
 * Kevyt oma karttanäkymä ilman ulkoisia kirjastoja, merilohitutkan kartta.js:n periaatteella:
 *  - OSM-pohjakartta (laatat tile.openstreetmap.org)
 *  - Traficomin syvyyskäyrät (hakuajo, hae_syvyys.py -> data/syvyys/<alue>/syvyys.json)
 *  - oma jälki 10 vrk: uusin kirkas, vanhempi haalenee
 *  - pysähdykset = oletettu pilkkipaikka (oletus ≥ 5 min alle 20 m säteellä; Hannu 23.11.2026 "Ok")
 *  - omat pisteet merkillä ja nimellä, GPS-piste, leiri
 * Puhtaat funktiot (jalkiLisaa, pysahdykset, puraSyvyys, jalkiAlfa) testattavissa Nodessa.
 * Ei navigointikäyttöön.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------ projektio (Web Mercator, yksikköneliö)
  const TILE = 256;
  const mx = lon => (lon + 180) / 360;
  const my = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2; };
  const mLon = x => x * 360 - 180;
  const mLat = y => { const n = Math.PI - 2 * Math.PI * y; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

  function etaisyysM(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // ------------------------------------------------------------ jälki
  // Piste: [t (s), lat × 1e5, lon × 1e5, tarkkuus m]
  const JALKI = {
    ikaMs: 10 * 864e5,   // 10 vrk (Hannu)
    tarkkuusM: 30,       // huonompi GPS-arvio hylätään [O]
    minSiirtymaM: 8,     // uusi piste, kun liikuttu vähintään näin [O]
    sykeS: 60,           // paikallaan ollessa piste minuutin välein, jotta pysähdyksen kesto näkyy [O]
  };
  function jalkiLisaa(jalki, p, nytMs, opts) {
    const o = Object.assign({}, JALKI, opts || {});
    let j = Array.isArray(jalki) ? jalki : [];
    const raja = Math.floor((nytMs - o.ikaMs) / 1000);
    let alku = 0;
    while (alku < j.length && !(j[alku][0] >= raja)) alku++;
    if (alku) j = j.slice(alku);
    const tulos = { jalki: j, lisatty: false, poistettu: alku };
    if (!p || !isFinite(p.lat) || !isFinite(p.lon) || !isFinite(p.t)) return tulos;
    if (!(p.tarkkuus <= o.tarkkuusM)) return tulos;
    const t = Math.floor(p.t / 1000);
    if (t < raja) return tulos;
    const ed = j[j.length - 1];
    if (ed) {
      if (t <= ed[0]) return tulos;
      const d = etaisyysM(ed[1] / 1e5, ed[2] / 1e5, p.lat, p.lon);
      if (d < o.minSiirtymaM && t - ed[0] < o.sykeS) return tulos;
    }
    j = j === jalki ? j.slice() : j;
    j.push([t, Math.round(p.lat * 1e5), Math.round(p.lon * 1e5), Math.round(p.tarkkuus)]);
    tulos.jalki = j; tulos.lisatty = true;
    return tulos;
  }

  /** Kirkkaus iän mukaan: nyt 1, 1 vrk 0,84, 3 vrk 0,57, 5 vrk 0,36, 10 vrk 0,15 [O]. */
  function jalkiAlfa(ikaS, maxS) {
    const f = Math.max(0, Math.min(1, ikaS / (maxS || JALKI.ikaMs / 1000)));
    return 0.15 + 0.85 * (1 - f) * (1 - f);
  }

  /** Jäljen yhtenäiset osat: katko, jos väli > katkoS ja siirtymä > hyppyM, tai siirtymä > 2 km. */
  function jalkiOsat(J, katkoS, hyppyM) {
    katkoS = katkoS || 600; hyppyM = hyppyM || 50;
    const osat = []; let alku = 0;
    for (let i = 1; i < J.length; i++) {
      const dt = J[i][0] - J[i - 1][0], d = etaisyysM(J[i - 1][1] / 1e5, J[i - 1][2] / 1e5, J[i][1] / 1e5, J[i][2] / 1e5);
      if ((dt > katkoS && d > hyppyM) || d > 2000) { if (i - 1 > alku) osat.push([alku, i - 1]); alku = i; }
    }
    if (J.length - 1 > alku) osat.push([alku, J.length - 1]);
    return osat;
  }

  // ------------------------------------------------------------ pysähdykset = oletettu pilkkipaikka
  const PYSAHDYS = { sadeM: 20, minKestoS: 300, katkoS: 120 };
  /** Peräkkäiset pisteet, jotka pysyvät sadeM:n sisällä ryhmän keskipisteestä vähintään minKestoS.
   *  Myös näytön sammuessa syntynyt aukko lasketaan, jos ennen ja jälkeen ollaan samassa kohdassa (katko = true). */
  function pysahdykset(J, opts) {
    const o = Object.assign({}, PYSAHDYS, opts || {});
    const out = [], n = (J || []).length;
    let i = 0;
    while (i < n) {
      let sl = J[i][1], so = J[i][2], k = 1, j = i + 1, maxVali = 0;
      while (j < n) {
        const d = etaisyysM(sl / k / 1e5, so / k / 1e5, J[j][1] / 1e5, J[j][2] / 1e5);
        if (d > o.sadeM) break;
        maxVali = Math.max(maxVali, J[j][0] - J[j - 1][0]);
        sl += J[j][1]; so += J[j][2]; k++; j++;
      }
      const t0 = J[i][0], t1 = J[j - 1][0];
      if (t1 - t0 >= o.minKestoS) {
        out.push({ t0, t1, kestoS: t1 - t0, lat: sl / k / 1e5, lon: so / k / 1e5, n: k, katko: maxVali > o.katkoS });
        i = j;
      } else i++;
    }
    return out;
  }

  // ------------------------------------------------------------ syvyyskäyrät (hae_syvyys.py:n delta-koodaus)
  function puraSyvyys(j) {
    if (!j || !j.kayrat || !j.origo) return null;
    const [olat, olon] = j.origo, kk = j.kerroin || 100000, tasot = [];
    for (const avain of Object.keys(j.kayrat)) {
      const viivat = [];
      for (const koodi of j.kayrat[avain]) {
        const n = koodi.length >> 1;
        if (n < 2) continue;
        const m = new Float64Array(n * 2);
        let x = 0, y = 0, la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
        for (let i = 0; i < n; i++) {
          x += koodi[2 * i]; y += koodi[2 * i + 1];
          const lat = olat + y / kk, lon = olon + x / kk;
          m[2 * i] = mx(lon); m[2 * i + 1] = my(lat);
          if (lat < la0) la0 = lat; if (lat > la1) la1 = lat; if (lon < lo0) lo0 = lon; if (lon > lo1) lo1 = lon;
        }
        viivat.push({ m, la0, la1, lo0, lo1 });
      }
      tasot.push({ syvyys: parseFloat(avain), viivat });
    }
    tasot.sort((a, b) => a.syvyys - b.syvyys);
    return { luotu: j.luotu, lahde: j.lahde, tasot };
  }

  // ------------------------------------------------------------ väylät ja turvalaitteet (Väylävirasto, merilohitutkan hae_vaylat.py)
  /** vaylat.json -> { luotu, linjat: [{ m, ll, la0.., s, h }], alueet: [...], merkit: [...] } tai null. */
  function puraVaylat(j) {
    if (!j || (!j.linjat && !j.alueet) || !j.origo) return null;
    const [olat, olon] = j.origo, kk = j.kerroin || 100000;
    const pura = a => {
      const koodi = Array.isArray(a) ? a : a && a.k;
      if (!koodi || koodi.length < 4) return null;
      const n = koodi.length >> 1, m = new Float64Array(n * 2), ll = new Float64Array(n * 2);
      let x = 0, y = 0, la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
      for (let i = 0; i < n; i++) {
        x += koodi[2 * i]; y += koodi[2 * i + 1];
        const lat = olat + y / kk, lon = olon + x / kk;
        m[2 * i] = mx(lon); m[2 * i + 1] = my(lat); ll[2 * i] = lat; ll[2 * i + 1] = lon;
        if (lat < la0) la0 = lat; if (lat > la1) la1 = lat; if (lon < lo0) lo0 = lon; if (lon > lo1) lo1 = lon;
      }
      return { m, ll, la0, la1, lo0, lo1, s: Array.isArray(a) || a.s === undefined ? null : a.s, h: Array.isArray(a) || a.h === undefined ? null : a.h };
    };
    return { luotu: j.luotu, lahde: j.lahde, linjat: (j.linjat || []).map(pura).filter(Boolean), alueet: (j.alueet || []).map(pura).filter(Boolean),
      merkit: (j.merkit || []).filter(m => m && Array.isArray(m.p) && m.p.length === 2 && isFinite(m.p[0]) && isFinite(m.p[1])) };
  }
  /** Lähin väylä (linja tai alueen reuna) metreinä: { m, syvyys } tai null. */
  function lahinVayla(lista, lat, lon, rajaM) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110574, dLa = rajaM / ky, dLo = rajaM / kx;
    let paras = null;
    for (const V of lista || []) for (const v of V.alueet.concat(V.linjat)) {
      if (v.la1 < lat - dLa || v.la0 > lat + dLa || v.lo1 < lon - dLo || v.lo0 > lon + dLo) continue;
      const p = v.ll;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = (p[i + 1] - lon) * kx, ay = (p[i] - lat) * ky, bx = (p[i + 3] - lon) * kx, by = (p[i + 2] - lat) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d <= rajaM && (!paras || d < paras.m || (Math.abs(d - paras.m) < 1 && v.s != null && paras.syvyys == null))) paras = { m: d, syvyys: v.s };
      }
    }
    return paras;
  }
  // navigointilajikoodi: 1 vasen, 2 oikea, 3 pohjois, 4 etelä, 5 länsi, 6 itä, 99 ei lajia [merilohitutka v61, rajapinnan OGC-sivu]
  const MERKKI_LAJI = { 1: 'vasen', 2: 'oikea', 3: 'pohjois', 4: 'etelä', 5: 'länsi', 6: 'itä' };
  const MK = '#111', MY = '#ffd400', MP = '#e53935', MV = '#2e9d4f', MW = '#f4f4f4';
  const MERKKI_SYMBOLI = { b: [MP], d: [MV], w: [MW], s: [MP, MW, MP], h: [MY, MK], j: [MY, MK, MY], f: [MK, MY], l: [MK, MY, MK] };
  const MERKKI_VARIT = { 1: [MP], 2: [MV], 3: [MK, MY], 4: [MY, MK], 5: [MY, MK, MY], 6: [MK, MY, MK] };
  function merkkiTyyli(m) {
    if (m.k === 'vlm') return { muoto: 'vlm', varit: [MW, MP], huippu: null, valo: false };
    const t = String(m.t || '').toLowerCase(), valo = m.v === 'K';
    const varit = MERKKI_VARIT[m.l] || MERKKI_SYMBOLI[m.s] || null;
    if (m.l >= 3 && m.l <= 6) return { muoto: 'kardinaali', varit, huippu: { 3: 'N', 4: 'S', 5: 'W', 6: 'E' }[m.l], valo };
    if (m.l === 1 || m.l === 2) return { muoto: 'lateraali', varit, huippu: m.l === 1 ? 'vasen' : 'oikea', valo };
    if (t.includes('kummeli')) return { muoto: 'kummeli', varit: [MW], huippu: null, valo };
    if (t.includes('linjamerkki')) return { muoto: 'linja', varit: varit || [MP, MW, MP], huippu: null, valo };
    if (t.includes('loisto') || t.includes('majakka')) return { muoto: 'loisto', varit: [MY], huippu: null, valo: true };
    return { muoto: 'muu', varit: varit || ['#9aa7b4'], huippu: null, valo };
  }
  function merkkiKuvaus(m) {
    if (m.k === 'vlm') return 'Vesiliikennemerkki: ' + (m.t || '–');
    const t = String(m.t || 'turvalaite').toLowerCase(), laji = MERKKI_LAJI[m.l];
    let nimi = laji ? (m.l <= 2 ? `${laji} ${t}` : `${laji}${t}`) : t;
    nimi = nimi.charAt(0).toUpperCase() + nimi.slice(1);
    const lisa = [m.a === 'KELLUVA' ? 'kelluva' : m.a === 'KIINTEÄ' ? 'kiinteä' : '', m.v === 'K' ? 'valaistu' : ''].filter(Boolean).join(', ');
    return nimi + (lisa ? ', ' + lisa : '') + (m.n ? ' · ' + m.n : '') + (m.u ? ` (nro ${m.u})` : '') + (m.x ? ' · ' + String(m.x).trim() : '');
  }
  /** Pohjan lämmön väri (°C) talvialueelle 0–5 °C [O asteikko]. */
  const LAMPO_ASTEIKKO = [[-1, [40, 40, 160]], [0, [30, 90, 220]], [1, [0, 170, 230]], [2, [40, 200, 150]], [3, [170, 220, 60]], [4, [255, 190, 40]], [5, [255, 110, 40]], [7, [220, 40, 40]]];
  function lampoVari(t, alfa) {
    if (t == null) return null;
    const A = LAMPO_ASTEIKKO;
    let c = A[A.length - 1][1];
    if (t <= A[0][0]) c = A[0][1];
    else for (let i = 1; i < A.length; i++) if (t <= A[i][0]) {
      const [t0, c0] = A[i - 1], [t1, c1] = A[i], f = (t - t0) / (t1 - t0);
      c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f)); break;
    }
    return `rgba(${c[0]},${c[1]},${c[2]},${alfa == null ? 0.5 : alfa})`;
  }
  /** Mitkä syvyyskäyrät janan a–b ylittävät (Mercator-tasossa): nouseva lista syvyyksiä. */
  function kayratJanalla(syvyysLista, a, b) {
    const ax = mx(a[1]), ay = my(a[0]), bx = mx(b[1]), by = my(b[0]), out = new Set();
    const laMin = Math.min(a[0], b[0]), laMax = Math.max(a[0], b[0]), loMin = Math.min(a[1], b[1]), loMax = Math.max(a[1], b[1]);
    const ristiin = (p1x, p1y, p2x, p2y) => {
      const d = (bx - ax) * (p2y - p1y) - (by - ay) * (p2x - p1x); if (d === 0) return false;
      const t = ((p1x - ax) * (p2y - p1y) - (p1y - ay) * (p2x - p1x)) / d, u = ((p1x - ax) * (by - ay) - (p1y - ay) * (bx - ax)) / d;
      return t >= 0 && t <= 1 && u >= 0 && u <= 1;
    };
    for (const S of syvyysLista || []) for (const taso of S.tasot) for (const v of taso.viivat) {
      if (out.has(taso.syvyys) || v.la1 < laMin || v.la0 > laMax || v.lo1 < loMin || v.lo0 > loMax) continue;
      const m = v.m;
      for (let i = 0; i + 3 < m.length; i += 2) if (ristiin(m[i], m[i + 1], m[i + 2], m[i + 3])) { out.add(taso.syvyys); break; }
    }
    return [...out].sort((x, y) => x - y);
  }
  /** Bilineaarinen virtauskenttä (cm/s) – sama kuin tilanne.js:n kenttaArvo, jotta kartta.js toimii yksinään. */
  function kentta(lat, lon, U, W, la, lo) {
    const n = lat.length, m = lon.length; if (n < 2 || m < 2) return null;
    const fy = (la - lat[0]) / (lat[n - 1] - lat[0]) * (n - 1), fx = (lo - lon[0]) / (lon[m - 1] - lon[0]) * (m - 1);
    if (!(fy >= 0 && fy <= n - 1 && fx >= 0 && fx <= m - 1)) return null;
    const y0 = Math.min(n - 2, Math.floor(fy)), x0 = Math.min(m - 2, Math.floor(fx)), ty = fy - y0, tx = fx - x0;
    const r0u = U[y0], r1u = U[y0 + 1], r0v = W[y0], r1v = W[y0 + 1];
    const q = [r0u[x0], r0u[x0 + 1], r1u[x0], r1u[x0 + 1], r0v[x0], r0v[x0 + 1], r1v[x0], r1v[x0 + 1]];
    for (const x of q) if (x == null) return null;
    const bl = (a, b, c, d) => (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    return [bl(q[0], q[1], q[2], q[3]), bl(q[4], q[5], q[6], q[7])];
  }

  // ------------------------------------------------------------ järvien syvyysruudukot (uistelututkan jarvet.js -muoto)
  const JARVI_VARIT = ['#d6efff', '#b0dcf7', '#86c4ec', '#5ea9de', '#3d8ecb', '#2774b4', '#195d9a', '#124a80', '#0d3a68', '#0a2d54', '#082343', '#061a33', '#051427', '#040f1e'];
  function b64Tavut(t) {
    if (typeof atob === 'function') { const r = atob(t), u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(t, 'base64'));   // Node-testit
  }
  /** Luokkien rajat keskisyvyyksistä: b0 = 0, b(k+1) = 2·m(k) − b(k). */
  function luokkaRajat(luokkaM) { const b = [0]; for (const m of luokkaM) b.push(Math.round((2 * m - b[b.length - 1]) * 100) / 100); return b; }
  /** jarvisyvyys.js:n järvi -> { …, maski, luokka (Uint8Array), rajat, latEtela, lonIta }. */
  function puraJarvi(tunnus, k) {
    if (!k || !k.maski || !k.syvyysLuokat) return null;
    const n = k.W * k.H, mb = b64Tavut(k.maski), sb = b64Tavut(k.syvyysLuokat);
    const maski = new Uint8Array(n), luokka = new Uint8Array(n);
    for (let q = 0; q < n; q++) {
      maski[q] = (mb[q >> 3] >> (7 - (q & 7))) & 1;
      const t = sb[q >> 1]; luokka[q] = (q & 1) ? (t & 15) : (t >> 4);
    }
    const latEtela = k.pohjoisLat - k.H * k.ruutu / 111320, latK = (k.pohjoisLat + latEtela) / 2;
    return { tunnus, nimi: k.nimi, lahde: k.lahde, W: k.W, H: k.H, ruutu: k.ruutu, pohjoisLat: k.pohjoisLat, lansiLon: k.lansiLon,
      luokkaM: k.luokkaM, anturiM: k.anturiM || 0, rajat: luokkaRajat(k.luokkaM), maski, luokka,
      latEtela, lonIta: k.lansiLon + k.W * k.ruutu / (111320 * Math.cos(latK * Math.PI / 180)) };
  }
  /** Syvyys pisteessä: { luokka, min, max, m (keskikohta + anturi) } tai null (maa / ruudukon ulkopuolella). */
  function jarviSyvyys(P, lat, lon) {
    if (!P) return null;
    const i = Math.floor((lon - P.lansiLon) * 111320 * Math.cos(lat * Math.PI / 180) / P.ruutu), j = Math.floor((P.pohjoisLat - lat) * 111320 / P.ruutu);
    if (i < 0 || j < 0 || i >= P.W || j >= P.H) return null;
    const q = j * P.W + i, l = P.luokka[q];
    if (!P.maski[q] || l >= P.luokkaM.length) return null;
    return { luokka: l, min: P.rajat[l] + P.anturiM, max: P.rajat[l + 1] + P.anturiM, m: P.luokkaM[l] + P.anturiM };
  }

  // ------------------------------------------------------------ merkit
  const MERKIT = {
    ahven: { nimi: 'Ahven', kirjain: 'A', vari: '#2e7d32' },
    siika: { nimi: 'Siika', kirjain: 'S', vari: '#4f6d7a' },
    kuha: { nimi: 'Kuha', kirjain: 'K', vari: '#b8860b' },
    made: { nimi: 'Made', kirjain: 'M', vari: '#6d4c41' },
    hyva: { nimi: 'Hyvä paikka', merkki: '★', vari: '#f9a825' },
    vaara: { nimi: 'Vaara', merkki: '⚠️', vari: '#c62828' },
    jaatie: { nimi: 'Jäätie / auto', merkki: '🚗', vari: '#1565c0' },
    leiri: { nimi: 'Leiri', merkki: '⛺', vari: '#6a1b9a' },
    jokeri: { nimi: 'Jokeri', merkki: '🃏', vari: '#ad1457' },
    muu: { nimi: 'Muu', kirjain: '•', vari: '#455a64' },
  };

  // ------------------------------------------------------------ reiät ja saalis (vaihe 3)
  // reikä = { id, t, lat, lon, gps, syvyys_m, pilkki, jaa_cm?, lumi_cm?, saaliit: [{ t, laji, maara, otti, otti_m?, pilkki }] }
  // maara: kokonaisluku, 'muutama' tai 'monta' (Hannu 23.11.2026: "yksinkertainen muutama monta tai kpl")
  const REIKA = { aktiivinenM: 25, aktiivinenH: 3 };   // [O] GPS:n heilunta huomioiden
  const LAJIT = ['ahven', 'siika', 'kuha', 'made', 'muu'];
  function reikaViimeisin(r) {
    let t = r.t;
    for (const s of r.saaliit || []) if (s.t > t) t = s.t;
    return t;
  }
  /** Aktiivinen reikä: tuorein reikä, jonka viimeisestä tapahtumasta on alle aktiivinenH ja joka on
   *  aktiivinenM:n sisällä sijainnista (jos sijaintia ei ole, pelkkä aika ratkaisee). */
  function aktiivinenReika(reiat, sij, nytMs, opts) {
    const o = Object.assign({}, REIKA, opts || {});
    let paras = null;
    for (const r of reiat || []) {
      const v = reikaViimeisin(r);
      if (nytMs - v > o.aktiivinenH * 3600e3 || v > nytMs + 60e3) continue;
      if (sij && etaisyysM(sij.lat, sij.lon, r.lat, r.lon) > o.aktiivinenM) continue;
      if (!paras || v > reikaViimeisin(paras)) paras = r;
    }
    return paras;
  }
  function saalisYhteenveto(saaliit) {
    const y = {};
    for (const s of saaliit || []) {
      const l = y[s.laji] || (y[s.laji] = { kpl: 0, muutama: 0, monta: 0 });
      if (s.maara === 'muutama') l.muutama++;
      else if (s.maara === 'monta') l.monta++;
      else l.kpl += Math.max(1, parseInt(s.maara, 10) || 1);
    }
    return y;
  }
  /** Pääkala: painona kpl 1, muutama 3, monta 8 [O]. */
  function paalaji(y) {
    let paras = null, pw = 0;
    for (const [laji, l] of Object.entries(y || {})) {
      const w = l.kpl + 3 * l.muutama + 8 * l.monta;
      if (w > pw) { pw = w; paras = laji; }
    }
    return paras;
  }
  function lajiTeksti(l) {
    const osat = [];
    if (l.kpl) osat.push(String(l.kpl));
    if (l.muutama) osat.push(l.muutama > 1 ? l.muutama + ' × muutama' : 'muutama');
    if (l.monta) osat.push(l.monta > 1 ? l.monta + ' × monta' : 'monta');
    return osat.join(' + ');
  }
  function yhteenvetoTeksti(y) {
    return LAJIT.filter(l => y[l]).map(l => (MERKIT[l] ? MERKIT[l].nimi : l) + ' ' + lajiTeksti(y[l])).join(' · ');
  }
  /** Lajeittain syvyysväli niistä rei'istä, joista lajia on saatu [L]. */
  function lajienSyvyydet(reiat) {
    const out = {};
    for (const r of reiat || []) {
      if (!isFinite(r.syvyys_m)) continue;
      for (const laji of Object.keys(saalisYhteenveto(r.saaliit))) {
        const o = out[laji] || (out[laji] = { min: Infinity, max: -Infinity, reikia: 0 });
        o.min = Math.min(o.min, r.syvyys_m); o.max = Math.max(o.max, r.syvyys_m); o.reikia++;
      }
    }
    return out;
  }
  // ------------------------------------------------------------ tilannekuvakerrosten värit
  /** Jään väri paksuuden mukaan; peitto < 50 % = avovesi/ajojää [O luokat]. */
  function jaaVari(paksuusCm, peittoPct) {
    if (peittoPct != null && peittoPct < 15) return null;                       // ei jäätä: ei piirretä
    if (peittoPct != null && peittoPct < 50) return 'rgba(30,60,200,0.35)';     // harva jää / avovettä
    const p = paksuusCm == null ? 0 : paksuusCm;
    if (p < 10) return 'rgba(230,40,40,0.38)';
    if (p < 20) return 'rgba(255,140,0,0.36)';
    if (p < 30) return 'rgba(255,220,0,0.34)';
    if (p < 40) return 'rgba(120,220,90,0.32)';
    return 'rgba(235,245,255,0.45)';
  }
  const JAA_SELITE = [['alle 10 cm', 'rgba(230,40,40,0.75)'], ['10–20', 'rgba(255,140,0,0.75)'], ['20–30', 'rgba(255,220,0,0.75)'],
    ['30–40', 'rgba(120,220,90,0.75)'], ['yli 40', 'rgba(235,245,255,0.9)'], ['harva / avovesi', 'rgba(30,60,200,0.7)']];
  /** Lähin aikaindeksi (ajat ISO-merkkijonoina tai päivinä). */
  function lahinAika(ajat, ms) {
    let paras = -1, pd = Infinity;
    (ajat || []).forEach((a, i) => { const t = Date.parse(a.length <= 10 ? a + 'T12:00:00Z' : a); const d = Math.abs(t - ms); if (d < pd) { pd = d; paras = i; } });
    return paras;
  }

  const syvTeksti = m => !isFinite(m) ? '?' : (m >= 10 ? String(Math.round(m)) : String(Math.round(m * 10) / 10).replace('.', ','));

  // ------------------------------------------------------------ karttanäkymä (vain selaimessa)
  const JALKI_VARI = [224, 17, 95];   // #e0115f

  class Kartta {
    constructor(canvas, opts) {
      opts = opts || {};
      this.c = canvas; this.g = canvas.getContext('2d');
      this.lat = opts.lat || 62.972; this.lon = opts.lon || 21.488; this.z = opts.z || 12;
      this.zMin = 6; this.zMax = 18.5;
      this.laatat = new Map(); this.w = 0; this.h = 0; this.dpr = 1;
      this.syvyys = [];            // puraSyvyys-tulokset
      this.jalki = []; this.pysahdykset = []; this.pisteet = []; this.reiat = []; this.aktiivinenId = null; this.gps = null; this.leiri = null;
      this.kerrokset = { jaa: false, virta: false, tuuli: false }; this.aika = Date.now(); this.virtaTaso = 0;
      this.jaaMalli = null; this.vesi = null; this.saa = null;
      this.vaylat = [];            // puraVaylat-tulokset osa-alueittain
      this.salmet = []; this.salmiVirtaFn = null; this.salmiLuonnos = null; this.vainNapautus = false;
      this.jarvet = [];            // puraJarvi-tulokset
      this.seuraa = false; this.valittu = null;
      this.onTap = null; this.onLongPress = null; this.onMuutos = null;
      this._osoittimet = new Map(); this._piirtoPyydetty = false;
      this._kiinnita();
      this.koko();
    }
    koko() {
      const r = this.c.getBoundingClientRect();
      this.dpr = Math.min(3, window.devicePixelRatio || 1);
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.c.width = Math.round(this.w * this.dpr); this.c.height = Math.round(this.h * this.dpr);
      this.piirra();
    }
    skaala() { return TILE * Math.pow(2, this.z); }
    ruutu(lat, lon) {
      const s = this.skaala();
      return [(mx(lon) - mx(this.lon)) * s + this.w / 2, (my(lat) - my(this.lat)) * s + this.h / 2];
    }
    ruutuM(X, Y) {   // valmiiksi Mercator-yksiköissä
      const s = this.skaala();
      return [(X - mx(this.lon)) * s + this.w / 2, (Y - my(this.lat)) * s + this.h / 2];
    }
    latLon(x, y) {
      const s = this.skaala();
      return [mLat(my(this.lat) + (y - this.h / 2) / s), mLon(mx(this.lon) + (x - this.w / 2) / s)];
    }
    nakyvaAlue() {
      const [la1, lo0] = this.latLon(0, 0), [la0, lo1] = this.latLon(this.w, this.h);
      return { lat_min: la0, lat_max: la1, lon_min: lo0, lon_max: lo1 };
    }
    keskita(lat, lon, z) { this.lat = lat; this.lon = lon; if (z) this.z = z; this._muuttui(); }
    zoomaa(kerroin, x, y) {
      x = x === undefined ? this.w / 2 : x; y = y === undefined ? this.h / 2 : y;
      const [la, lo] = this.latLon(x, y);
      this.z = Math.max(this.zMin, Math.min(this.zMax, this.z + Math.log2(kerroin)));
      const s = this.skaala();   // pidä sormen alla oleva kohta paikallaan
      this.lon = mLon(mx(lo) - (x - this.w / 2) / s);
      this.lat = mLat(my(la) - (y - this.h / 2) / s);
      this._muuttui();
    }
    _muuttui() { this.piirra(); if (this.onMuutos) this.onMuutos(); }
    piirra() {
      if (this._piirtoPyydetty) return;
      this._piirtoPyydetty = true;
      (root.requestAnimationFrame || (f => setTimeout(f, 16)))(() => { this._piirtoPyydetty = false; this._piirraNyt(); });
    }
    _piirraNyt() {
      const g = this.g;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.fillStyle = '#aad3df'; g.fillRect(0, 0, this.w, this.h);   // OSM:n veden sävy laattojen alle
      this._tausta();
      if (this.kerrokset.jaa) this._jaaKerros();
      else if (this.kerrokset.pohja) this._pohjaKerros();
      this._jarviSyvyys();
      this._syvyys();
      if (this.kerrokset.vaylat) this._vaylat();
      if (this.kerrokset.virta) this._virtaKerros();
      this._salmet();
      this._jalki();
      this._pysahdykset();
      this._reiat();
      if (this.kerrokset.vaylat && this.merkitNakyvissa()) this._turvalaitteet();
      if (this.kerrokset.tuuli) this._tuuliKerros();
      this._leiri();
      this._pisteet();
      this._luonnos();
      this._gps();
    }
    _laatta(z, x, y) {
      const n = Math.pow(2, z), xx = ((x % n) + n) % n;
      const avain = z + '/' + xx + '/' + y;
      let img = this.laatat.get(avain);
      if (img) { this.laatat.delete(avain); this.laatat.set(avain, img); return img; }   // LRU
      img = new Image();
      img.onload = () => this.piirra();
      img.onerror = () => { img._virhe = true; };
      if (y >= 0 && y < n) img.src = `https://tile.openstreetmap.org/${z}/${xx}/${y}.png`;
      this.laatat.set(avain, img);
      if (this.laatat.size > 300) this.laatat.delete(this.laatat.keys().next().value);
      return img;
    }
    _tausta() {
      const g = this.g, zt = Math.max(3, Math.min(18, Math.round(this.z)));
      const s = Math.pow(2, this.z - zt), koko = TILE * s;
      const kx = mx(this.lon) * TILE * Math.pow(2, zt) * s, ky = my(this.lat) * TILE * Math.pow(2, zt) * s;
      const x0 = Math.floor((kx - this.w / 2) / koko), x1 = Math.floor((kx + this.w / 2) / koko);
      const y0 = Math.floor((ky - this.h / 2) / koko), y1 = Math.floor((ky + this.h / 2) / koko);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const img = this._laatta(zt, x, y);
        if (img.complete && !img._virhe && img.naturalWidth)
          g.drawImage(img, x * koko - kx + this.w / 2, y * koko - ky + this.h / 2, koko + 0.5, koko + 0.5);
      }
    }
    _syvyys() {
      if (this.z < 10 || !this.syvyys.length) return;
      const g = this.g, A = this.nakyvaAlue(), merkityt = new Set();
      const meri = d => d <= 2 ? ['rgba(30,110,170,0.55)', 0.8] : d < 10 ? ['rgba(20,90,160,0.8)', 1.2]
        : d < 20 ? ['rgba(10,70,140,0.85)', 1.5] : ['rgba(5,45,110,0.9)', 1.9];
      const jarvi = d => d < 10 ? ['rgba(8,40,85,0.75)', 1.1] : ['rgba(4,25,60,0.85)', 1.5];   // järvillä syvyysvärien päällä tummempi
      const oma = d => [Math.round(d * 10) % 15 === 0 ? 'rgba(120,45,0,0.95)' : 'rgba(150,70,10,0.8)', Math.round(d * 10) % 15 === 0 ? 1.6 : 1.0];   // omat luotaukset, 1,5 m välein paksumpi
      g.save(); g.lineJoin = 'round'; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const nimiot = [];
      for (const S of this.syvyys) for (const taso of S.tasot) {
        const [vari, lev] = (S.oma ? oma : S.jarvi ? jarvi : meri)(taso.syvyys);
        g.strokeStyle = vari; g.lineWidth = lev; g.beginPath();
        for (const v of taso.viivat) {
          if (v.la1 < A.lat_min || v.la0 > A.lat_max || v.lo1 < A.lon_min || v.lo0 > A.lon_max) continue;
          const m = v.m; let pit = 0, px = null, py = null, mid = null;
          for (let i = 0; i < m.length; i += 2) {
            const [x, y] = this.ruutuM(m[i], m[i + 1]);
            if (px === null) g.moveTo(x, y); else { g.lineTo(x, y); pit += Math.abs(x - px) + Math.abs(y - py); }
            if (mid === null && pit > 60) mid = [x, y];
            px = x; py = y;
          }
          if (mid && pit > (S.oma ? 90 : 140) && this.z >= 12) nimiot.push([taso.syvyys, mid[0], mid[1], vari]);
        }
        g.stroke();
      }
      for (const S of this.syvyys) if (S.raja) {   // oman pilkkipaikan rajaus katkoviivalla
        const R = S.raja, [x0, y0] = this.ruutu(R.la1, R.lo0), [x1, y1] = this.ruutu(R.la0, R.lo1);
        if (x1 < 0 || y1 < 0 || x0 > this.w || y0 > this.h) continue;
        g.setLineDash([6, 5]); g.strokeStyle = 'rgba(120,45,0,0.8)'; g.lineWidth = 1.2; g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.setLineDash([]);
        if (S.nimi && x1 - x0 > 60) { g.fillStyle = 'rgba(120,45,0,0.95)'; g.textAlign = 'left'; g.fillText(S.nimi, x0 + 4, y0 - 7); g.textAlign = 'center'; }
      }
      for (const [d, x, y] of nimiot) {   // numerot harvennettuina, ettei näyttö tukkeudu
        if (x < 12 || y < 12 || x > this.w - 12 || y > this.h - 12) continue;
        const avain = Math.round(x / 70) + ',' + Math.round(y / 40);
        if (merkityt.has(avain)) continue;
        merkityt.add(avain);
        const txt = (Math.round(d * 10) / 10).toString().replace('.', ',');
        g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(x - 3 - txt.length * 3.5, y - 7, txt.length * 7 + 6, 14);
        g.fillStyle = '#0a3d6e'; g.fillText(txt, x, y);
      }
      g.restore();
    }
    _jalki() {
      const J = this.jalki; if (!J || J.length < 2) return;
      const g = this.g, nyt = Date.now() / 1000, BIN = 6 * 3600, ryhmat = new Map();
      for (const [a, b] of jalkiOsat(J)) {
        for (let i = a; i < b; i++) {
          const k = Math.floor((nyt - J[i + 1][0]) / BIN);
          if (!ryhmat.has(k)) ryhmat.set(k, []);
          ryhmat.get(k).push(i);
        }
      }
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
      const avaimet = [...ryhmat.keys()].sort((x, y) => y - x);   // vanhin ensin, uusin päälle
      for (const k of avaimet) {
        const al = jalkiAlfa((k + 0.5) * BIN);
        g.strokeStyle = `rgba(${JALKI_VARI.join(',')},${al.toFixed(2)})`; g.lineWidth = 3; g.beginPath();
        for (const i of ryhmat.get(k)) {
          const [x1, y1] = this.ruutu(J[i][1] / 1e5, J[i][2] / 1e5), [x2, y2] = this.ruutu(J[i + 1][1] / 1e5, J[i + 1][2] / 1e5);
          g.moveTo(x1, y1); g.lineTo(x2, y2);
        }
        g.stroke();
      }
      g.restore();
    }
    _pysahdykset() {
      const g = this.g, nyt = Date.now() / 1000;
      g.save();
      for (const p of this.pysahdykset) {
        const [x, y] = this.ruutu(p.lat, p.lon);
        if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
        const al = jalkiAlfa(nyt - p.t1), r = Math.max(6, Math.min(14, 5 + Math.sqrt(p.kestoS / 60) * 1.5));
        g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI);
        g.fillStyle = `rgba(${JALKI_VARI.join(',')},${(al * 0.35).toFixed(2)})`; g.fill();
        g.lineWidth = 2; g.strokeStyle = `rgba(${JALKI_VARI.join(',')},${al.toFixed(2)})`;
        if (p.katko) g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]);
        if (this.z >= 14) {
          g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillStyle = `rgba(80,0,30,${Math.max(0.5, al).toFixed(2)})`; g.fillText(Math.round(p.kestoS / 60) + '′', x, y);
        }
        if (this.valittu && this.valittu.laji === 'pysahdys' && this.valittu.kohde === p) {
          g.beginPath(); g.arc(x, y, r + 5, 0, 2 * Math.PI); g.strokeStyle = '#000'; g.lineWidth = 2; g.stroke();
        }
      }
      g.restore();
    }
    /** Jääkerroksen lähde valitulle ajalle: jääkartta (havaintoihin perustuva) ±36 h sen päivästä, muuten malli. */
    jaaLahde() {
      const K = this.jaaKartta;
      if (K && K.paksuus_cm && K.aika && Math.abs(Date.parse(K.aika + 'T12:00:00Z') - this.aika) <= 36 * 3600e3) return 'kartta';
      const J = this.jaaMalli;
      return J && J.lat && J.muuttujat ? 'malli' : null;
    }
    _jaaKerros() {
      const lahde = this.jaaLahde(); if (!lahde) return;
      let J, P, C;
      if (lahde === 'kartta') {
        J = this.jaaKartta; C = null;
        P = J.paksuus_cm.map(r => r.map(v => (v == null || v <= 0) ? null : v));
      } else {
        J = this.jaaMalli;
        const i = lahinAika(J.ajat, this.aika); if (i < 0) return;
        P = J.muuttujat.paksuus_cm ? J.muuttujat.paksuus_cm.arvot[i] : null; C = J.muuttujat.peitto_pct ? J.muuttujat.peitto_pct.arvot[i] : null;
      }
      const dlat = Math.abs(J.lat[1] - J.lat[0]) || 1 / 60, dlon = Math.abs(J.lon[1] - J.lon[0]) || 1 / 36, g = this.g, A = this.nakyvaAlue();
      for (let y = 0; y < J.lat.length; y++) {
        if (J.lat[y] + dlat < A.lat_min || J.lat[y] - dlat > A.lat_max) continue;
        for (let x = 0; x < J.lon.length; x++) {
          if (J.lon[x] + dlon < A.lon_min || J.lon[x] - dlon > A.lon_max) continue;
          const p = P ? P[y][x] : null, c = C ? C[y][x] : null;
          if (p == null && c == null) continue;
          const vari = jaaVari(p, c); if (!vari) continue;
          // reunat pyöristetään samoihin pikseleihin naapurin kanssa: ei päällekkäisiä läpikuultavia saumoja
          const [ax, ay] = this.ruutu(J.lat[y] + dlat / 2, J.lon[x] - dlon / 2), [bx, by] = this.ruutu(J.lat[y] - dlat / 2, J.lon[x] + dlon / 2);
          const x0 = Math.round(ax), y0 = Math.round(Math.min(ay, by)), x1 = Math.round(bx), y1 = Math.round(Math.max(ay, by));
          if (x1 <= x0 || y1 <= y0) continue;
          g.fillStyle = vari; g.fillRect(x0, y0, x1 - x0, y1 - y0);
          if (this.z >= 12 && p != null && x1 - x0 > 34) {
            g.fillStyle = 'rgba(10,30,70,0.85)'; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText(String(p), (x0 + x1) / 2, (y0 + y1) / 2);
          }
        }
      }
    }
    _jarviSyvyys() {
      if (!this.jarvet.length || typeof document === 'undefined') return;
      const g = this.g, A = this.nakyvaAlue();
      for (const P of this.jarvet) {
        if (P.latEtela > A.lat_max || P.pohjoisLat < A.lat_min || P.lonIta < A.lon_min || P.lansiLon > A.lon_max) continue;
        if (!P.kuva) {
          const c = document.createElement('canvas'); c.width = P.W; c.height = P.H;
          const x = c.getContext('2d'), im = x.createImageData(P.W, P.H);
          for (let q = 0; q < P.W * P.H; q++) {
            const l = P.luokka[q]; if (!P.maski[q] || l >= P.luokkaM.length) continue;
            const h = JARVI_VARIT[Math.min(l, JARVI_VARIT.length - 1)];
            im.data[4 * q] = parseInt(h.slice(1, 3), 16); im.data[4 * q + 1] = parseInt(h.slice(3, 5), 16); im.data[4 * q + 2] = parseInt(h.slice(5, 7), 16); im.data[4 * q + 3] = 255;
          }
          x.putImageData(im, 0, 0); P.kuva = c;
        }
        const [x0, y0] = this.ruutu(P.pohjoisLat, P.lansiLon), [x1, y1] = this.ruutu(P.latEtela, P.lonIta);
        g.save(); g.globalAlpha = 0.6; g.imageSmoothingEnabled = false; g.drawImage(P.kuva, x0, y0, x1 - x0, y1 - y0); g.restore();
      }
    }
    leveysKm() { return this.w / this.skaala() * 360 * 111.32 * Math.cos(this.lat * Math.PI / 180); }
    merkitNakyvissa() { return this.vaylat.some(V => V.merkit.length) && this.leveysKm() <= 5.5; }
    _pohjaKerros() {
      const V = this.vesi, L = V && V.lampo; if (!L || !L.pohja || !V.lat) return;
      const paiva = new Date(this.aika).toISOString().slice(0, 10);
      let i = L.ajat.indexOf(paiva); if (i < 0) i = lahinAika(L.ajat, this.aika); if (i < 0) return;
      const P = L.pohja[i], dlat = Math.abs(V.lat[1] - V.lat[0]) || 1 / 60, dlon = Math.abs(V.lon[1] - V.lon[0]) || 1 / 36, g = this.g, A = this.nakyvaAlue();
      g.save(); g.font = '700 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let y = 0; y < V.lat.length; y++) {
        if (V.lat[y] + dlat < A.lat_min || V.lat[y] - dlat > A.lat_max) continue;
        for (let x = 0; x < V.lon.length; x++) {
          const t = P[y][x]; if (t == null) continue;
          if (V.lon[x] + dlon < A.lon_min || V.lon[x] - dlon > A.lon_max) continue;
          const [ax, ay] = this.ruutu(V.lat[y] + dlat / 2, V.lon[x] - dlon / 2), [bx, by] = this.ruutu(V.lat[y] - dlat / 2, V.lon[x] + dlon / 2);
          const x0 = Math.round(ax), y0 = Math.round(Math.min(ay, by)), x1 = Math.round(bx), y1 = Math.round(Math.max(ay, by));
          if (x1 <= x0 || y1 <= y0) continue;
          g.fillStyle = lampoVari(t / 10, 0.45); g.fillRect(x0, y0, x1 - x0, y1 - y0);
          if (x1 - x0 > 36 && y1 - y0 > 18) {
            const txt = (t / 10).toFixed(1).replace('.', ',');
            g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.strokeText(txt, (x0 + x1) / 2, (y0 + y1) / 2);
            g.fillStyle = '#0a1f4d'; g.fillText(txt, (x0 + x1) / 2, (y0 + y1) / 2);
          }
        }
      }
      g.restore();
    }
    _vaylat() {
      if (!this.vaylat.length || this.z < 9) return;
      const g = this.g, A = this.nakyvaAlue(), nakyy = v => !(v.la1 < A.lat_min || v.la0 > A.lat_max || v.lo1 < A.lon_min || v.lo0 > A.lon_max);
      const viiva = v => { const m = v.m; for (let i = 0; i < m.length; i += 2) { const [x, y] = this.ruutuM(m[i], m[i + 1]); i ? g.lineTo(x, y) : g.moveTo(x, y); } };
      g.save(); g.lineJoin = 'round';
      g.strokeStyle = 'rgba(120,60,0,0.75)'; g.lineWidth = 1.2; g.setLineDash([4, 4]);
      g.beginPath(); for (const V of this.vaylat) for (const v of V.alueet) if (nakyy(v)) viiva(v); g.stroke();
      g.strokeStyle = 'rgba(10,30,70,0.6)'; g.lineWidth = 4.5; g.setLineDash([]);
      g.beginPath(); for (const V of this.vaylat) for (const v of V.linjat) if (nakyy(v)) viiva(v); g.stroke();
      g.strokeStyle = '#ffd166'; g.lineWidth = 2; g.setLineDash([10, 6]);
      g.beginPath(); for (const V of this.vaylat) for (const v of V.linjat) if (nakyy(v)) viiva(v); g.stroke();
      g.setLineDash([]);
      if (this.z >= 12) {   // mitoitussyväys numerona lähempää
        const nahty = new Set(); g.font = '700 11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
        for (const V of this.vaylat) for (const v of V.linjat.concat(V.alueet)) {
          if (v.s == null || !nakyy(v)) continue;
          const i = (v.m.length >> 2) * 2, [x, y] = this.ruutuM(v.m[i], v.m[i + 1]);
          if (x < 10 || y < 10 || x > this.w - 50 || y > this.h - 10) continue;
          const txt = String(v.s).replace('.', ',') + ' m', avain = Math.round(x / 60) + ',' + Math.round(y / 30);
          if (nahty.has(avain)) continue; nahty.add(avain);
          g.lineWidth = 3; g.strokeStyle = 'rgba(10,30,70,0.85)'; g.strokeText(txt, x + 4, y - 6); g.fillStyle = '#ffd166'; g.fillText(txt, x + 4, y - 6);
        }
      }
      g.restore();
    }
    _turvalaitteet() {
      const g = this.g;
      g.save(); g.lineJoin = 'round';
      const raidat = (x, y, w, h, varit) => { g.strokeStyle = 'rgba(233,241,247,0.9)'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
        const n = varit.length; varit.forEach((c, i) => { g.fillStyle = c; g.fillRect(x, y + i * h / n, w, h / n + 0.5); }); };
      const kolmio = (x, y, ylos, k = 4) => { g.beginPath(); if (ylos) { g.moveTo(x, y - k); g.lineTo(x + k, y + k * 0.6); g.lineTo(x - k, y + k * 0.6); } else { g.moveTo(x, y + k); g.lineTo(x + k, y - k * 0.6); g.lineTo(x - k, y - k * 0.6); } g.closePath();
        g.strokeStyle = 'rgba(233,241,247,0.9)'; g.lineWidth = 1.6; g.stroke(); g.fillStyle = '#111'; g.fill(); };
      for (const V of this.vaylat) for (const m of V.merkit) {
        const [x, y] = this.ruutu(m.p[0], m.p[1]);
        if (x < -20 || x > this.w + 20 || y < -20 || y > this.h + 20) continue;
        const ty = merkkiTyyli(m);
        if (ty.valo) { g.fillStyle = 'rgba(255,214,0,0.35)'; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill(); }
        if (ty.muoto === 'kardinaali') {
          raidat(x - 3.5, y - 6, 7, 12, ty.varit || [MK, MY]);
          const yt = y - 12;
          if (ty.huippu === 'N') { kolmio(x, yt - 5, true); kolmio(x, yt + 2, true); }
          else if (ty.huippu === 'S') { kolmio(x, yt - 5, false); kolmio(x, yt + 2, false); }
          else if (ty.huippu === 'E') { kolmio(x, yt - 5, true); kolmio(x, yt + 3, false); }
          else { kolmio(x, yt - 4, false); kolmio(x, yt + 3, true); }
        } else if (ty.muoto === 'lateraali') {
          g.fillStyle = ty.varit[0]; g.strokeStyle = '#000'; g.lineWidth = 1; g.beginPath();
          if (ty.huippu === 'vasen') g.rect(x - 4, y - 7, 8, 13); else { g.moveTo(x, y - 9); g.lineTo(x + 5, y + 6); g.lineTo(x - 5, y + 6); g.closePath(); }
          g.fill(); g.stroke();
        } else if (ty.muoto === 'kummeli') {
          g.fillStyle = MW; g.strokeStyle = '#000'; g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 6, y + 5); g.lineTo(x - 6, y + 5); g.closePath(); g.fill(); g.stroke();
        } else if (ty.muoto === 'linja') raidat(x - 3, y - 8, 6, 14, ty.varit);
        else if (ty.muoto === 'loisto') {
          g.fillStyle = MY; g.strokeStyle = '#000'; g.lineWidth = 1; g.beginPath();
          for (let i = 0; i < 10; i++) { const r = i % 2 ? 3 : 7.5, k = -Math.PI / 2 + i * Math.PI / 5; g.lineTo(x + r * Math.cos(k), y + r * Math.sin(k)); }
          g.closePath(); g.fill(); g.stroke();
        } else if (ty.muoto === 'vlm') { g.fillStyle = MW; g.strokeStyle = MP; g.lineWidth = 2; g.fillRect(x - 4, y - 4, 8, 8); g.strokeRect(x - 4, y - 4, 8, 8); }
        else raidat(x - 3, y - 5, 6, 10, ty.varit);
      }
      g.restore();
    }
    /** Omat salmet: lahden reuna (valittuna), salmen viiva, keskellä nuoli virran suuntaan ja arvo. */
    _salmet() {
      if (!this.salmet.length) return;
      const g = this.g, valittu = this.valittu && this.valittu.laji === 'salmi' ? this.valittu.kohde : null;
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
      for (const s of this.salmet) {
        if (!s.a || !s.b) continue;
        if (s === valittu && s.lahti && s.lahti.length >= 3) {
          g.beginPath(); s.lahti.forEach((p, i) => { const [x, y] = this.ruutu(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath();
          g.fillStyle = 'rgba(79,195,247,0.12)'; g.fill(); g.setLineDash([6, 5]); g.strokeStyle = '#4fc3f7'; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
        }
        const [ax, ay] = this.ruutu(s.a[0], s.a[1]), [bx, by] = this.ruutu(s.b[0], s.b[1]);
        if (Math.max(ax, bx) < -60 || Math.min(ax, bx) > this.w + 60 || Math.max(ay, by) < -60 || Math.min(ay, by) > this.h + 60) continue;
        for (const [lev, c] of [[6, 'rgba(10,30,70,0.85)'], [3, s === valittu ? '#ffc928' : '#ffffff']]) {
          g.strokeStyle = c; g.lineWidth = lev; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        }
        const x = (ax + bx) / 2, y = (ay + by) / 2, r = this.salmiVirtaFn ? this.salmiVirtaFn(s) : null;
        let teksti = s.nimi || 'salmi';
        if (r && !r.umpi && r.v != null) {
          const cm = r.v * 100, vari = cm < 5 ? '#4fd3ff' : cm < 15 ? '#ffc928' : '#ff4081', pit = Math.max(20, Math.min(46, 18 + cm * 1.4));
          this._nuoli(x, y, r.suunta, pit, 'rgba(10,30,70,0.85)', 7);
          this._nuoli(x, y, r.suunta, pit, vari, 3.5);
          teksti += ' ' + (cm < 10 ? cm.toFixed(1).replace('.', ',') : Math.round(cm)) + ' cm/s';
        } else if (r && r.umpi) teksti += ' – jäässä pohjaan';
        if (this.z >= 11) {
          g.font = '800 12px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
          g.lineWidth = 3.5; g.strokeStyle = 'rgba(10,30,70,0.9)'; g.strokeText(teksti, x + 16, y + 14);
          g.fillStyle = '#ffffff'; g.fillText(teksti, x + 16, y + 14);
        }
      }
      g.restore();
    }
    /** Salmen piirto kesken: pisteet A, B ja lahden kulmat. */
    _luonnos() {
      const L = this.salmiLuonnos; if (!L) return;
      const g = this.g;
      g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
      if (L.lahti && L.lahti.length) {
        g.beginPath(); L.lahti.forEach((p, i) => { const [x, y] = this.ruutu(p[0], p[1]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        if (L.lahti.length >= 3) { g.closePath(); g.fillStyle = 'rgba(79,195,247,0.18)'; g.fill(); }
        g.setLineDash([6, 5]); g.strokeStyle = '#4fc3f7'; g.lineWidth = 2.5; g.stroke(); g.setLineDash([]);
        for (const p of L.lahti) { const [x, y] = this.ruutu(p[0], p[1]); g.beginPath(); g.arc(x, y, 5, 0, 2 * Math.PI); g.fillStyle = '#4fc3f7'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
      }
      const pisteet = [L.a, L.b].filter(Boolean);
      if (pisteet.length === 2) {
        const [ax, ay] = this.ruutu(L.a[0], L.a[1]), [bx, by] = this.ruutu(L.b[0], L.b[1]);
        g.strokeStyle = 'rgba(10,30,70,0.85)'; g.lineWidth = 6; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        g.strokeStyle = '#ffc928'; g.lineWidth = 3; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      }
      for (const p of pisteet) { const [x, y] = this.ruutu(p[0], p[1]); g.beginPath(); g.arc(x, y, 7, 0, 2 * Math.PI); g.fillStyle = '#ffc928'; g.fill(); g.strokeStyle = '#0a1f4d'; g.lineWidth = 2; g.stroke(); }
      g.restore();
    }
    _nuoli(x, y, suuntaAste, pituus, vari, leveys) {
      const g = this.g, a = suuntaAste * Math.PI / 180, dx = Math.sin(a) * pituus, dy = -Math.cos(a) * pituus;
      const x0 = x - dx / 2, y0 = y - dy / 2, x1 = x + dx / 2, y1 = y + dy / 2, k = Math.min(7, pituus * 0.45);
      g.strokeStyle = vari; g.fillStyle = vari; g.lineWidth = leveys || 2; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - k * Math.sin(a - 0.45), y1 + k * Math.cos(a - 0.45));
      g.lineTo(x1 - k * Math.sin(a + 0.45), y1 + k * Math.cos(a + 0.45)); g.closePath(); g.fill();
    }
    _virtaKerros() {
      const V = this.vesi && this.vesi.virta; if (!V || this.z < 8) return;
      const i = lahinAika(V.ajat, this.aika); if (i < 0) return;
      const t = Math.min(this.virtaTaso, V.u.length - 1), U = V.u[t][i], W = V.v[t][i];
      const g = this.g, varatut = new Set();
      g.save();
      for (let y = 0; y < V.lat.length; y++) for (let x = 0; x < V.lon.length; x++) {
        const u = U[y][x], v = W[y][x]; if (u == null || v == null) continue;
        const nop = Math.hypot(u, v); if (nop < 0.5) continue;
        const [sx, sy] = this.ruutu(V.lat[y], V.lon[x]);
        if (sx < -20 || sy < -20 || sx > this.w + 20 || sy > this.h + 20) continue;
        const avain = Math.round(sx / 34) + ',' + Math.round(sy / 34); if (varatut.has(avain)) continue; varatut.add(avain);
        const suunta = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360, pit = Math.max(10, Math.min(34, 8 + nop * 3));
        this._nuoli(sx, sy, suunta, pit, 'rgba(10,30,70,0.55)', 4);
        this._nuoli(sx, sy, suunta, pit, nop >= 10 ? '#ff4081' : nop >= 5 ? '#ffc928' : '#4fd3ff', 2.2);
      }
      g.restore();
    }
    _tuuliKerros() {
      const S = this.saa; if (!S) return;
      const g = this.g;
      for (const p of S) {
        if (!p.ajat) continue;
        let i = -1, pd = Infinity;
        p.ajat.forEach((a, k) => { const d = Math.abs(Date.parse(a) - this.aika); if (d < pd) { pd = d; i = k; } });
        if (i < 0 || pd > 2 * 3600e3 || p.wd[i] == null || p.ws[i] == null) continue;
        const [x, y] = this.ruutu(p.lat_lahde, p.lon_lahde);
        if (x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) continue;
        const pit = Math.max(18, Math.min(48, 12 + p.ws[i] * 3));
        this._nuoli(x, y, (p.wd[i] + 180) % 360, pit, 'rgba(10,30,70,0.6)', 6);
        this._nuoli(x, y, (p.wd[i] + 180) % 360, pit, '#ffffff', 3);
        g.save(); g.font = '800 12px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
        const txt = Math.round(p.ws[i]) + (p.wg[i] != null ? '/' + Math.round(p.wg[i]) : '') + ' m/s';
        g.lineWidth = 3; g.strokeStyle = 'rgba(10,30,70,0.85)'; g.strokeText(txt, x + 14, y + 16);
        g.fillStyle = '#ffffff'; g.fillText(txt, x + 14, y + 16); g.restore();
      }
    }
    _reiat() {
      const g = this.g, nyt = Date.now();
      for (const r of this.reiat) {
        const [x, y] = this.ruutu(r.lat, r.lon);
        if (x < -30 || y < -30 || x > this.w + 30 || y > this.h + 30) continue;
        const yv = saalisYhteenveto(r.saaliit), pl = paalaji(yv), M = pl ? (MERKIT[pl] || MERKIT.muu) : null;
        const al = Math.max(0.45, jalkiAlfa((nyt - reikaViimeisin(r)) / 1000));
        g.save(); g.globalAlpha = al;
        if (r.id === this.aktiivinenId) {
          g.beginPath(); g.arc(x, y, 17, 0, 2 * Math.PI); g.lineWidth = 4; g.strokeStyle = '#ffc928'; g.stroke();
        }
        g.beginPath(); g.arc(x, y, 12, 0, 2 * Math.PI);
        g.fillStyle = M ? M.vari : '#ffffff'; g.fill();
        g.lineWidth = 2.5; g.strokeStyle = M ? '#ffc928' : '#0a2150'; g.stroke();
        g.fillStyle = M ? '#ffffff' : '#0a2150'; g.font = '700 10px system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(syvTeksti(r.syvyys_m), x, y + 0.5);
        const n = (r.saaliit || []).length;
        if (n) {
          g.beginPath(); g.arc(x + 11, y - 11, 7.5, 0, 2 * Math.PI); g.fillStyle = '#ffc928'; g.fill();
          g.lineWidth = 1.5; g.strokeStyle = '#0a2150'; g.stroke();
          g.fillStyle = '#0a2150'; g.font = '800 9px system-ui, sans-serif'; g.fillText(n > 9 ? '9+' : String(n), x + 11, y - 10.5);
        }
        if (this.valittu && this.valittu.laji === 'reika' && this.valittu.kohde === r) {
          g.beginPath(); g.arc(x, y, 21, 0, 2 * Math.PI); g.lineWidth = 2; g.strokeStyle = '#000'; g.stroke();
        }
        g.restore();
      }
    }
    piirraMerkki(g, merkki, x, y, r) {
      const M = MERKIT[merkki] || MERKIT.muu;
      g.save();
      g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI);
      g.fillStyle = M.kirjain ? M.vari : 'rgba(255,255,255,0.95)'; g.fill();
      g.lineWidth = 2; g.strokeStyle = M.kirjain ? '#fff' : M.vari; g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (M.kirjain) { g.fillStyle = '#fff'; g.font = `700 ${Math.round(r * 1.1)}px system-ui, sans-serif`; g.fillText(M.kirjain, x, y + 0.5); }
      else { g.font = `${Math.round(r * 1.15)}px system-ui, "Noto Color Emoji", sans-serif`; g.fillStyle = M.vari; g.fillText(M.merkki, x, y + 1); }
      g.restore();
    }
    _pisteet() {
      const g = this.g;
      for (const p of this.pisteet) {
        const [x, y] = this.ruutu(p.lat, p.lon);
        if (x < -40 || y < -40 || x > this.w + 40 || y > this.h + 40) continue;
        const valittu = this.valittu && this.valittu.laji === 'piste' && this.valittu.kohde === p;
        this.piirraMerkki(g, p.merkki, x, y, valittu ? 15 : 12);
        if (p.nimi && this.z >= 12) {
          g.save(); g.font = '600 12px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
          g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.strokeText(p.nimi, x + 16, y);
          g.fillStyle = '#10222e'; g.fillText(p.nimi, x + 16, y); g.restore();
        }
      }
    }
    _leiri() {
      if (!this.leiri || this.leiri.lat == null) return;
      const [x, y] = this.ruutu(this.leiri.lat, this.leiri.lon);
      this.piirraMerkki(this.g, 'leiri', x, y, 13);
    }
    _gps() {
      if (!this.gps) return;
      const g = this.g, [x, y] = this.ruutu(this.gps.lat, this.gps.lon);
      const rm = (this.gps.tarkkuus || 0) / (40075016.7 * Math.cos(this.gps.lat * Math.PI / 180)) * this.skaala();
      g.save();
      if (rm > 8) { g.beginPath(); g.arc(x, y, rm, 0, 2 * Math.PI); g.fillStyle = 'rgba(25,118,210,0.12)'; g.fill(); }
      g.beginPath(); g.arc(x, y, 8, 0, 2 * Math.PI); g.fillStyle = '#1976d2'; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
      g.restore();
    }
    /** Lähin kohde ruudun pisteestä: piste (26 px) ennen pysähdystä (22 px). */
    osuma(x, y) {
      let paras = null;
      for (const p of this.pisteet) {
        const [px, py] = this.ruutu(p.lat, p.lon), d = Math.hypot(px - x, py - y);
        if (d <= 26 && (!paras || d < paras.d)) paras = { laji: 'piste', kohde: p, d };
      }
      if (paras) return paras;
      for (const r of this.reiat) {
        const [px, py] = this.ruutu(r.lat, r.lon), d = Math.hypot(px - x, py - y);
        if (d <= 24 && (!paras || d < paras.d)) paras = { laji: 'reika', kohde: r, d };
      }
      if (paras) return paras;
      for (const s of this.salmet) {
        if (!s.a || !s.b) continue;
        const [ax, ay] = this.ruutu(s.a[0], s.a[1]), [bx, by] = this.ruutu(s.b[0], s.b[1]);
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
        const d = Math.min(Math.hypot(ax + t * dx - x, ay + t * dy - y), Math.hypot((ax + bx) / 2 - x, (ay + by) / 2 - y) - 6);
        if (d <= 22 && (!paras || d < paras.d)) paras = { laji: 'salmi', kohde: s, d };
      }
      if (paras) return paras;
      if (this.kerrokset.vaylat && this.merkitNakyvissa()) for (const V of this.vaylat) for (const m of V.merkit) {
        const [px, py] = this.ruutu(m.p[0], m.p[1]), d = Math.hypot(px - x, py - (y + 4));
        if (d <= 18 && (!paras || d < paras.d)) paras = { laji: 'merkki', kohde: m, d };
      }
      if (paras) return paras;
      for (const p of this.pysahdykset) {
        const [px, py] = this.ruutu(p.lat, p.lon), d = Math.hypot(px - x, py - y);
        if (d <= 22 && (!paras || d < paras.d)) paras = { laji: 'pysahdys', kohde: p, d };
      }
      return paras;
    }
    // ------------------------------------------------------------ eleet: veto, nipistys, kaksoisnapautus, pitkä painallus
    _kiinnita() {
      const c = this.c;
      c.style.touchAction = 'none';
      const paikka = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      c.addEventListener('pointerdown', e => {
        c.setPointerCapture && c.setPointerCapture(e.pointerId);
        const [x, y] = paikka(e);
        this._osoittimet.set(e.pointerId, { x, y, x0: x, y0: y, t0: Date.now() });
        if (this._osoittimet.size === 1) {
          clearTimeout(this._pitka);
          this._pitka = setTimeout(() => {
            const o = this._osoittimet.get(e.pointerId);
            if (o && !this.vainNapautus && this._osoittimet.size === 1 && Math.hypot(o.x - o.x0, o.y - o.y0) < 10) {
              o.kaytetty = true;
              const [la, lo] = this.latLon(o.x, o.y);
              if (this.onLongPress) this.onLongPress(la, lo);
            }
          }, 650);
        } else clearTimeout(this._pitka);
        if (this._osoittimet.size === 2) {
          const [a, b] = [...this._osoittimet.values()];
          this._nipistys = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        }
      });
      c.addEventListener('pointermove', e => {
        const o = this._osoittimet.get(e.pointerId); if (!o) return;
        const [x, y] = paikka(e);
        if (this._osoittimet.size === 1) {
          const dx = x - o.x, dy = y - o.y;
          if (Math.hypot(x - o.x0, y - o.y0) > 6) { clearTimeout(this._pitka); this.seuraa = false; }
          const s = this.skaala();
          this.lon = mLon(mx(this.lon) - dx / s); this.lat = mLat(my(this.lat) - dy / s);
          o.x = x; o.y = y; this._muuttui();
        } else if (this._osoittimet.size === 2 && this._nipistys) {
          o.x = x; o.y = y;
          const [a, b] = [...this._osoittimet.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > 10 && this._nipistys.d > 10) { this.zoomaa(d / this._nipistys.d, (a.x + b.x) / 2, (a.y + b.y) / 2); this._nipistys.d = d; }
          this.seuraa = false;
        }
      });
      const loppu = e => {
        const o = this._osoittimet.get(e.pointerId);
        this._osoittimet.delete(e.pointerId);
        if (this._osoittimet.size < 2) this._nipistys = null;
        clearTimeout(this._pitka);
        if (!o || o.kaytetty || e.type === 'pointercancel') return;
        if (Math.hypot(o.x - o.x0, o.y - o.y0) < 10 && Date.now() - o.t0 < 500 && this._osoittimet.size === 0) {
          if (this.vainNapautus) { if (this.onTap) this.onTap(null, ...this.latLon(o.x, o.y)); return; }   // piirtotila: ei kaksoisnapautusta
          const nyt = Date.now();
          if (this._edNapautus && nyt - this._edNapautus.t < 300 && Math.hypot(this._edNapautus.x - o.x, this._edNapautus.y - o.y) < 30) {
            clearTimeout(this._napautusAjastin); this._edNapautus = null; this.zoomaa(2, o.x, o.y); return;
          }
          this._edNapautus = { t: nyt, x: o.x, y: o.y };
          this._napautusAjastin = setTimeout(() => {
            this._edNapautus = null;
            const os = this.osuma(o.x, o.y);
            this.valittu = os; this.piirra();
            if (this.onTap) this.onTap(os, ...this.latLon(o.x, o.y));
          }, 300);
        }
      };
      c.addEventListener('pointerup', loppu);
      c.addEventListener('pointercancel', loppu);
      c.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = paikka(e); this.zoomaa(e.deltaY < 0 ? 1.25 : 0.8, x, y); }, { passive: false });
      c.addEventListener('contextmenu', e => e.preventDefault());
    }
  }

  // ------------------------------------------------------------ virtaviivat: hiukkaset mallin virtauskentässä (havainnollistus)
  /** Hiukkaset liikkuvat näytöllä nopeudella ~4 px/s per cm/s (ei mittakaavassa). Erillinen läpinäkyvä canvas kartan päällä. */
  class VirtaAnimaatio {
    constructor(kartta, canvas) {
      this.k = kartta; this.c = canvas; this.g = canvas.getContext('2d'); this.h = []; this.kaynnissa = false;
      this.pxPerCms = 4; this.ed = 0; this.nakyma = '';
    }
    kentat() {
      const K = this.k, V = K.vesi && K.vesi.virta; if (!V || !V.u || !V.u.length) return null;
      const i = lahinAika(V.ajat, K.aika), t = Math.min(K.virtaTaso || 0, V.u.length - 1);
      return i < 0 ? null : { lat: V.lat, lon: V.lon, U: V.u[t][i], W: V.v[t][i] };
    }
    koko() {
      const K = this.k; this.dpr = K.dpr || 1;
      this.c.width = Math.round(K.w * this.dpr); this.c.height = Math.round(K.h * this.dpr);
      this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    uusi() { const [la, lo] = this.k.latLon(Math.random() * this.k.w, Math.random() * this.k.h); return { la, lo, ika: Math.floor(Math.random() * 90) }; }
    kaynnista() {
      if (this.kaynnissa) return;
      this.kaynnissa = true; this.koko(); this.h = [];
      const kierros = t => {
        if (!this.kaynnissa) return;
        if (t - this.ed >= 33) { this.askel(Math.min(0.1, (t - this.ed) / 1000 || 0.033)); this.ed = t; }
        this._raf = requestAnimationFrame(kierros);
      };
      this._raf = requestAnimationFrame(kierros);
    }
    pysayta() { this.kaynnissa = false; if (this._raf) cancelAnimationFrame(this._raf); this.g.clearRect(0, 0, this.c.width, this.c.height); this.h = []; }
    askel(dt) {
      const K = this.k, F = this.kentat(), g = this.g;
      if (this.c.width !== Math.round(K.w * (K.dpr || 1)) || this.c.height !== Math.round(K.h * (K.dpr || 1))) this.koko();
      const nakyma = K.lat.toFixed(6) + ',' + K.lon.toFixed(6) + ',' + K.z.toFixed(3) + ',' + K.aika + ',' + K.virtaTaso;
      if (nakyma !== this.nakyma) { g.clearRect(0, 0, K.w, K.h); this.nakyma = nakyma; }
      else { g.globalCompositeOperation = 'destination-in'; g.fillStyle = 'rgba(0,0,0,0.92)'; g.fillRect(0, 0, K.w, K.h); g.globalCompositeOperation = 'source-over'; }
      if (!F || K.z < 8) return;
      const n = Math.min(700, Math.round(K.w * K.h / 700));
      while (this.h.length < n) this.h.push(this.uusi());
      this.h.length = n;
      g.lineWidth = 1.6; g.lineCap = 'round';
      for (const p of this.h) {
        const v = kentta(F.lat, F.lon, F.U, F.W, p.la, p.lo);
        const [x, y] = K.ruutu(p.la, p.lo);
        if (!v || ++p.ika > 160 || x < -5 || y < -5 || x > K.w + 5 || y > K.h + 5) { Object.assign(p, this.uusi(), { ika: 0 }); continue; }
        const nop = Math.hypot(v[0], v[1]); if (nop < 0.2) { p.ika += 3; continue; }
        const px = Math.min(60, nop * this.pxPerCms) * dt, x2 = x + v[0] / nop * px, y2 = y - v[1] / nop * px;
        g.strokeStyle = nop >= 10 ? 'rgba(255,64,129,0.9)' : nop >= 5 ? 'rgba(255,201,40,0.9)' : 'rgba(79,211,255,0.85)';
        g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        [p.la, p.lo] = K.latLon(x2, y2);
      }
    }
  }

  const PilkkiKartta = { TILE, mx, my, mLat, mLon, etaisyysM, JALKI, jalkiLisaa, jalkiAlfa, jalkiOsat, PYSAHDYS, pysahdykset,
    puraSyvyys, MERKIT, REIKA, LAJIT, reikaViimeisin, aktiivinenReika, saalisYhteenveto, paalaji, lajiTeksti, yhteenvetoTeksti,
    lajienSyvyydet, syvTeksti, jaaVari, JAA_SELITE, lahinAika, puraVaylat, lahinVayla, merkkiTyyli, merkkiKuvaus, lampoVari,
    LAMPO_ASTEIKKO, kayratJanalla, kentta, VirtaAnimaatio, luokkaRajat, puraJarvi, jarviSyvyys, JARVI_VARIT, Kartta };
  if (typeof module !== 'undefined' && module.exports) module.exports = PilkkiKartta;
  else root.PilkkiKartta = PilkkiKartta;
})(typeof window !== 'undefined' ? window : this);
