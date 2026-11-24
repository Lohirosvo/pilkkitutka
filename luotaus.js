/* Pilkkitutka – luotaus.js v009 (24.11.2026)
 * Hannu 24.11.2026: "Lisää lowrance tallenteiden lisäys/lataus mahdollisuus tee käyrät pienualaisille pilkkipaikoille
 * .3 m käyrävälillä ja käytä vedenpinnan korkeuden korjausta." – "Anturi on vedenpinnan alla 25 cm riittävällä
 * tarkkuudella ja se pitää lisätä."
 *
 * Tiedostomuoto [T]: Navico Sonar Log File Format (memotech.franken.de, 2021-06-02) ja sllib (opensounder/python-sllib);
 * kenttäsijainnit tarkistettu viidellä näytetiedostolla (arabia example.sl2, sample-data-lowrance small.sl2,
 * southern1.sl2, format3_version2.sl3, sonar-log-api-testdata.sl3). Tiedosto alkaa 8 tavun otsakkeella
 * (u16 muoto: 2 = sl2, 3 = sl3), kehykset peräkkäin, kehyksen 1. kenttä = kehyksen oma sijainti tiedostossa.
 *   sl2: koko u16 @28, kanava u16 @32, luontiaika i32 @60, syvyys f32 jalkaa @64, itä i32 @108, pohjoinen i32 @112,
 *        liput u16 @132 (0x10 = sijainti kelvollinen), aikasiirtymä u32 ms @140; otsake 144 tavua.
 *   sl3: koko u16 @8, kanava u16 @12, luontiaika @40, syvyys @48, itä @92, pohjoinen @96, liput @116, aikasiirtymä @124.
 *   Sijainti: pallo-Mercator napasäteellä 6 356 752,3142 m. Kanava 0 = pääkaiku.
 * Luontiaika (POSIX) oli näytteissä oikea vain yhden sl3:n ensimmäisessä kehyksessä [T] -> päivä vahvistetaan aina.
 *
 * Kaikki tallenteet ja niistä tehdyt käyrät pysyvät puhelimessa (IndexedDB) – tämä tiedosto ei lähetä mitään minnekään.
 */
(function (root) {
  'use strict';
  const R = 6356752.3142, JALKA = 0.3048, RAD = 180 / Math.PI;
  const ANTURI_M = 0.25;            // Hannu 24.11.2026 [T käyttäjältä]
  const KAYRAVALI_M = 0.3;          // Hannu 24.11.2026
  const AIKA_MIN = Date.UTC(2005, 0, 1) / 1000;
  const lonE = e => e / R * RAD;
  const latN = n => (2 * Math.atan(Math.exp(n / R)) - Math.PI / 2) * RAD;

  // ------------------------------------------------------------ jäsennin (paloittain, iso tiedosto ei mahdu muistiin)
  function luoJasennin(asetus) {
    const A = Object.assign({ minVali: 0.5, maxAikaMs: 2000, nyt: Date.now() }, asetus || {});
    let muoto = 0, versio = 0, alku = 0, buf = new Uint8Array(0), pos = 0, loppui = false, virhe = null;
    let kehyksia = 0, resync = 0, etsitty = 0, alkuMs = null, alkuKehys = null, siirto = 0, etsii = false;
    const kanavat = {}, kerat = new Map();
    const keraa = ch => {
      let k = kerat.get(ch);
      if (!k) { k = { lat: [], lon: [], cm: [], t: [], ve: null, vn: null, vt: 0 }; kerat.set(ch, k); }
      return k;
    };
    function kehys(dv, o) {
      const s2 = muoto === 2, ch = dv.getUint16(o + (s2 ? 32 : 12), true);
      kanavat[ch] = (kanavat[ch] || 0) + 1;
      const t = dv.getUint32(o + (s2 ? 140 : 124), true);
      if (alkuMs === null && kehyksia < 100) {
        const luotu = dv.getInt32(o + (s2 ? 60 : 40), true);
        if (luotu >= AIKA_MIN && luotu * 1000 <= A.nyt + 2 * 864e5) { alkuMs = luotu * 1000 - t; alkuKehys = kehyksia; }
      }
      if (ch === 3 || ch === 4 || ch >= 10) return;            // sivukaiut ja debug: sama syvyys, ei tarvita
      if (!(dv.getUint16(o + (s2 ? 132 : 116), true) & 0x10)) return;
      const e = dv.getInt32(o + (s2 ? 108 : 92), true), n = dv.getInt32(o + (s2 ? 112 : 96), true);
      if (!e && !n) return;
      const syv = dv.getFloat32(o + (s2 ? 64 : 48), true) * JALKA;
      if (!(syv > 0.15 && syv < 300)) return;
      const k = keraa(ch);
      if (k.ve !== null && t >= k.vt) {
        const c = Math.cos(latN(n) / RAD);
        if (Math.hypot(e - k.ve, n - k.vn) * c < A.minVali && t - k.vt < A.maxAikaMs) return;   // harvennus: 0,5 m tai 2 s
      }
      k.ve = e; k.vn = n; k.vt = t;
      k.lat.push(Math.round(latN(n) * 1e6)); k.lon.push(Math.round(lonE(e) * 1e6)); k.cm.push(Math.round(syv * 100)); k.t.push(t);
    }
    function syota(pala) {
      if (loppui) return;
      const jaa = Math.min(buf.length, Math.max(0, pos - alku)), vanha = buf.subarray(jaa);
      const uusi = new Uint8Array(vanha.length + pala.length); uusi.set(vanha); uusi.set(pala, vanha.length);
      alku += jaa; buf = uusi;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (!muoto) {
        if (buf.length < 8) return;
        muoto = dv.getUint16(0, true); versio = dv.getUint16(2, true);
        if (muoto !== 2 && muoto !== 3) {
          loppui = true; virhe = muoto === 1 ? 'vanhaa slg-muotoa ei tueta (vain sl2 ja sl3)' : 'tiedosto ei ole Lowrancen sl2/sl3-tallenne';
          return;
        }
        pos = 8;
      }
      const H = muoto === 2 ? 144 : 128, KOKO = muoto === 2 ? 28 : 8;
      for (;;) {
        const o = pos - alku;
        if (o + H > buf.length) break;
        const koko = dv.getUint16(o + KOKO, true);
        if (etsii || dv.getUint32(o, true) !== ((pos - siirto) >>> 0) || koko < H) {
          // Tahdistus kadonnut (rikkinäinen kohta, puuttuvia tai ylimääräisiä tavuja): etsitään kohta, jonka 1. kenttä X ja
          // koko kk ketjuuntuvat seuraavaan kehykseen (sen 1. kenttä = X + kk). Ero X:n ja todellisen sijainnin välillä = siirto.
          let k = etsii ? 0 : 1, tila = 'ei', X = 0;
          for (; o + k + H <= buf.length; k++) {
            X = dv.getUint32(o + k, true); const kk = dv.getUint16(o + k + KOKO, true);
            if (kk < H) continue;
            if (o + k + kk + H > buf.length) { tila = 'odota'; break; }
            if (dv.getUint32(o + k + kk, true) === ((X + kk) >>> 0) && dv.getUint16(o + k + kk + KOKO, true) >= H) { tila = 'ok'; break; }
          }
          etsitty += k; pos += k;
          if (tila === 'ok') { siirto = pos - X; etsii = false; resync++; continue; }
          etsii = true;
          if (etsitty > 8 << 20) { loppui = true; virhe = 'tiedosto on rikki (kehyksiä ei löydy 8 Mt:n matkalla)'; }
          break;
        }
        kehys(dv, o); kehyksia++; pos += koko;
      }
    }
    function valmis() {
      let ch = kerat.has(0) && kerat.get(0).cm.length >= 10 ? 0 : null;
      if (ch === null) for (const [c, k] of kerat) if (ch === null || k.cm.length > kerat.get(ch).cm.length) ch = c;
      const perus = { muoto: muoto === 2 ? 'sl2' : muoto === 3 ? 'sl3' : null, versio, kehyksia, kanavat, resync, virhe };
      if (ch === null || !kerat.get(ch).cm.length) return Object.assign(perus, { virhe: virhe || 'tallenteessa ei ole sijainnillisia syvyyksiä' });
      const k = kerat.get(ch), n0 = k.cm.length;
      // piikit pois: |syvyys − 5 pisteen mediaani| > max(0,25 m, 10 %)
      const pois = new Uint8Array(n0), w = [];
      for (let i = 0; i < n0; i++) {
        w.length = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(n0 - 1, i + 2); j++) w.push(k.cm[j]);
        w.sort((a, b) => a - b);
        const med = w[w.length >> 1];
        if (Math.abs(k.cm[i] - med) > Math.max(25, 0.1 * med)) pois[i] = 1;
      }
      let n = 0; for (let i = 0; i < n0; i++) if (!pois[i]) n++;
      const lat = new Int32Array(n), lon = new Int32Array(n), cm = new Uint16Array(n), t = new Uint32Array(n);
      let la0 = 1e9, la1 = -1e9, lo0 = 1e9, lo1 = -1e9, tmin = Infinity, tmax = -Infinity;
      for (let i = 0, q = 0; i < n0; i++) {
        if (pois[i]) continue;
        lat[q] = k.lat[i]; lon[q] = k.lon[i]; cm[q] = k.cm[i]; t[q] = k.t[i];
        if (lat[q] < la0) la0 = lat[q]; if (lat[q] > la1) la1 = lat[q]; if (lon[q] < lo0) lo0 = lon[q]; if (lon[q] > lo1) lo1 = lon[q];
        if (t[q] < tmin) tmin = t[q]; if (t[q] > tmax) tmax = t[q];
        q++;
      }
      return Object.assign(perus, {
        kanava: ch, n, poistettu: n0 - n, alkuMs, alkuKehys, lat, lon, cm, t,
        bbox: { la0: la0 / 1e6, la1: la1 / 1e6, lo0: lo0 / 1e6, lo1: lo1 / 1e6 },
        tMin: tmin, kestoS: Math.round((tmax - tmin) / 1000),
      });
    }
    return { syota, valmis, loppui: () => loppui };
  }

  /** Lukee File/Blob-olion 4 Mt:n paloina. edistys(0..1). */
  async function lueTiedosto(tiedosto, edistys, asetus) {
    const J = luoJasennin(asetus), PALA = 4 << 20;
    for (let a = 0; a < tiedosto.size; a += PALA) {
      J.syota(new Uint8Array(await tiedosto.slice(a, a + PALA).arrayBuffer()));
      if (edistys) edistys(Math.min(1, (a + PALA) / tiedosto.size));
      if (J.loppui()) break;
      await new Promise(r => setTimeout(r, 0));
    }
    return J.valmis();
  }

  // ------------------------------------------------------------ vedenkorkeus
  /** Lineaarinen arvo sarjasta [[ms, cm], ...] (aikajärjestys); null, jos lähin havainto on yli maxMs päässä. */
  function sarjaArvo(S, t, maxMs) {
    if (!S || !S.length) return null;
    let i = 0; while (i < S.length && S[i][0] < t) i++;
    const a = S[i - 1], b = S[i];
    if (a && b) {
      if (Math.min(t - a[0], b[0] - t) > maxMs) return null;
      if (b[0] - a[0] > 2 * maxMs) return t - a[0] < b[0] - t ? a[1] : b[1];
      return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    }
    const c = a || b;
    return Math.abs(c[0] - t) <= maxMs ? c[1] : null;
  }
  /** Päiväsarjat [['YYYY-MM-DD', cm]] ja {alku, cm[]} yhdeksi [[ms (klo 12 UTC), cm]] -sarjaksi. */
  function paivaSarja(paivat, sarja) {
    const m = new Map();
    if (sarja && sarja.alku && Array.isArray(sarja.cm)) {
      const t0 = Date.parse(sarja.alku + 'T12:00:00Z');
      sarja.cm.forEach((v, i) => { if (v != null) m.set(t0 + i * 864e5, v); });
    }
    for (const [d, v] of paivat || []) if (v != null) m.set(Date.parse(d + 'T12:00:00Z'), v);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }
  /** FMI:n simple-muotoinen WFS-vastaus -> [{lat, lon, t, p, v}]. */
  function jasennaFmi(xml) {
    const out = [], re = /<BsWfs:BsWfsElement[\s\S]*?<\/BsWfs:BsWfsElement>/g;
    let m;
    while ((m = re.exec(xml))) {
      const e = m[0], pos = /<gml:pos>\s*([-\d.]+)\s+([-\d.]+)/.exec(e), t = /<BsWfs:Time>([^<]+)</.exec(e),
        p = /<BsWfs:ParameterName>([^<]+)</.exec(e), v = /<BsWfs:ParameterValue>([^<]+)</.exec(e);
      if (!pos || !t || !p || !v) continue;
      const arvo = parseFloat(v[1]);
      out.push({ lat: +pos[1], lon: +pos[2], t: Date.parse(t[1]), p: p[1], v: isFinite(arvo) ? arvo : null });
    }
    return out;
  }
  /** FMI-rivit -> lähimmän aseman N2000-sarja [[ms, cm]] (WLEVN2K_PT1S_INSTANT on millimetreinä). */
  function fmiAsemaSarja(rivit, lat, lon, maxKm) {
    let paras = null, pd = Infinity;
    for (const r of rivit) {
      const d = Math.hypot((r.lat - lat) * 111.32, (r.lon - lon) * 111.32 * Math.cos(lat / RAD));
      if (d < pd) { pd = d; paras = r; }
    }
    if (!paras || pd > (maxKm || 15)) return null;
    return rivit.filter(r => r.lat === paras.lat && r.lon === paras.lon && r.p === 'WLEVN2K_PT1S_INSTANT' && r.v != null && Math.abs(r.v) < 4000)
      .map(r => [r.t, Math.round(r.v) / 10]).sort((a, b) => a[0] - b[0]);
  }
  /** Syvyys nykyvedellä (m): luotain + anturi + (vesi nyt − vesi tallennettaessa). */
  function korjattu(syvM, wRecCm, wNytCm) {
    const k = wRecCm != null && wNytCm != null ? (wNytCm - wRecCm) / 100 : 0;
    return syvM + ANTURI_M + k;
  }

  // ------------------------------------------------------------ ruudukko ja käyrät pienelle alueelle (solu koko/150, väh. 1 m; IDW enintään 8 m luotauspisteestä)
  /** pisteet: [lat, lon, syvyys nykyvedellä m][]; neliö kokoM keskellä lat0/lon0. Solmuarvot IDW:llä enintään r m päästä. */
  function teeRuudukko(lat0, lon0, kokoM, pisteet, asetus) {
    const A = Object.assign({ minPisteita: 2 }, asetus || {});
    const s = Math.max(1, kokoM / 150), N = Math.ceil(kokoM / s), M = N + 1, r = A.sade || Math.max(8, 3 * s);   // [O] 8 m: 10–15 m linjaväli täyttyy, laajempia aukkoja ei
    const kx = 111320 * Math.cos(lat0 / RAD), ky = 111320, x0 = -N * s / 2, y0 = -N * s / 2;
    const lokero = new Map(), avain = (i, j) => i * 65536 + j;
    let kaytetty = 0;
    for (const [la, lo, z] of pisteet) {
      const x = (lo - lon0) * kx, y = (la - lat0) * ky;
      if (x < x0 - r || x > -x0 + r || y < y0 - r || y > -y0 + r || !isFinite(z)) continue;
      const k = avain(Math.floor((x - x0) / r) + 2, Math.floor((y - y0) / r) + 2);
      let l = lokero.get(k); if (!l) lokero.set(k, l = []);
      l.push(x, y, z); kaytetty++;
    }
    const Z0 = new Float32Array(M * M).fill(NaN);
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const px = x0 + i * s, py = y0 + j * s, bi = Math.floor((px - x0) / r) + 2, bj = Math.floor((py - y0) / r) + 2;
      let sw = 0, sz = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const l = lokero.get(avain(bi + di, bj + dj)); if (!l) continue;
        for (let q = 0; q < l.length; q += 3) {
          const d2 = (l[q] - px) ** 2 + (l[q + 1] - py) ** 2;
          if (d2 > r * r) continue;
          const w = 1 / (d2 + 0.25); sw += w; sz += w * l[q + 2]; n++;
        }
      }
      if (n >= A.minPisteita) Z0[j * M + i] = sz / sw;
    }
    // kevyt tasoitus (3×3 keskiarvo kelvollisista naapureista)
    const Z = new Float32Array(M * M).fill(NaN);
    let min = Infinity, max = -Infinity, kelv = 0;
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const v0 = Z0[j * M + i]; if (isNaN(v0)) continue;
      let s1 = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= M || jj >= M) continue;
        const v = Z0[jj * M + ii]; if (!isNaN(v)) { s1 += v; n++; }
      }
      const v = s1 / n; Z[j * M + i] = v; kelv++;
      if (v < min) min = v; if (v > max) max = v;
    }
    return { lat0, lon0, koko: kokoM, s, N, M, x0, y0, kx, ky, Z, pisteita: kaytetty, peitto: kelv / (M * M),
      min: kelv ? min : null, max: kelv ? max : null };
  }
  /** Solmun (i, j) lat/lon. */
  const solmuLL = (G, x, y) => [G.lat0 + (G.y0 + y * G.s) / G.ky, G.lon0 + (G.x0 + x * G.s) / G.kx];
  /** Marching squares -> [{ syvyys, viivat: [[[lat, lon], ...], ...] }] tasoilla k·vali. */
  function kayrat(G, vali) {
    vali = vali || KAYRAVALI_M;
    if (G.min == null) return [];
    const M = G.M, Z = G.Z, N = G.N, out = [];
    const TAULU = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]],
      11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]] };
    for (let k = Math.ceil(G.min / vali - 1e-9); k * vali <= G.max + 1e-9; k++) {
      const L = Math.round(k * vali * 100) / 100; if (L <= 0) continue;
      const seg = [], reunat = new Map();   // reuna-id -> [segmentti-indeksit]
      const piste = (id) => {             // reuna-id -> [x, y] ruudukkoyksiköissä
        const q = id >> 1, i = q % M, j = (q - i) / M, h = !(id & 1);
        const z1 = Z[j * M + i], z2 = h ? Z[j * M + i + 1] : Z[(j + 1) * M + i], t = (L - z1) / (z2 - z1);
        return h ? [i + t, j] : [i, j + t];
      };
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const a = Z[j * M + i], b = Z[j * M + i + 1], c = Z[(j + 1) * M + i + 1], d = Z[(j + 1) * M + i];
        if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) continue;
        const idx = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0);
        if (idx === 0 || idx === 15) continue;
        const e = [2 * (j * M + i), 2 * (j * M + i + 1) + 1, 2 * ((j + 1) * M + i), 2 * (j * M + i) + 1];   // ala, oikea, ylä, vasen
        let parit = TAULU[idx];
        if (idx === 5 || idx === 10) {
          const kesk = (a + b + c + d) / 4 > L;
          parit = idx === 5 ? (kesk ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]) : (kesk ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]]);
        }
        for (const [p, q] of parit) {
          const si = seg.length; seg.push([e[p], e[q]]);
          for (const id of [e[p], e[q]]) { const l = reunat.get(id); if (l) l.push(si); else reunat.set(id, [si]); }
        }
      }
      // ketjutus: avoimet päät ensin, sitten silmukat
      const kaytetty = new Uint8Array(seg.length), viivat = [];
      const ketju = (s0, alkuId) => {
        const ids = [alkuId]; let s = s0, id = alkuId;
        for (;;) {
          kaytetty[s] = 1; const [p, q] = seg[s]; id = p === id ? q : p; ids.push(id);
          const seur = (reunat.get(id) || []).find(x => !kaytetty[x]);
          if (seur === undefined) break; s = seur;
        }
        return ids;
      };
      for (const [id, l] of reunat) if (l.length === 1 && !kaytetty[l[0]]) viivat.push(ketju(l[0], id));
      for (let s = 0; s < seg.length; s++) if (!kaytetty[s]) viivat.push(ketju(s, seg[s][0]));
      out.push({ syvyys: L, viivat: viivat.filter(v => v.length >= 3).map(v => v.map(id => { const [x, y] = piste(id); return solmuLL(G, x, y); })) });
    }
    return out.filter(t => t.viivat.length);
  }
  /** Kartan syvyyskerroksen muoto (kartta.js puraSyvyys). mx/my = kartta.js:n Mercator-funktiot. */
  function kartalle(tasot, mx, my) {
    return {
      tasot: tasot.map(t => ({
        syvyys: t.syvyys,
        viivat: t.viivat.map(v => {
          const m = new Float64Array(v.length * 2); let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
          v.forEach(([la, lo], i) => { m[2 * i] = mx(lo); m[2 * i + 1] = my(la); la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); });
          return { m, la0, la1, lo0, lo1 };
        }),
      })),
    };
  }
  /** Syvyys (nykyvedellä) pisteessä: bilineaarinen, jos solun kaikki kulmat kelvollisia, muuten lähin kelvollinen solmu. */
  function ruudukkoSyvyys(G, lat, lon) {
    if (!G) return null;
    const x = ((lon - G.lon0) * G.kx - G.x0) / G.s, y = ((lat - G.lat0) * G.ky - G.y0) / G.s;
    if (x < 0 || y < 0 || x > G.N || y > G.N) return null;
    const i = Math.min(G.N - 1, Math.floor(x)), j = Math.min(G.N - 1, Math.floor(y)), tx = x - i, ty = y - j, M = G.M, Z = G.Z;
    const a = Z[j * M + i], b = Z[j * M + i + 1], c = Z[(j + 1) * M + i + 1], d = Z[(j + 1) * M + i];
    if (![a, b, c, d].some(isNaN)) return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + c * tx) * ty;
    const v = Z[Math.round(y) * M + Math.round(x)];
    return isNaN(v) ? null : v;
  }

  const PilkkiLuotaus = { ANTURI_M, KAYRAVALI_M, luoJasennin, lueTiedosto, sarjaArvo, paivaSarja, jasennaFmi, fmiAsemaSarja, korjattu,
    teeRuudukko, kayrat, kartalle, ruudukkoSyvyys, lonE, latN };
  if (typeof module !== 'undefined' && module.exports) module.exports = PilkkiLuotaus;
  else root.PilkkiLuotaus = PilkkiLuotaus;
})(typeof window !== 'undefined' ? window : this);
