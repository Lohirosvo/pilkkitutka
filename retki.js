/* Pilkkitutka – retki.js v011 (28.11.2026): Hannun välineet oletuksena, kuomukärry, reitin vaarat.
 * Hannu 24.11.2026: "Liitä pilkkitutkaan niin että käyttää sääennustetta hyväksi vähän paremmin kuin gemini"
 * (Geminin "Pilkkilogistiikka Pro 3.1").
 * Geminiltä pidetty: kulkuvälineet, kuorma, purkuaika, nopeuden hidastuminen lumessa ja sohjossa, jumiutumisrajat,
 *   pysäköintietäisyys (kokemussääntö [O]), auto + jarruton kärry -kulut [O].
 * Muutettu: jään vaatimus kulkuvälineen massasta FMI:n taulukolla [T] (Geminin kiinteät rajat ja meri ×1,25 pois);
 *   sää ennusteesta meno- ja paluumatkan kellonajoille: hyytävyys kulkunopeudella ja reitin suunnalla, puuskat,
 *   uusi lumi ja vesisade paluulle (nopeus, jumiutuminen, kohva), pimeys; lähtöikkuna 48 h.
 * Pois: keksityt karkotusprosentit ja 0–100-pisteet. Sovellus ei koskaan sano, että jää on turvallinen.
 */
(function (root) {
  'use strict';
  const RAD = Math.PI / 180;

  // Ilmatieteen laitos, "Driving on ice" (lähde Työturvallisuuskeskus): tehollinen jään paksuus -> suurin sallittu ajoneuvon massa [T]
  const FMI_KANTAVUUS = [[20, 2000], [25, 3000], [30, 4500], [40, 7000], [50, 12000], [60, 17000], [70, 23000], [80, 31000], [90, 39000], [100, 48000]];
  const GOLD_A = 5.0;      // kg/cm²: taulukon 20 cm / 2,0 t -> alle 2 t:n massoille h = √(m/A) (Goldin kaava) [L]
  const JALAN_MIN_CM = 5;  // SUH: 5 cm virheetöntä teräsjäätä kantaa yksin kulkevan [T]
  // FMI:n pakkasvaroitus (lämpötila tai pakkasen purevuus), Keski-Suomi: keltainen −25, oranssi −35, punainen −40 °C [T]
  const HYY_TASOT = [-25, -35, -40];
  const RANTA_KMH = 20, RANTA_KM = 0.3;   // FMI: rannan lähellä alle 20 km/h [T]; vyöhykkeen leveys [O]
  const KAVELY_KMH = 3.8;                 // Gemini [O]

  /** Vaadittu tehollinen jää (cm) kokonaismassalle (kg). */
  function vaadittuJaa(massaKg) {
    if (!(massaKg > 0)) return 0;
    if (massaKg <= FMI_KANTAVUUS[0][1]) return Math.max(JALAN_MIN_CM, Math.sqrt(massaKg / GOLD_A));
    for (let i = 1; i < FMI_KANTAVUUS.length; i++) {
      const [h0, m0] = FMI_KANTAVUUS[i - 1], [h1, m1] = FMI_KANTAVUUS[i];
      if (massaKg <= m1) return h0 + (h1 - h0) * (massaKg - m0) / (m1 - m0);
    }
    return null;
  }
  /** FMI: teräsjää kokonaan, jäähän kiinni jäätynyt tumma kohvajää puolella, valkoinen kohvajää ei lainkaan [T]. */
  const tehollinenJaa = (terasCm, tummaCm) => (terasCm || 0) + 0.5 * (tummaCm || 0);

  // Kulkuvälineet. Nopeudet, hidasteet, kapasiteetti, purku, ääni: Gemini [O]. Massat (kulkija + varusteet mukana) [O],
  // paitsi Sportsman 570:n kuivapaino 332 kg (Polariksen käyttöohje) [T].
  // Hannu 28.11.2026: "Oikeasti käytössä: rapala nastakengät, potkuri, ahkio. Sähköpyörä nastoilla ahkio" -> oletuksena nämä kolme.
  const VALINEET = [
    { id: 'jalka', nimi: 'Nastakengät + ahkio', nopeus: 4.0, lumi: 0.08, sohjo: 0.14, kap: 2, purku: 3, aani: 15, lh: 0, massa: 140, jumiLumi: 35 },
    { id: 'potkuri', nimi: 'Potkukelkka (+ ahkio)', nopeus: 11.5, lumi: 0.45, sohjo: 0.65, kap: 2, purku: 4, aani: 28, lh: 0, massa: 160, jumiLumi: 14, jumiSohjo: 6 },
    { id: 'pyora', nimi: 'Sähköpyörä nastoilla + ahkio', nopeus: 15, lumi: 0.35, sohjo: 0.55, kap: 2, purku: 6, aani: 25, lh: 0, massa: 170, jumiLumi: 18, jumiSohjo: 8 },
    { id: 'lumikengat', nimi: 'Lumikengät / metsäsukset', nopeus: 5.2, lumi: 0.02, sohjo: 0.09, kap: 1, purku: 5, aani: 12, lh: 0, massa: 140 },
    { id: 'monkija', nimi: 'Mönkijä (Sportsman 570, nastat)', nopeus: 35, lumi: 0.14, sohjo: 0.38, kap: 3, purku: 12, aani: 130, lh: 3.2, massa: 530, jumiSohjo: 20, moottori: true },
    { id: 'telamonkija', nimi: 'Telamönkijä (telasarja)', nopeus: 24, lumi: 0.03, sohjo: 0.08, kap: 3, purku: 14, aani: 155, lh: 5.0, massa: 600, moottori: true },
    { id: 'kelkka_kevyt', nimi: 'Kevyt ilmajäähd. kelkka', nopeus: 38, lumi: 0.04, sohjo: 0.07, kap: 2, purku: 10, aani: 145, lh: 4.5, massa: 380, moottori: true },
    { id: 'kelkka_iso', nimi: 'Iso nelitahtikelkka', nopeus: 48, lumi: 0.03, sohjo: 0.10, kap: 3, purku: 12, aani: 120, lh: 4.2, massa: 600, moottori: true, lumiJaahdytys: true },
  ];
  const OLETUS_KAYTOSSA = ['jalka', 'potkuri', 'pyora'];
  const KUORMA = { kevyt: 1, keski: 2, raskas: 3 };
  const LAJI = { ahven: 1.35, siika: 1.45, kuha: 1.0, hauki: 0.65 };        // Gemini [O]
  const SYVYYS = { 2: 1.45, 5: 1.0, 12: 0.72 };                            // Gemini [O]

  // ------------------------------------------------------------ sää
  /** Pakkasen purevuus (JAG/TI, Osczevski & Bluestein 2005; FMI:n purevuusindeksin kaava), tuuli 10 m:ssä m/s. */
  function hyytavyys(T, v10) {
    const v = v10 * 3.6;
    if (T == null || T > 10 || v < 4.8) return T;
    const p = Math.pow(v, 0.16);
    return 13.12 + 0.6215 * T - 11.37 * p + 0.3965 * T * p;
  }
  /** Kulkijan kokema tuuli 10 m:n tuulta vastaavana (m/s): tuuli kasvoilla ≈ 2/3 · 10 m tuuli (kaavan oletus), siitä
   *  vähennetään kulkijan nopeusvektori, ja tulos muunnetaan takaisin 10 m:n vastaavaksi (× 1,5) [L]. */
  function kulkuTuuli(ws, wdMista, suuntaMihin, kmh) {
    const wf = (ws || 0) * 2 / 3, a = ((wdMista || 0) + 180) * RAD, b = (suuntaMihin || 0) * RAD, v = (kmh || 0) / 3.6;
    return 1.5 * Math.hypot(wf * Math.sin(a) - v * Math.sin(b), wf * Math.cos(a) - v * Math.cos(b));
  }
  const hyyTaso = w => w == null ? 0 : w <= HYY_TASOT[2] ? 3 : w <= HYY_TASOT[1] ? 2 : w <= HYY_TASOT[0] ? 1 : 0;
  /** Ennusteen arvot hetkellä t (lähin tunti): { T, ws, wg, wd, sade } tai null, jos t on ennusteen ulkopuolella. */
  function saaAjalla(S, t) {
    if (!S || !S.ajat || !S.ajat.length) return null;
    const ms = S._ms || (S._ms = S.ajat.map(a => Date.parse(a)));
    if (t < ms[0] - 3600e3 || t > ms[ms.length - 1] + 3600e3) return null;
    let i = 0; for (let k = 1; k < ms.length; k++) if (Math.abs(ms[k] - t) < Math.abs(ms[i] - t)) i = k;
    const v = k => S[k] ? S[k][i] : null;
    return { t: ms[i], T: v('T'), ws: v('ws'), wg: v('wg'), wd: v('wd'), sade: v('sade') };
  }
  /** Sade väliltä [t0, t1] tunneittain: lumi (cm, T ≤ 0,5 °C, 1 mm ≈ 1 cm [O]) ja vesi (mm). */
  function sadeValilla(S, t0, t1) {
    let lumiCm = 0, vesiMm = 0, mm = 0, n = 0;
    if (!S || !S.ajat) return { lumiCm, vesiMm, mm, n };
    const ms = S._ms || (S._ms = S.ajat.map(a => Date.parse(a)));
    for (let i = 0; i < ms.length; i++) {
      if (ms[i] <= t0 || ms[i] > t1 + 1) continue;
      const s = S.sade && S.sade[i], T = S.T && S.T[i]; n++;
      if (!(s > 0)) continue;
      mm += s;
      if (T != null && T <= 0.5) lumiCm += s; else vesiMm += s;
    }
    return { lumiCm, vesiMm, mm, n };
  }
  /** Suuntakulma a -> b (astetta, 0 = pohjoinen). */
  function suunta(a, b) {
    const f1 = a.lat * RAD, f2 = b.lat * RAD, dl = (b.lon - a.lon) * RAD;
    return (Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) / RAD + 360) % 360;
  }
  const ILMANSUUNNAT = ['pohjoisesta', 'koillisesta', 'idästä', 'kaakosta', 'etelästä', 'lounaasta', 'lännestä', 'luoteesta'];
  const mista = wd => ILMANSUUNNAT[Math.round(((wd % 360) + 360) % 360 / 45) % 8];

  // ------------------------------------------------------------ kulkuväline
  function nopeus(v, lumi, sohjo) {
    let s = v.nopeus;
    s *= 1 - Math.min(0.88, lumi * v.lumi * 0.12);
    s *= 1 - Math.min(0.92, sohjo * v.sohjo * 0.18);
    if (v.id === 'lumikengat' && lumi <= 0) s *= 0.7;
    return Math.max(1.2, s);
  }
  function jumi(v, lumi, sohjo) {
    if (v.jumiLumi != null && lumi > v.jumiLumi) return `uppoaa lumeen (yli ${v.jumiLumi} cm)`;
    if (v.jumiSohjo != null && sohjo > v.jumiSohjo) return `uppoaa sohjoon (yli ${v.jumiSohjo} cm)`;
    return '';
  }
  /** Pysäköintietäisyys moottorilla: Geminin kokemussääntö [O], pyöristetty 50 m:iin. Ei prosentteja. */
  function pysakointi(v, o) {
    if (!v.moottori) return 0;
    const lumiV = o.lumi <= 0 ? 1.65 : Math.max(0.55, 1.25 - o.lumi * 0.025);
    const tuuliV = Math.max(0.7, 1.15 - (o.ws || 0) * 0.025);
    const m = v.aani * lumiV * (SYVYYS[o.syvyys] || 1) * (LAJI[o.laji] || 1) * tuuliV;
    return Math.max(50, Math.round(m / 50) * 50);
  }
  /** Matka-aika (min) välineellä: rantavyöhykkeet enintään 20 km/h, loppu kävellen pysäköinnistä. */
  function matkaMin(v, km, s, pysM) {
    const kav = Math.min(km, pysM / 1000), ajo = Math.max(0, km - kav);
    const ranta = v.moottori ? Math.min(ajo, 2 * RANTA_KM) : 0, rantaS = Math.min(s, RANTA_KMH);
    return (ranta / rantaS + (ajo - ranta) / s + kav / KAVELY_KMH) * 60;
  }

  /**
   * Arvio yhdelle välineelle.
   * o: { km, suunta (lähtö -> kohde), jaaCm (tehollinen), lumi, sohjo, kohvaRaja (cm lunta, jolla vesi nousee), kuorma,
   *      laji, syvyys, lahtoMs, tunnit (pyynnissä), saa (ennuste), aurinko(t0, t1) -> [{alku, loppu}] pimeät jaksot, massa (ohitus),
   *      auto: { km, kulutus, hinta, ev }, bensa }
   */
  function arvioi(v, o) {
    const massa = (o.massat && o.massat[v.id]) || v.massa, vaad = vaadittuJaa(massa);
    const jaa = o.jaaCm;
    const jaaTila = jaa == null ? 'tuntematon' : vaad == null || jaa < vaad ? 'ei' : jaa < vaad * 1.2 ? 'niukka' : 'täyttyy';
    const kapOk = v.kap >= (KUORMA[o.kuorma] || 2);
    const S = o.saa;
    // meno
    const sMeno = saaAjalla(S, o.lahtoMs);
    const pys = pysakointi(v, { lumi: o.lumi, ws: sMeno ? sMeno.ws : 0, syvyys: o.syvyys, laji: o.laji });
    const nMeno = nopeus(v, o.lumi, o.sohjo), jumiMeno = jumi(v, o.lumi, o.sohjo);
    const menoMin = v.purku + matkaMin(v, o.km, nMeno, pys);
    const menoAlku = o.lahtoMs, menoLoppu = o.lahtoMs + menoMin * 60e3;
    // paluu: uusi lumi ja vesisade pyynnin aikana
    const paluuAlku = menoLoppu + (o.tunnit || 0) * 3600e3;
    const sade = sadeValilla(S, menoAlku, paluuAlku);
    const lumiPaluu = o.lumi + sade.lumiCm;
    const sohjoPaluu = o.sohjo + (sade.vesiMm >= 2 ? Math.min(10, sade.vesiMm * 0.5) : 0);   // [O] vesisade kastelee lumen
    const nPaluu = nopeus(v, lumiPaluu, sohjoPaluu), jumiPaluu = jumi(v, lumiPaluu, sohjoPaluu);
    const paluuMin = v.purku + matkaMin(v, o.km, nPaluu, pys);
    const paluuLoppu = paluuAlku + paluuMin * 60e3;
    const sPaluu = saaAjalla(S, paluuAlku + paluuMin * 30e3);
    // hyytävyys kulkiessa (ajonopeudella), menossa kohteen suuntaan, paluussa vastakkaiseen
    // suunta tuntematon (pelkkä etäisyys) -> pahin tapaus: vastatuuleen molempiin suuntiin
    const hyy = (s, kmh, sn) => s && s.T != null ? hyytavyys(s.T, kulkuTuuli(s.ws, s.wd, sn == null ? s.wd : sn, kmh)) : null;
    const hyyMeno = hyy(sMeno, nMeno, o.suunta), hyyPaluu = hyy(sPaluu, nPaluu, o.suunta == null ? null : (o.suunta + 180) % 360);
    const hyyPaikalla = (() => { let w = null; const t1 = paluuAlku; for (let t = menoLoppu; t <= t1; t += 3600e3) { const s = saaAjalla(S, t); if (s && s.T != null) { const x = hyytavyys(s.T, s.ws || 0); if (w == null || x < w) w = x; } } return w; })();
    const puuska = Math.max(sMeno && sMeno.wg || 0, sPaluu && sPaluu.wg || 0);
    const pimeat = o.aurinko ? o.aurinko(menoAlku, paluuLoppu) : [];
    const pimeaPaluu = pimeat.some(p => p.loppu > paluuAlku && p.alku < paluuLoppu);
    const pimeaMeno = pimeat.some(p => p.loppu > menoAlku && p.alku < menoLoppu);
    // huomiot
    const huom = [];
    if (jumiMeno) huom.push({ taso: 3, teksti: 'menossa ' + jumiMeno });
    else if (jumiPaluu) huom.push({ taso: 3, teksti: `paluulla ${jumiPaluu} (ennusteen ${fmt(sade.lumiCm)} cm uutta lunta)` });
    if (v.lumiJaahdytys && o.lumi < 3) huom.push({ taso: 1, teksti: 'nestejäähdytys tarvitsee lunta (alle 3 cm)' });
    const lt = Math.max(hyyTaso(hyyMeno), hyyTaso(hyyPaluu));
    if (lt) huom.push({ taso: lt, teksti: `pakkasen purevuus kulkiessa ${fmt(Math.min(hyyMeno ?? 99, hyyPaluu ?? 99))} °C (FMI:n ${['', 'keltainen', 'oranssi', 'punainen'][lt]} taso)` });
    if (puuska >= 15) huom.push({ taso: 2, teksti: `puuskat ${fmt(puuska)} m/s: lumi pöllyää, näkyvyys ja suunta voivat kadota` });
    else if (puuska >= 11 && (sade.lumiCm > 0.5 || o.lumi > 2) && (sPaluu && sPaluu.T != null && sPaluu.T < -1)) huom.push({ taso: 1, teksti: `puuskat ${fmt(puuska)} m/s irtolumella: näkyvyys voi heikentyä` });
    if (sade.lumiCm >= 1) huom.push({ taso: sade.lumiCm >= 5 ? 2 : 1, teksti: `pyynnin aikana ${fmt(sade.lumiCm)} cm uutta lunta` + (paluuMin - menoMin >= 1 ? ` → paluu ${fmt(paluuMin - menoMin)} min hitaampi` : '') });
    if (sade.vesiMm >= 1) huom.push({ taso: 2, teksti: `vesi- tai räntäsadetta ${fmt(sade.vesiMm, 1)} mm: lumi kastuu, sohjoa paluulla` });
    if (o.kohvaRaja != null && lumiPaluu > o.kohvaRaja && o.lumi <= o.kohvaRaja) huom.push({ taso: 2, teksti: `uusi lumi painaa jään: lunta ${fmt(lumiPaluu)} cm > kohvaraja ${fmt(o.kohvaRaja)} cm → vettä lumen alle paluulla` });
    else if (o.kohvaRaja != null && o.lumi > o.kohvaRaja) huom.push({ taso: 2, teksti: `lunta jo yli kohvarajan (${fmt(o.kohvaRaja)} cm): vettä lumen alla` });
    if (pimeaMeno || pimeaPaluu) huom.push({ taso: 1, teksti: (pimeaMeno && pimeaPaluu ? 'meno ja paluu' : pimeaMeno ? 'meno' : 'paluu') + ' pimeässä: railot ja avovesi näkyvät huonosti' });
    if (sMeno == null || sPaluu == null) huom.push({ taso: 1, teksti: 'ennuste ei ulotu koko retkelle' });
    const haitta = Math.max(0, ...huom.map(h => h.taso));
    // kulut (Gemini [O])
    let kulut = null;
    if (o.auto) {
      // peräkärry valitaan retkelle (Hannu: kuomuperäkärry, lava 3500 mm) -> Geminin "raskas" lisä [O]
      const A = o.auto, kerroin = A.karry === 'kuomu' ? (A.ev ? 1.48 : 1.35) : 1;
      const tie = (A.km / 100) * A.kulutus * A.hinta, tieKarry = tie * kerroin;
      const jaalla = (2 * o.km / Math.max(1.2, (nMeno + nPaluu) / 2)) * v.lh * (o.bensa || 1.85);
      kulut = { yht: tieKarry + jaalla, karry: tieKarry - tie, jaalla };
    }
    const etenema60 = (() => {
      const vapaa = 60 - v.purku; if (vapaa <= 0) return 0;
      const kav = pys / 1000, kavMin = kav / KAVELY_KMH * 60;
      return vapaa <= kavMin ? vapaa / 60 * KAVELY_KMH : kav + (vapaa - kavMin) / 60 * nMeno;
    })();
    return { v, massa, vaad, vaadHalkeama: vaad != null ? vaad * Math.SQRT2 : null, jaaTila, kapOk, pys, nMeno, nPaluu, menoMin, paluuMin,
      menoAlku, menoLoppu, paluuAlku, paluuLoppu, sMeno, sPaluu, hyyMeno, hyyPaluu, hyyPaikalla, sade, lumiPaluu, sohjoPaluu,
      jumi: jumiMeno || jumiPaluu, puuska, pimeaMeno, pimeaPaluu, huom, haitta, kulut, etenema60 };
  }
  const fmt = (x, d = 0) => x == null || !isFinite(x) ? '–' : (Math.round(x * 10 ** d) / 10 ** d).toFixed(d).replace('.', ',').replace('-', '−');

  /** Kelpaavat (jää täyttyy tai niukka, ei jumia, kapasiteetti riittää) nopeimmasta; muut perään. */
  function jarjesta(tulokset) {
    const kelpaa = r => (r.jaaTila === 'täyttyy' || r.jaaTila === 'niukka') && !r.jumi && r.kapOk;
    return tulokset.slice().sort((a, b) => (kelpaa(b) - kelpaa(a)) || (a.jaaTila === 'niukka') - (b.jaaTila === 'niukka') || (a.menoMin + a.paluuMin) - (b.menoMin + b.paluuMin));
  }
  const kelpaa = r => (r.jaaTila === 'täyttyy' || r.jaaTila === 'niukka') && !r.jumi && r.kapOk;
  /** Lähtöikkuna: haitta (0–3) jokaiselle tasatunnille [alkuMs, loppuMs], kun paluu mahtuu ennusteeseen. */
  function lahtoikkuna(v, o, alkuMs, loppuMs) {
    const out = [];
    for (let t = Math.ceil(alkuMs / 3600e3) * 3600e3; t <= loppuMs; t += 3600e3) {
      const r = arvioi(v, Object.assign({}, o, { lahtoMs: t }));
      const ok = r.sMeno && r.sPaluu;
      out.push({ t, haitta: ok ? r.haitta : null, syy: ok ? r.huom.filter(h => h.taso === r.haitta).map(h => h.teksti)[0] || '' : 'ei ennustetta' });
    }
    return out;
  }

  // ------------------------------------------------------------ reitti ja tunnetut vaarat
  /** Linnuntiereitin a -> b ja vaara-alueiden (reuna [[lat, lon], ...]) välinen etäisyys metreinä (0 = kulkee läpi),
   *  omat vaarapisteet ympyröinä (säde m) ja salmien ylitykset. -> [{ laji, nimi, d, kohde }] etäisyysjärjestyksessä. */
  function reittiVaarat(a, b, alueet, pisteet, salmet, maxM) {
    maxM = maxM == null ? 300 : maxM;
    const lat0 = (a.lat + b.lat) / 2, kx = 111320 * Math.cos(lat0 * RAD), ky = 111320;
    const T = (la, lo) => [(lo - a.lon) * kx, (la - a.lat) * ky], A = [0, 0], B = T(b.lat, b.lon);
    const ristiin = (p, q, r, s) => {
      const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]); if (d === 0) return false;
      const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d, u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
      return t >= 0 && t <= 1 && u >= 0 && u <= 1;
    };
    const pj = (p, q, r) => { const dx = r[0] - q[0], dy = r[1] - q[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / L)) : 0;
      return Math.hypot(q[0] + t * dx - p[0], q[1] + t * dy - p[1]); };
    const sisalla = (p, poly) => { let s = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) s = !s; } return s; };
    const out = [];
    for (const al of alueet || []) {
      const poly = al.reuna.map(([la, lo]) => T(la, lo));
      let d = Infinity;
      if (sisalla(A, poly) || sisalla(B, poly)) d = 0;
      for (let i = 0; i < poly.length && d > 0; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        if (ristiin(A, B, p, q)) d = 0;
        else d = Math.min(d, pj(p, A, B), pj(A, p, q), pj(B, p, q));
      }
      if (d <= maxM) out.push({ laji: 'alue', nimi: al.nimi, d, kohde: al, alussa: sisalla(A, poly), lopussa: sisalla(B, poly) });
    }
    for (const p of pisteet || []) {
      const d = Math.max(0, pj(T(p.lat, p.lon), A, B) - (p.sade || 100));
      if (d <= maxM) out.push({ laji: 'piste', nimi: p.nimi || 'oma vaarapiste', d, kohde: p });
    }
    for (const s of salmet || []) if (s.a && s.b && ristiin(A, B, T(s.a[0], s.a[1]), T(s.b[0], s.b[1]))) out.push({ laji: 'salmi', nimi: s.nimi || 'salmi', d: 0, kohde: s });
    return out.sort((x, y) => x.d - y.d);
  }

  const PilkkiRetki = { OLETUS_KAYTOSSA, reittiVaarat, FMI_KANTAVUUS, GOLD_A, JALAN_MIN_CM, HYY_TASOT, VALINEET, KUORMA, LAJI, vaadittuJaa, tehollinenJaa, hyytavyys, kulkuTuuli,
    hyyTaso, saaAjalla, sadeValilla, suunta, mista, nopeus, jumi, pysakointi, matkaMin, arvioi, jarjesta, kelpaa, lahtoikkuna, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = PilkkiRetki;
  else root.PilkkiRetki = PilkkiRetki;
})(typeof window !== 'undefined' ? window : this);
