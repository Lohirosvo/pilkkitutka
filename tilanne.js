/* Pilkkitutka – tilanne.js v005 (23.11.2026)
 * v005: omat salmet – leveys, lahden ala, suunta lahteen ja virran nopeus jatkuvuusyhtälöstä; virtauskentän interpolointi.
 * Puhtaat laskentafunktiot tilannekuvaan (testattavissa Nodessa):
 *  - auringon korkeus ja hämärät [L: USNO:n likikaava, tarkkuus noin 0,5°]
 *  - valo jään alla [L + O: kertoimet valittu mitattujen vaihteluvälien sisältä, ks. VALO]
 *  - vedenkorkeuden muutosnopeus ja sen virtaustulkinta salmissa [L: periaate; suuruus riippuu salmesta, ei laskettavissa]
 *  - mallin virtaus ja lämpö pisteessä
 */
(function (root) {
  'use strict';
  const RAD = Math.PI / 180;

  // ------------------------------------------------------------ aurinko
  function auringonKorkeus(lat, lon, ms) {
    const d = ms / 864e5 + 2440587.5 - 2451545.0;                    // vrk J2000:sta
    const g = ((357.529 + 0.98560028 * d) % 360) * RAD;               // keskianomalia
    const q = (280.459 + 0.98564736 * d) % 360;                       // keskipituus
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const e = (23.439 - 0.00000036 * d) * RAD;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const H = (gmst * 15 + lon) * RAD - ra;
    return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(H)) / RAD;
  }
  /** Tapahtumat välillä: nousu/lasku (−0,833°), siviilihämärän alku/loppu (−6°). Askel 2 min. */
  function aurinkoTapahtumat(lat, lon, alkuMs, loppuMs) {
    const out = [], askel = 120e3;
    let ed = auringonKorkeus(lat, lon, alkuMs);
    for (let t = alkuMs + askel; t <= loppuMs; t += askel) {
      const h = auringonKorkeus(lat, lon, t);
      const yli = raja => ed < raja && h >= raja, ali = raja => ed >= raja && h < raja;
      const tarkka = raja => t - askel + askel * (raja - ed) / (h - ed);
      if (yli(-6)) out.push({ t: tarkka(-6), laji: 'aamuhamara' });
      if (yli(-0.833)) out.push({ t: tarkka(-0.833), laji: 'nousu' });
      if (ali(-0.833)) out.push({ t: tarkka(-0.833), laji: 'lasku' });
      if (ali(-6)) out.push({ t: tarkka(-6), laji: 'iltahamara' });
      ed = h;
    }
    return out;
  }
  /** Valoluokka: 'yo' (< −6°), 'hamara' (−6…0°), 'paiva'. */
  function valoluokka(korkeus) { return korkeus < -6 ? 'yo' : korkeus < 0 ? 'hamara' : 'paiva'; }
  /** Hämäräikkunat [{alku, loppu, laji: 'aamu'|'ilta'}] tapahtumista. */
  function hamarat(tap) {
    const out = [];
    for (let i = 0; i < tap.length; i++) {
      const a = tap[i], b = tap[i + 1];
      if (a.laji === 'aamuhamara' && b && b.laji === 'nousu') out.push({ alku: a.t, loppu: b.t, laji: 'aamu' });
      if (a.laji === 'lasku' && b && b.laji === 'iltahamara') out.push({ alku: a.t, loppu: b.t, laji: 'ilta' });
    }
    return out;
  }

  // ------------------------------------------------------------ valo jään alla
  const VALO = {
    kLumi: 20,      // 1/m [O]; mitattu vaihtelu 3–80 1/m (0,03–0,8 cm⁻¹), Järvinen & Leppäranta [T]
    kJaa: 3,        // 1/m [L]: kirkkaan kidejään tunkeutumissyvyys ~35 cm (Perämeri, Baltic Sea Ice Climate Workshop 2005) [T];
                    //          huokoinen jää ~10 cm -> ~10 1/m
    albLumi: 0.8,   // [O]
    albJaa: 0.5,    // [O]; Santalanlahti PAR-albedo 0,28–0,76, läpäisy 1–52 % jää+lumi (Arst ym.) [T]
    lumiRaja: 3,    // cm: tätä ohuempi lumi -> jään heijastus [O]
  };
  function lapaisy(lumiCm, jaaCm, opts) {
    const o = Object.assign({}, VALO, opts || {});
    const lumi = Math.max(0, lumiCm || 0), jaa = Math.max(0, jaaCm || 0);
    const alb = lumi >= o.lumiRaja ? o.albLumi : o.albJaa;
    return (1 - alb) * Math.exp(-o.kLumi * lumi / 100) * Math.exp(-o.kJaa * jaa / 100);
  }

  // ------------------------------------------------------------ vedenkorkeus ja virtaus salmissa
  function interpoloi(sarja, t) {   // sarja [[ms, arvo]] aikajärjestyksessä
    if (!sarja || !sarja.length || t < sarja[0][0] || t > sarja[sarja.length - 1][0]) return null;
    for (let i = 1; i < sarja.length; i++) {
      if (sarja[i][0] >= t) {
        const [t0, a] = sarja[i - 1], [t1, b] = sarja[i];
        return t1 === t0 ? b : a + (b - a) * (t - t0) / (t1 - t0);
      }
    }
    return sarja[sarja.length - 1][1];
  }
  /** Muutosnopeus cm/h hetkestä t eteenpäin (ikkuna tunteina). */
  function vkMuutos(sarja, t, tunnit) {
    tunnit = tunnit || 3;
    const a = interpoloi(sarja, t), b = interpoloi(sarja, t + tunnit * 3600e3);
    return a == null || b == null ? null : (b - a) / tunnit;
  }
  /** Tulkinta: nousu täyttää lahtia -> virtaus salmissa sisäänpäin, lasku tyhjentää -> ulospäin [L periaate]. */
  function virtausTulkinta(cmH) {
    if (cmH == null) return null;
    const v = Math.abs(cmH);
    const voima = v < 0.3 ? 'heikko' : v < 1 ? 'kohtalainen' : v < 2 ? 'voimakas' : 'erittäin voimakas';
    const suunta = v < 0.3 ? 'ei selvää suuntaa' : cmH > 0 ? 'sisäänpäin lahtiin' : 'ulospäin merelle';
    return { voima, suunta, nousee: cmH > 0 };
  }

  // ------------------------------------------------------------ mallin arvot pisteessä
  function lahinRuutu(lat, lon, arvot, p, maxKm) {
    let paras = null;
    for (let y = 0; y < lat.length; y++) {
      if (Math.abs(lat[y] - p.lat) > 0.15) continue;
      for (let x = 0; x < lon.length; x++) {
        if (arvot && (arvot[y] == null || arvot[y][x] == null)) continue;
        const dy = (lat[y] - p.lat) * 111.32, dx = (lon[x] - p.lon) * 111.32 * Math.cos(p.lat * RAD), d = Math.hypot(dx, dy);
        if (!paras || d < paras.d) paras = { y, x, d };
      }
    }
    return paras && paras.d <= (maxKm || 8) ? paras : null;
  }
  const SUUNNAT = ['P', 'KO', 'I', 'KA', 'E', 'LO', 'L', 'LU'];
  /** Virtauksen nopeus (cm/s) ja suunta, johon vesi virtaa (astetta, 0 = pohjoiseen). */
  function virtausVektori(u, v) {
    if (u == null || v == null) return null;
    const nopeus = Math.hypot(u, v), suunta = (Math.atan2(u, v) / RAD + 360) % 360;
    return { nopeus, suunta, ilmansuunta: SUUNNAT[Math.round(suunta / 45) % 8] };
  }

  // ------------------------------------------------------------ omat salmet [L]
  const KX = lat => 111320 * Math.cos(lat * RAD), KY = 110574;
  function etaisyysM(a, b) { const la = (a[0] + b[0]) / 2; return Math.hypot((b[1] - a[1]) * KX(la), (b[0] - a[0]) * KY); }
  /** Monikulmion ala km² (paikallinen tasoprojektio; lahden kokoisilla alueilla virhe < 0,1 %). */
  function alaKm2(pisteet) {
    if (!pisteet || pisteet.length < 3) return 0;
    const la0 = pisteet.reduce((s, p) => s + p[0], 0) / pisteet.length, kx = KX(la0);
    let s2 = 0;
    for (let i = 0; i < pisteet.length; i++) {
      const p = pisteet[i], q = pisteet[(i + 1) % pisteet.length];
      s2 += (p[1] * kx) * (q[0] * KY) - (q[1] * kx) * (p[0] * KY);
    }
    return Math.abs(s2) / 2 / 1e6;
  }
  /** Salmi { a, b, lahti } -> { leveysM, alaKm2, keski, sisaanSuunta (astetta, kohti lahtea) }. */
  function salmiGeometria(s) {
    if (!s || !s.a || !s.b) return null;
    const keski = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], kx = KX(keski[0]);
    const dx = (s.b[1] - s.a[1]) * kx, dy = (s.b[0] - s.a[0]) * KY;
    let nx = -dy, ny = dx;                                         // normaali
    const L = s.lahti && s.lahti.length >= 3 ? s.lahti : null;
    if (L) {
      const c = [L.reduce((t, p) => t + p[0], 0) / L.length, L.reduce((t, p) => t + p[1], 0) / L.length];
      if (nx * (c[1] - keski[1]) * kx + ny * (c[0] - keski[0]) * KY < 0) { nx = -nx; ny = -ny; }
    }
    return { leveysM: Math.hypot(dx, dy), alaKm2: L ? alaKm2(L) : 0, keski, sisaanSuunta: (Math.atan2(nx, ny) / RAD + 360) % 360 };
  }
  /** Virta salmessa: v = ala × dh/dt × osuus ÷ (leveys × (syvyys − jää)). cmH > 0 = vesi nousee = virtaa lahteen. */
  function salmiVirta(geom, syvyysM, osuusPct, cmH, jaaCm) {
    if (!geom || !(geom.leveysM > 0) || !(geom.alaKm2 > 0) || !(syvyysM > 0) || cmH == null || !isFinite(cmH)) return null;
    const vesisyv = syvyysM - Math.max(0, jaaCm || 0) / 100;
    if (vesisyv <= 0.05) return { umpi: true, vesisyv };
    const osuus = osuusPct > 0 ? Math.min(100, osuusPct) / 100 : 1;
    const q = geom.alaKm2 * 1e6 * Math.abs(cmH) / 100 / 3600 * osuus;
    return { q, v: q / (geom.leveysM * vesisyv), vesisyv, sisaan: cmH > 0,
      suunta: cmH > 0 ? geom.sisaanSuunta : (geom.sisaanSuunta + 180) % 360 };
  }
  /** Vedenkorkeuden muutosnopeus cm/h hetkellä t: mitattu ennen viimeistä mittausta, sen jälkeen ennuste. */
  function vkNopeusAjalla(hav, enn, t) {
    const viim = hav && hav.length ? hav[hav.length - 1][0] : -Infinity;
    const sarja = t <= viim ? hav : enn;
    if (!sarja || !sarja.length) return null;
    const a = interpoloi(sarja, t - 1.5 * 3600e3), b = interpoloi(sarja, t + 1.5 * 3600e3);
    if (a != null && b != null) return (b - a) / 3;
    const f = vkMuutos(sarja, t, 3); if (f != null) return f;
    return vkMuutos(sarja, t - 3 * 3600e3, 3);
  }

  // ------------------------------------------------------------ virtauskentän arvo pisteessä (bilineaarinen)
  /** lat/lon tasavälisinä nousevina tai laskevina; U, W [y][x] cm/s; null jos jokin kulma puuttuu. */
  function kenttaArvo(lat, lon, U, W, la, lo) {
    const n = lat.length, m = lon.length; if (n < 2 || m < 2) return null;
    const fy = (la - lat[0]) / (lat[n - 1] - lat[0]) * (n - 1), fx = (lo - lon[0]) / (lon[m - 1] - lon[0]) * (m - 1);
    if (!(fy >= 0 && fy <= n - 1 && fx >= 0 && fx <= m - 1)) return null;
    const y0 = Math.min(n - 2, Math.floor(fy)), x0 = Math.min(m - 2, Math.floor(fx)), ty = fy - y0, tx = fx - x0;
    const k = (A, y, x) => A[y] && A[y][x] != null ? A[y][x] : null;
    const u00 = k(U, y0, x0), u01 = k(U, y0, x0 + 1), u10 = k(U, y0 + 1, x0), u11 = k(U, y0 + 1, x0 + 1);
    const v00 = k(W, y0, x0), v01 = k(W, y0, x0 + 1), v10 = k(W, y0 + 1, x0), v11 = k(W, y0 + 1, x0 + 1);
    if ([u00, u01, u10, u11, v00, v01, v10, v11].some(x => x == null)) return null;
    const bl = (a, b, c, d) => (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    return [bl(u00, u01, u10, u11), bl(v00, v01, v10, v11)];
  }

  const PilkkiTilanne = { etaisyysM, alaKm2, salmiGeometria, salmiVirta, vkNopeusAjalla, kenttaArvo, auringonKorkeus, aurinkoTapahtumat, valoluokka, hamarat, VALO, lapaisy, interpoloi, vkMuutos,
    virtausTulkinta, lahinRuutu, virtausVektori, SUUNNAT };
  if (typeof module !== 'undefined' && module.exports) module.exports = PilkkiTilanne;
  else root.PilkkiTilanne = PilkkiTilanne;
})(typeof window !== 'undefined' ? window : this);
