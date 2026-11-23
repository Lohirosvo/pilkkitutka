/* Pilkkitutka – tilanne.js v004 (23.11.2026)
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

  const PilkkiTilanne = { auringonKorkeus, aurinkoTapahtumat, valoluokka, hamarat, VALO, lapaisy, interpoloi, vkMuutos,
    virtausTulkinta, lahinRuutu, virtausVektori, SUUNNAT };
  if (typeof module !== 'undefined' && module.exports) module.exports = PilkkiTilanne;
  else root.PilkkiTilanne = PilkkiTilanne;
})(typeof window !== 'undefined' ? window : this);
