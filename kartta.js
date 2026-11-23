/* Pilkkitutka – kartta.js v002 (23.11.2026)
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
      this.jalki = []; this.pysahdykset = []; this.pisteet = []; this.gps = null; this.leiri = null;
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
      this._syvyys();
      this._jalki();
      this._pysahdykset();
      this._leiri();
      this._pisteet();
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
      const tyyli = d => d <= 2 ? ['rgba(30,110,170,0.55)', 0.8] : d < 10 ? ['rgba(20,90,160,0.8)', 1.2]
        : d < 20 ? ['rgba(10,70,140,0.85)', 1.5] : ['rgba(5,45,110,0.9)', 1.9];
      g.save(); g.lineJoin = 'round'; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const nimiot = [];
      for (const S of this.syvyys) for (const taso of S.tasot) {
        const [vari, lev] = tyyli(taso.syvyys);
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
          if (mid && pit > 140 && this.z >= 12) nimiot.push([taso.syvyys, mid[0], mid[1], vari]);
        }
        g.stroke();
      }
      for (const [d, x, y] of nimiot) {   // numerot harvennettuina, ettei näyttö tukkeudu
        if (x < 12 || y < 12 || x > this.w - 12 || y > this.h - 12) continue;
        const avain = Math.round(x / 70) + ',' + Math.round(y / 40);
        if (merkityt.has(avain)) continue;
        merkityt.add(avain);
        const txt = String(d).replace('.', ',');
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
            if (o && this._osoittimet.size === 1 && Math.hypot(o.x - o.x0, o.y - o.y0) < 10) {
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

  const PilkkiKartta = { TILE, mx, my, mLat, mLon, etaisyysM, JALKI, jalkiLisaa, jalkiAlfa, jalkiOsat, PYSAHDYS, pysahdykset,
    puraSyvyys, MERKIT, Kartta };
  if (typeof module !== 'undefined' && module.exports) module.exports = PilkkiKartta;
  else root.PilkkiKartta = PilkkiKartta;
})(typeof window !== 'undefined' ? window : this);
