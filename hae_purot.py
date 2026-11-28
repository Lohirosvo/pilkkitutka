"""Pilkkitutka – hae_purot.py (v1, 28.11.2026)

Hannu 28.11.2026: "Haetaan purot sekä meri että järvi. Ei erillisiä varoituksia puro varoittaa itsestään."

Lähde: Maanmittauslaitos, INSPIRE-vesistöt, OGC API Features
  https://avoin-paikkatieto.maanmittauslaitos.fi/inspire-hydrography/features/v1/
  - avoin, ei API-avainta [T, MML 28.11.2026]
  - watercourse: virtavedet viivoina, localType "Virtavesi alle 2 m" / "Virtavesi 2-5 m", 1:10 000, ei nimiä [T, näytekysely
    Raippaluodolta 28.11.2026]
  - landwaterboundary: rantaviivat viivoina; meren ja järven rantaa ei erota ominaisuuksista [T, näytekysely]
  - lisenssi: MML:n avoin data CC BY 4.0 [O: palvelun omilla sivuilla ei mainintaa, MML:n avoimen datan yleinen lisenssi]

Mitä tehdään (alueittain):
  1. haetaan alueen virtavesiviivat ja rantaviivat; sivutus next-linkeillä
  2. viivan pää, joka on enintään RANTA_M päässä rantaviivasta, on suu (laskee mereen, järveen, lampeen tai leveään jokeen;
     myös järvestä lähtevä puro) [O: rantaviivasta ei erotu, minkä vesialueen rantaa se on]
  3. suulta kuljetaan puroverkostoa PITUUS_M metriä (myös sivuhaarat) ja vain se osa tallennetaan; kaukana rannasta
     kulkevat ojat jäävät pois
  4. purot.json: viivat koodattuina (1e-5 astetta, delta kuten syvyys.json) ja suut pisteinä

Purot muuttuvat harvoin: julkaistulla sivulla oleva alle 30 vrk vanha purot.json käytetään sellaisenaan.
Rajapintaa ei voitu testata täältä kuin muutamalla näytekyselyllä: lokiin tulostuvat sivumäärät, kohdetyypit, ensimmäisen
kohteen ominaisuudet ja viivojen päiden etäisyysjakauma rantaan, josta näkee, osuuko RANTA_M oikein.
"""
import heapq
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

API = "https://avoin-paikkatieto.maanmittauslaitos.fi/inspire-hydrography/features/v1/collections/"
SIVUKOOT = [10000, 5000, 1000]   # suurin ensin; jos palvelin ei hyväksy, pienempi [O: palvelun enimmäismäärää ei ilmoiteta]
MAX_SIVUT = 400
MAX_KOHTEITA = 1500000
RANTA_M = 20.0          # viivan pää näin lähellä rantaviivaa = suu [O]
PITUUS_M = 400.0        # suulta näin pitkä osa purosta talteen [O]
SOLMU_M = 2.0           # viivojen päät tätä lähempänä toisiaan = sama solmu
SOLU_M = 50.0           # päätepisteiden hakuruudukko
JAKAUMA = [(1, "≤1 m"), (5, "1–5 m"), (20, "5–20 m"), (50, "20–50 m")]
TOLERANSSI_M = 2.0
KERROIN = 100000
VERSIO = 1
UUSINTA_VRK = 30
REUNUS = 0.01           # haun reunus asteina, jotta alueen reunan purot saavat rantansa
OTSAKE = {"User-Agent": "pilkkitutka/2 (github.com/Lohirosvo/pilkkitutka; kerran kuussa)", "Accept": "application/geo+json, application/json"}
LAHDE = "© Maanmittauslaitos, INSPIRE-vesistöt (virtavedet ja rantaviivat)"
LISENSSI = "CC BY 4.0 (Maanmittauslaitoksen avoin data)"
HUOM = f"Purosta talletetaan {PITUUS_M:.0f} m ennen rantaa. Ei navigointikäyttöön."
LUOKAT = {"virtavesi alle 2 m": 1, "virtavesi 2-5 m": 2, "virtavesi 2–5 m": 2}


# ---------------------------------------------------------------- HTTP ja sivutus
def _hae_json(url, yrityksia=3, aikaraja=180):
    virhe = None
    for i in range(yrityksia):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=OTSAKE), timeout=aikaraja) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise
            virhe = e
        except Exception as e:  # noqa: BLE001
            virhe = e
        time.sleep(2 * (i + 1))
    raise virhe


def _bbox(alue):
    return (f"{alue['lon_min'] - REUNUS:.5f},{alue['lat_min'] - REUNUS:.5f},"
            f"{alue['lon_max'] + REUNUS:.5f},{alue['lat_max'] + REUNUS:.5f}")


def _seuraava(j, alkup):
    """next-linkki; puuttuvat alkuperäiset parametrit (bbox, limit, f) lisätään varmuuden vuoksi."""
    for l in j.get("links") or []:
        if isinstance(l, dict) and l.get("rel") == "next" and l.get("href"):
            osat = urllib.parse.urlsplit(l["href"])
            q = dict(urllib.parse.parse_qsl(osat.query, keep_blank_values=True))
            for k, v in alkup.items():
                q.setdefault(k, v)
            return urllib.parse.urlunsplit((osat.scheme, osat.netloc, osat.path, urllib.parse.urlencode(q), ""))
    return None


def hae_kokoelma(api, kokoelma, alue, kasittele, loki=print):
    """Kutsuu kasittele(features) sivu kerrallaan. Palauttaa tilaston."""
    perus = api + kokoelma + "/items"
    tila = {"sivuja": 0, "kohteita": 0, "tyypit": Counter(), "geometriat": Counter(), "esimerkki": None}
    j, alkup = None, None
    for koko in SIVUKOOT:
        alkup = {"bbox": _bbox(alue), "limit": str(koko), "f": "json"}
        try:
            j = _hae_json(perus + "?" + urllib.parse.urlencode(alkup))
            break
        except urllib.error.HTTPError as e:
            loki(f"purot: {kokoelma} limit={koko} hylättiin (HTTP {e.code}), kokeillaan pienempää")
            j = None
    if j is None:
        raise RuntimeError(f"{kokoelma}: rajapinta ei hyväksynyt yhtään sivukokoa")
    nahty = set()
    while True:
        kohteet = j.get("features")
        if not isinstance(kohteet, list):
            raise RuntimeError(f"{kokoelma}: vastauksessa ei ole features-listaa (avaimet {list(j)[:8]})")
        tila["sivuja"] += 1
        tila["kohteita"] += len(kohteet)
        for f in kohteet:
            p = f.get("properties") or {}
            if tila["esimerkki"] is None:
                tila["esimerkki"] = sorted(p)
            tila["tyypit"][str(p.get("localType") or p.get("localtype") or "–")] += 1
            tila["geometriat"][str((f.get("geometry") or {}).get("type"))] += 1
        kasittele(kohteet)
        if tila["kohteita"] > MAX_KOHTEITA:
            raise RuntimeError(f"{kokoelma}: yli {MAX_KOHTEITA} kohdetta, keskeytetään")
        seur = _seuraava(j, alkup)
        if not seur or not kohteet:
            break
        if seur in nahty or tila["sivuja"] >= MAX_SIVUT:
            loki(f"purot: {kokoelma} sivutus pysäytetty ({tila['sivuja']} sivua)")
            break
        nahty.add(seur)
        j = _hae_json(seur)
    loki(f"purot: {kokoelma} {tila['kohteita']} kohdetta, {tila['sivuja']} sivua; tyypit {dict(tila['tyypit'].most_common(6))}; "
         f"geometriat {dict(tila['geometriat'])}; ominaisuudet {tila['esimerkki']}")
    return tila


# ---------------------------------------------------------------- geometria (paikallinen metrikoordinaatisto)
class Projektio:
    def __init__(self, alue):
        self.lat0 = (alue["lat_min"] + alue["lat_max"]) / 2
        self.kx = 111320.0 * math.cos(math.radians(self.lat0))
        self.ky = 110574.0

    def xy(self, lon, lat):
        return lon * self.kx, lat * self.ky

    def latlon(self, x, y):
        return y / self.ky, x / self.kx


def viivat(geom):
    """GeoJSON-geometriasta [[(lon, lat), ...], ...]; muut kuin viivat ohitetaan."""
    if not isinstance(geom, dict):
        return []
    t, c = geom.get("type"), geom.get("coordinates")
    try:
        if t == "LineString":
            return [[(float(p[0]), float(p[1])) for p in c]]
        if t == "MultiLineString":
            return [[(float(p[0]), float(p[1])) for p in v] for v in c]
    except (TypeError, ValueError, IndexError):
        return []
    return []


def _pituus(xy):
    return sum(math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]) for i in range(len(xy) - 1))


def _katkaise(xy, matka):
    """Viivan alusta matka metriä (interpoloiden)."""
    if matka <= 0 or len(xy) < 2:
        return xy[:1]
    out, kuljettu = [xy[0]], 0.0
    for i in range(len(xy) - 1):
        (x1, y1), (x2, y2) = xy[i], xy[i + 1]
        d = math.hypot(x2 - x1, y2 - y1)
        if kuljettu + d >= matka:
            t = (matka - kuljettu) / d if d > 0 else 0
            out.append((x1 + t * (x2 - x1), y1 + t * (y2 - y1)))
            return out
        out.append((x2, y2))
        kuljettu += d
    return out


def _etaisyys_janaan(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


# ---------------------------------------------------------------- verkosto
class Verkosto:
    def __init__(self, proj):
        self.proj = proj
        self.solmut = []          # [(x, y)]
        self.solmu_avain = {}     # (round(x/SOLMU_M), round(y/SOLMU_M)) -> id
        self.reunat = []          # [(a, b, pituus, xy, luokka)]
        self.vierus = []          # solmu -> [(reuna, onko_alku)]
        self.ohitettu = Counter()

    def _solmu(self, x, y):
        k = (round(x / SOLMU_M), round(y / SOLMU_M))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                i = self.solmu_avain.get((k[0] + dx, k[1] + dy))
                if i is not None and math.hypot(self.solmut[i][0] - x, self.solmut[i][1] - y) <= SOLMU_M:
                    return i
        i = len(self.solmut)
        self.solmut.append((x, y)); self.solmu_avain[k] = i; self.vierus.append([])
        return i

    def lisaa(self, kohteet):
        for f in kohteet:
            p = f.get("properties") or {}
            luokka = LUOKAT.get(str(p.get("localType") or p.get("localtype") or "").strip().lower(), 3)
            vv = viivat(f.get("geometry"))
            if not vv:
                self.ohitettu[str((f.get("geometry") or {}).get("type"))] += 1
            for v in vv:
                xy = [self.proj.xy(lon, lat) for lon, lat in v]
                xy = [p for i, p in enumerate(xy) if i == 0 or p != xy[i - 1]]
                if len(xy) < 2:
                    continue
                a, b = self._solmu(*xy[0]), self._solmu(*xy[-1])
                e = len(self.reunat)
                self.reunat.append((a, b, _pituus(xy), xy, luokka))
                self.vierus[a].append((e, True)); self.vierus[b].append((e, False))


class Ranta:
    """Merkitsee verkoston solmut, joiden lähellä kulkee rantaviiva. Rantaviivoja ei säilytetä muistissa."""
    def __init__(self, verkosto):
        self.v = verkosto
        self.solut = {}
        for i, (x, y) in enumerate(verkosto.solmut):
            self.solut.setdefault((int(x // SOLU_M), int(y // SOLU_M)), []).append(i)
        self.lahin = [math.inf] * len(verkosto.solmut)
        self.janoja = 0
        self.rajat = JAKAUMA[-1][0]

    def lisaa(self, kohteet):
        proj, solut, lahin, solmut, r = self.v.proj, self.solut, self.lahin, self.v.solmut, self.rajat
        for f in kohteet:
            for v in viivat(f.get("geometry")):
                xy = [proj.xy(lon, lat) for lon, lat in v]
                for i in range(len(xy) - 1):
                    (x1, y1), (x2, y2) = xy[i], xy[i + 1]
                    self.janoja += 1
                    cx0, cx1 = int((min(x1, x2) - r) // SOLU_M), int((max(x1, x2) + r) // SOLU_M)
                    cy0, cy1 = int((min(y1, y2) - r) // SOLU_M), int((max(y1, y2) + r) // SOLU_M)
                    if (cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400:   # poikkeuksellisen pitkä jana: pilkotaan
                        n = int(math.hypot(x2 - x1, y2 - y1) // SOLU_M) + 1
                        pts = [(x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n) for k in range(n + 1)]
                        self.lisaa([{"geometry": {"type": "LineString", "coordinates": [proj.latlon(*p)[::-1] for p in pts]}}])
                        continue
                    for cx in range(cx0, cx1 + 1):
                        for cy in range(cy0, cy1 + 1):
                            for s in solut.get((cx, cy), ()):
                                d = _etaisyys_janaan(solmut[s][0], solmut[s][1], x1, y1, x2, y2)
                                if d < lahin[s]:
                                    lahin[s] = d

    def suut(self):
        return [i for i, d in enumerate(self.lahin) if d <= RANTA_M]

    def jakauma(self):
        """Viivojen päätepisteiden (aste 1 = puron pää) etäisyysjakauma rantaan."""
        c = Counter()
        for i, d in enumerate(self.lahin):
            if len(self.v.vierus[i]) != 1:
                continue
            for raja, nimi in JAKAUMA:
                if d <= raja:
                    c[nimi] += 1
                    break
            else:
                c["> 50 m"] += 1
        return {nimi: c[nimi] for _, nimi in JAKAUMA + [(0, "> 50 m")]}


def kattavuus(verkosto, suut, pituus=PITUUS_M):
    """Monilähteinen Dijkstra suilta. Palauttaa {reuna: [alusta_m, lopusta_m]}."""
    dist = [math.inf] * len(verkosto.solmut)
    keko = []
    for s in suut:
        dist[s] = 0.0
        heapq.heappush(keko, (0.0, s))
    kat = {}
    while keko:
        d, u = heapq.heappop(keko)
        if d > dist[u] or d >= pituus:
            continue
        for e, alusta in verkosto.vierus[u]:
            a, b, L, _, _ = verkosto.reunat[e]
            ulottuu = min(L, pituus - d)
            k = kat.setdefault(e, [0.0, 0.0])
            k[0 if alusta else 1] = max(k[0 if alusta else 1], ulottuu)
            w = b if alusta else a
            if d + L < dist[w]:
                dist[w] = d + L
                heapq.heappush(keko, (d + L, w))
    return kat


def palat(verkosto, kat):
    """Katetut viivanpalat [(xy, luokka)], suunta suulta poispäin ei ole merkitsevä."""
    out = []
    for e, (alku, loppu) in kat.items():
        _, _, L, xy, luokka = verkosto.reunat[e]
        if alku + loppu >= L - 0.5:
            out.append((xy, luokka))
            continue
        if alku > 0.5:
            out.append((_katkaise(xy, alku), luokka))
        if loppu > 0.5:
            out.append((_katkaise(xy[::-1], loppu), luokka))
    return out


# ---------------------------------------------------------------- koodaus
def _yksinkertaista(xy, tol=TOLERANSSI_M):
    if len(xy) < 3:
        return list(xy)
    pidetaan = [False] * len(xy)
    pidetaan[0] = pidetaan[-1] = True
    pino = [(0, len(xy) - 1)]
    while pino:
        i, j = pino.pop()
        paras, pk = -1.0, -1
        for k in range(i + 1, j):
            d = _etaisyys_janaan(xy[k][0], xy[k][1], xy[i][0], xy[i][1], xy[j][0], xy[j][1])
            if d > paras:
                paras, pk = d, k
        if paras > tol:
            pidetaan[pk] = True
            pino += [(i, pk), (pk, j)]
    return [p for p, k in zip(xy, pidetaan) if k]


def origo_alueelle(alue):
    return (math.floor(alue["lat_min"] * 10) / 10, math.floor(alue["lon_min"] * 10) / 10)


def koodaa(pts, origo):
    """[(lat, lon)] -> [x0, y0, dx1, dy1, ...] (x = lon, y = lat; 1e-5 astetta, delta) kuten syvyys.json."""
    out, px, py = [], None, None
    for lat, lon in pts:
        x, y = round((lon - origo[1]) * KERROIN), round((lat - origo[0]) * KERROIN)
        if px is None:
            out += [x, y]
        elif x != px or y != py:
            out += [x - px, y - py]
        else:
            continue
        px, py = x, y
    return out


def rakenna(verkosto, suut, kat, alue, luotu, tilasto):
    proj, origo = verkosto.proj, origo_alueelle(alue)
    linjat, pisteita = [], 0
    for xy, luokka in palat(verkosto, kat):
        y = _yksinkertaista(xy)
        k = koodaa([proj.latlon(px, py) for px, py in y], origo)
        if len(k) >= 4:
            linjat.append({"k": k, "l": luokka})
            pisteita += len(k) // 2
    suu_pisteet, nahty = [], set()
    for s in suut:
        lat, lon = proj.latlon(*verkosto.solmut[s])
        x, y = round((lon - origo[1]) * KERROIN), round((lat - origo[0]) * KERROIN)
        avain = (x // 20, y // 20)   # ~10–20 m: lähekkäiset suut yhdeksi
        if avain in nahty:
            continue
        nahty.add(avain)
        suu_pisteet += [x, y]
    return {"muoto": 1, "versio": VERSIO, "luotu": luotu, "lahde": LAHDE, "lisenssi": LISENSSI, "huom": HUOM, "alue": alue,
            "pituus_m": PITUUS_M, "ranta_m": RANTA_M, "origo": list(origo), "kerroin": KERROIN, "pisteita": pisteita,
            "linjat": linjat, "suut": suu_pisteet, "tilasto": tilasto}


def hae_alue(alue, loki=print, api=API):
    """Palauttaa (purot.json-sisältö, None) tai (None, virhe)."""
    try:
        proj = Projektio(alue)
        V = Verkosto(proj)
        tv = hae_kokoelma(api, "watercourse", alue, V.lisaa, loki)
        if not V.reunat:
            return None, f"alueelta ei saatu yhtään virtavesiviivaa ({tv['kohteita']} kohdetta)"
        R = Ranta(V)
        tr = hae_kokoelma(api, "landwaterboundary", alue, R.lisaa, loki)
        if not R.janoja:
            return None, f"alueelta ei saatu yhtään rantaviivaa ({tr['kohteita']} kohdetta)"
        suut = R.suut()
        kat = kattavuus(V, suut)
        jak = R.jakauma()
        tilasto = {"viivoja": len(V.reunat), "luokat": dict(Counter(r[4] for r in V.reunat)), "rantajanoja": R.janoja,
                   "suita": len(suut), "paat_rantaan": jak, "ohitettu": dict(V.ohitettu)}
        loki(f"purot: {len(V.reunat)} viivaa, {R.janoja} rantajanaa, {len(suut)} suuta (≤ {RANTA_M:.0f} m); "
             f"purojen päiden etäisyys rantaan {jak}; ohitettu {dict(V.ohitettu)}")
        luotu = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return rakenna(V, suut, kat, alue, luotu, tilasto), None
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


def paivita(kansio, sivun_osoite, loki=print, alue=None, api=API):
    """Kirjoittaa kansio/purot.json. Palauttaa {tila, luotu?, viesti?, suita?}."""
    polku = os.path.join(kansio, "purot.json")
    vanha = None
    try:
        with urllib.request.urlopen(urllib.request.Request(sivun_osoite + "purot.json", headers=OTSAKE), timeout=30) as r:
            vanha = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        loki(f"purot: edellistä purot.json:ia ei saatu ({e})")
    if not (isinstance(vanha, dict) and "linjat" in vanha):
        vanha = None
    varalla = vanha
    if vanha and alue and vanha.get("alue") != alue:
        loki("purot: edellinen tiedosto on eri alueelta – haetaan uudelleen")
        vanha = varalla = None
    if vanha and vanha.get("versio", 0) < VERSIO:
        loki(f"purot: edellinen tiedosto on vanhaa versiota ({vanha.get('versio')}) – haetaan uudelleen")
        vanha = None

    def kirjoita(j):
        with open(polku, "w", encoding="utf-8") as f:
            json.dump(j, f, ensure_ascii=False, separators=(",", ":"))

    if vanha:
        try:
            ika = (datetime.now(timezone.utc) - datetime.strptime(vanha["luotu"], "%Y-%m-%dT%H:%M:%SZ")
                   .replace(tzinfo=timezone.utc)).days
        except Exception:  # noqa: BLE001
            ika = 999
        if ika < UUSINTA_VRK:
            kirjoita(vanha)
            loki(f"purot: käytetään edellistä ({ika} vrk vanha)")
            return {"tila": "ok", "luotu": vanha["luotu"], "suita": len(vanha.get("suut", [])) // 2}
    uusi, virhe = hae_alue(alue, loki, api)
    if uusi:
        kirjoita(uusi)
        loki(f"purot: kirjoitettu {polku}, {os.path.getsize(polku) // 1024} kt, {len(uusi['linjat'])} viivaa, "
             f"{len(uusi['suut']) // 2} suuta")
        return {"tila": "ok", "luotu": uusi["luotu"], "suita": len(uusi["suut"]) // 2}
    loki(f"purot: VIRHE {virhe}")
    if varalla:
        kirjoita(varalla)
        return {"tila": "vanha", "luotu": varalla["luotu"], "viesti": virhe, "suita": len(varalla.get("suut", [])) // 2}
    return {"tila": "virhe", "viesti": virhe}


if __name__ == "__main__":   # käsin: python hae_purot.py kansio lat_min lat_max lon_min lon_max
    a = sys.argv
    al = dict(lat_min=float(a[2]), lat_max=float(a[3]), lon_min=float(a[4]), lon_max=float(a[5])) if len(a) > 5 else \
        dict(lat_min=63.20, lat_max=63.30, lon_min=21.30, lon_max=21.45)
    print(paivita(a[1] if len(a) > 1 else ".", "https://lohirosvo.github.io/pilkkitutka/data/purot/kokeilu/", alue=al))
