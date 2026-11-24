#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pilkkitutka – hakuajo v001 (23.11.2026)

Ajetaan GitHub Actionsissa:
    python hae_pilkki.py _site/data/pilkki.json --edellinen _site/data/pilkki_ed.json [--tilasto]

Vaiheet (jokainen omassa try-lohkossaan – yhden lähteen kaatuminen ei estä muita):
  1. mareografit   FMI fmi::observations::mareograph::simple       vedenkorkeus N2000 + teor. keskivesi, vesilämpö
  2. vk_ennuste    FMI fmi::forecast::sealevel::point::simple      vedenkorkeusennuste pisteisiin
  3. saa           FMI fmi::forecast::harmonie::surface::point::simple  lämpö, tuuli, puuska, sade, pilvisyys
  4. lampohistoria FMI fmi::observations::weather::simple (t2m)    vuorokausikeskiarvot, kertyy ajosta toiseen
  5. jaa_malli     Copernicus BAL phy (2 km): jään peittävyys ja paksuus, analyysi + ennuste
  6. jaakartta     Copernicus SEAICE BAL: FMI:n/SMHI:n jääkarttoihin perustuva paksuus
  7. vk_tilasto    (vain --tilasto) mareografien talvihistoria leirin vedenkorkeusvahtia varten

Tarkistetut rajapintatiedot (FMI avoin data, 23.11.2026):
  - mareografin parametrit WATLEV, WLEVN2K_PT1S_INSTANT, TW_PT1H_AVG; vedenkorkeus millimetreinä
  - ennusteen parametrit SeaLevel, SeaLevelN2000; senttimetreinä
  - HARMONIE: Temperature, WindSpeedMS, WindGust, WindDirection, PrecipitationAmount, TotalCloudCover, Pressure
Copernicus-aineistojen versiota ei lukita: työkalu valitsee oletusversion (vanhat BAL-versiot poistuvat 12.1.2027).
Muuttujat etsitään standard_name-attribuutilla, jotta uuden version nimimuutos ei kaada hakua.
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

VERSIO = "v007"
UA = "pilkkitutka/v007 (+https://lohirosvo.github.io/pilkkitutka/)"
FMI_WFS = "https://opendata.fmi.fi/wfs"

# Alue Kaskinen–Mikkelinsaaret [O: rajaus väljä, kattaa Kaskisen 62,33 ja Mikkelinsaarten 63,46]
ALUE = {"lat_min": 62.25, "lat_max": 63.55, "lon_min": 20.75, "lon_max": 22.10}

# Mareografit [T]: Vaasa = FMI avoimen datan gml:pos, Kaskinen = IHO-luettelo 62°20'N 21°13'E
MAREOGRAFIT = [
    {"nimi": "Vaasa", "lat": 63.0815, "lon": 21.5712},
    {"nimi": "Kaskinen", "lat": 62.3333, "lon": 21.2167},
]
MAREOGRAFI_MAX_KM = 15.0

# Sää- ja vedenkorkeusennusteen pisteet. "tarkkuus" kertoo, mistä koordinaatti on.
PISTEET = [
    {"nimi": "Kaskinen", "lat": 62.3333, "lon": 21.2167, "tarkkuus": "mareografi [T]"},
    {"nimi": "Åminne", "lat": 62.972, "lon": 21.488, "tarkkuus": "satama, heikko verkkolähde [O]"},
    {"nimi": "Vaasa (Vaskiluoto)", "lat": 63.0815, "lon": 21.5712, "tarkkuus": "mareografi [T]"},
    {"nimi": "Raippaluoto", "lat": 63.23, "lon": 21.40, "tarkkuus": "likimääräinen [O]"},
    {"nimi": "Mikkelinsaaret", "lat": 63.46, "lon": 21.775, "tarkkuus": "satama [T]"},
]

# Syvyyskäyrät kolmena osa-alueena, jotta puhelin lataa vain näkyvän alueen [O: rajaukset].
# Merilohitutkan Vaasa-alue (0,61° × 0,85°) oli 1,07 Mt, joten koko alue yhtenä olisi raskas.
SIVU = "https://lohirosvo.github.io/pilkkitutka/"
SYVYYS_ALUEET = [
    {"nimi": "etela", "otsikko": "Kaskinen–Närpiö", "alue": {"lat_min": 62.25, "lat_max": 62.62, "lon_min": 20.75, "lon_max": 21.70}},
    {"nimi": "keski", "otsikko": "Korsnäs–Åminne", "alue": {"lat_min": 62.60, "lat_max": 63.05, "lon_min": 20.75, "lon_max": 21.80}},
    {"nimi": "pohjoinen", "otsikko": "Vaasa–Raippaluoto–Mikkelinsaaret", "alue": {"lat_min": 63.00, "lat_max": 63.55, "lon_min": 20.75, "lon_max": 22.10}},
]

# FMI:n place-haku valitsee lähimmän havaintoaseman (Maalahti -> 62,935 21,185 tarkistettu 23.11.2026)
# v005: järville Lappajärvi ja Seinäjoki [O: asema selviää lokista]
LAMPOPAIKAT = ["Maalahti", "Vaasa", "Kaskinen", "Lappajärvi", "Seinäjoki"]

# ---------------------------------------------------------------- järvet (Hannu 24.11.2026: Lappajärvi, Varpula, Hirvijärvi)
# Asemat: Lappajärvi 2324 ja Hirvijärvi 2312 uistelututkan toimivasta koodista [T]; Varpula haetaan nimellä [O].
# Keskipisteet: Lappajärvi ja Hirvijärvi uistelututkan jarvet.js [T], Varpula fi.wikipedia 62°47′57″N 23°08′19″E [T].
# 24.11.2026: 1.0 ei vastannut hakuajolle eikä uistelututkalle ("Network error (Paikka)"). Nykyversio on 1.2 (Syke 11.5.2026) [T],
# toimiva esimerkki: github.com/anttirauhala/water-temperature-lambda käyttää .../1.2/odata [T]. Kokeillaan järjestyksessä.
SYKE_HYDRO_OSOITTEET = [
    "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata/",
    "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata/",
    "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.0/odata/",
]
SYKE_HYDRO = SYKE_HYDRO_OSOITTEET[0]
_SYKE_TOIMIVA = None
JARVET = [
    {"tunnus": "lappajarvi", "nimi": "Lappajärvi", "lat": 63.15651, "lon": 23.6699, "syke_id": 2324, "haku": "Lappajärvi"},
    {"tunnus": "varpula", "nimi": "Varpulan tekojärvi", "lat": 62.7992, "lon": 23.1386, "syke_id": None, "haku": "Varpula"},
    {"tunnus": "hirvijarvi", "nimi": "Hirvijärven tekojärvi", "lat": 62.8049, "lon": 23.0947, "syke_id": 2312, "haku": "Hirvijärvi"},
]
JARVI_HISTORIA_VUODET = 6
JARVI_HISTORIA_UUSINTA_VRK = 30
JARVI_TUORE_VRK = 120
# Väylät järvelle (Väyläviraston aineisto kattaa myös sisävesiväylät) [O: vain Lappajärvellä on merkittyjä väyliä]
VAYLA_LISA_ALUEET = [
    {"nimi": "lappajarvi", "otsikko": "Lappajärvi", "alue": {"lat_min": 63.00, "lat_max": 63.32, "lon_min": 23.45, "lon_max": 23.90}},
]

SAA_PARAMS = "Temperature,WindSpeedMS,WindGust,WindDirection,PrecipitationAmount,TotalCloudCover,Pressure,RadiationGlobal"
PAIKALLINEN_UTC_SIIRTO_H = 2  # vuorokausijako talviajassa (EET)


# ---------------------------------------------------------------- apufunktiot

def nyt_utc():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def lue_aika(s):
    return dt.datetime.strptime(s.strip(), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def km_valilla(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def pyor(x, d=1):
    if x is None or not math.isfinite(x):
        return None
    return round(x, d)


def poimi_fmi_virhe(teksti):
    """FMI palauttaa virheen ExceptionReport-XML:nä; poimitaan ExceptionText."""
    try:
        juuri = ET.fromstring(teksti)
        osat = [e.text.strip() for e in juuri.iter() if e.tag.endswith("ExceptionText") and e.text]
        if osat:
            return " / ".join(osat)[:400]
    except ET.ParseError:
        pass
    return teksti[:300]


def http_get(url, yrityksia=3, aikaraja=90, otsakkeet=None):
    viimeisin = "tuntematon virhe"
    for i in range(yrityksia):
        try:
            req = urllib.request.Request(url, headers=dict({"User-Agent": UA}, **(otsakkeet or {})))
            with urllib.request.urlopen(req, timeout=aikaraja) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            runko = e.read()[:4000].decode("utf-8", "replace")
            viimeisin = f"HTTP {e.code}: {poimi_fmi_virhe(runko)}"
            if 400 <= e.code < 500 and e.code != 429:
                break  # pyyntö itsessään väärin – uusinta ei auta
        except Exception as e:  # verkko, aikakatkaisu
            viimeisin = f"{type(e).__name__}: {e}"
        time.sleep(3 * (i + 1))
    raise RuntimeError(viimeisin)


def jasenna_simple(xml_tavut):
    """FMI 'simple'-muoto -> [(lat, lon, aika, parametri, arvo|None)]."""
    juuri = ET.fromstring(xml_tavut)
    if juuri.tag.endswith("ExceptionReport"):
        raise RuntimeError(poimi_fmi_virhe(xml_tavut.decode("utf-8", "replace")))
    rivit = []
    for el in juuri.iter():
        if not el.tag.endswith("BsWfsElement"):
            continue
        pos = el.find(".//{*}pos")
        aika = el.find("{*}Time")
        nimi = el.find("{*}ParameterName")
        arvo = el.find("{*}ParameterValue")
        if pos is None or aika is None or nimi is None or arvo is None or not pos.text:
            continue
        osat = pos.text.split()
        lat, lon = float(osat[0]), float(osat[1])
        try:
            v = float(arvo.text)
        except (TypeError, ValueError):
            v = None
        if v is not None and not math.isfinite(v):
            v = None
        rivit.append((round(lat, 5), round(lon, 5), aika.text.strip(), nimi.text.strip(), v))
    return rivit


def fmi_hae(kysely, parametrit):
    p = {"service": "WFS", "version": "2.0.0", "request": "getFeature", "storedquery_id": kysely}
    p.update({k: v for k, v in parametrit.items() if v is not None})
    url = FMI_WFS + "?" + urllib.parse.urlencode(p, safe=",:")
    return jasenna_simple(http_get(url))


def fmi_hae_ennuste(kysely, parametrit, nyt, tunteja):
    """Pyydetään pidempi jakso; jos FMI hylkää loppuajan, haetaan oletusjaksolla."""
    try:
        return fmi_hae(kysely, dict(parametrit, endtime=iso(nyt + dt.timedelta(hours=tunteja))))
    except RuntimeError as e:
        print(f"  {kysely}: loppuaika hylättiin ({e}) – haetaan oletusjaksolla")
        return fmi_hae(kysely, parametrit)


def ryhmittele(rivit):
    """-> {(lat, lon): {parametri: [(aika, arvo), ...] aikajärjestyksessä}}"""
    out = {}
    for lat, lon, t, p, v in rivit:
        out.setdefault((lat, lon), {}).setdefault(p, []).append((t, v))
    for g in out.values():
        for p in g:
            g[p].sort(key=lambda x: x[0])
    return out


def lahin(avaimet, lat, lon, max_km):
    paras, paras_d = None, None
    for k in avaimet:
        d = km_valilla(lat, lon, k[0], k[1])
        if paras_d is None or d < paras_d:
            paras, paras_d = k, d
    if paras is None or paras_d > max_km:
        return None
    return paras


def paikallinen_pvm(aika_iso):
    t = lue_aika(aika_iso) + dt.timedelta(hours=PAIKALLINEN_UTC_SIIRTO_H)
    return t.strftime("%Y-%m-%d")


def vrk_keskiarvot(tunnit, min_n=20):
    """[(aika, arvo)] -> {pvm: keskiarvo} vain vuorokausille, joilla vähintään min_n arvoa."""
    ryhmat = {}
    for t, v in tunnit:
        if v is None:
            continue
        ryhmat.setdefault(paikallinen_pvm(t), []).append(v)
    return {d: round(sum(a) / len(a), 2) for d, a in ryhmat.items() if len(a) >= min_n}


def vrk_maksimit(tunnit, min_n=12):
    ryhmat = {}
    for t, v in tunnit:
        if v is None:
            continue
        ryhmat.setdefault(paikallinen_pvm(t), []).append(v)
    return {d: round(max(a), 1) for d, a in ryhmat.items() if len(a) >= min_n}


def muunna_sade(arvot):
    """PrecipitationAmount voi olla kertyvä tai tunnittainen. Kertyvä tunnistetaan kasvavuudesta.
    Palauttaa (tuntisateet, tulkinta)."""
    a = [v for v in arvot if v is not None]
    if len(a) >= 3 and all(a[i + 1] >= a[i] - 1e-6 for i in range(len(a) - 1)) and a[-1] - a[0] > 0.05:
        out, ed = [], None
        for v in arvot:
            if v is None:
                out.append(None)
                continue
            out.append(round(max(0.0, v - ed), 2) if ed is not None else None)
            ed = v
        return out, "kertyvä -> tunnittain"
    return [None if v is None else round(max(0.0, v), 2) for v in arvot], "tunnittainen"


# ---------------------------------------------------------------- 1. mareografit

def hae_mareografit(nyt):
    rivit = fmi_hae("fmi::observations::mareograph::simple", {
        "starttime": iso(nyt - dt.timedelta(hours=50)), "endtime": iso(nyt), "timestep": 60,
        "parameters": "WATLEV,WLEVN2K_PT1S_INSTANT,TW_PT1H_AVG"})
    ryhmat = ryhmittele(rivit)
    tulos = []
    for m in MAREOGRAFIT:
        k = lahin(ryhmat.keys(), m["lat"], m["lon"], MAREOGRAFI_MAX_KM)
        if k is None:
            tulos.append(dict(m, virhe="asemaa ei löytynyt vastauksesta"))
            continue
        g = ryhmat[k]

        def sarja(param, kerroin, raja):
            return [[t, pyor(v * kerroin, 1)] for t, v in g.get(param, [])
                    if v is not None and abs(v * kerroin) < raja]

        rivi = dict(m, lat_asema=k[0], lon_asema=k[1],
                    n2000_cm=sarja("WLEVN2K_PT1S_INSTANT", 0.1, 400),
                    teor_cm=sarja("WATLEV", 0.1, 400),
                    vesilampo_c=sarja("TW_PT1H_AVG", 1.0, 40))
        viim = rivi["n2000_cm"][-1] if rivi["n2000_cm"] else None
        print(f"  {m['nimi']}: asema {k}, N2000 viimeisin {viim}, arvoja {len(rivi['n2000_cm'])}")
        tulos.append(rivi)
    return tulos


# ---------------------------------------------------------------- 2. vedenkorkeusennuste

def hae_vk_ennuste(nyt):
    out = []
    for p in PISTEET:
        try:
            rivit = fmi_hae_ennuste("fmi::forecast::sealevel::point::simple",
                                    {"latlon": f"{p['lat']},{p['lon']}", "timestep": 60}, nyt, 120)
            g = ryhmittele(rivit)
            if not g:
                raise RuntimeError("tyhjä vastaus")
            k = lahin(g.keys(), p["lat"], p["lon"], 1e9)
            n2000 = [[t, pyor(v, 1)] for t, v in g[k].get("SeaLevelN2000", []) if v is not None]
            teor = [[t, pyor(v, 1)] for t, v in g[k].get("SeaLevel", []) if v is not None]
            out.append({"nimi": p["nimi"], "lat_lahde": k[0], "lon_lahde": k[1],
                        "n2000_cm": n2000, "teor_cm": teor})
            print(f"  {p['nimi']}: lähde {k}, {len(n2000)} tuntia")
        except Exception as e:
            out.append({"nimi": p["nimi"], "virhe": f"{type(e).__name__}: {e}"[:300]})
            print(f"  {p['nimi']}: VIRHE {e}")
    if not any("n2000_cm" in o for o in out):
        raise RuntimeError("yhdenkään pisteen ennuste ei onnistunut")
    return out


# ---------------------------------------------------------------- 3. sää

def hae_saa(nyt):
    out = []
    for p in PISTEET + [{"nimi": j["nimi"], "lat": j["lat"], "lon": j["lon"], "jarvi": j["tunnus"]} for j in JARVET]:
        try:
            rivit = fmi_hae_ennuste("fmi::forecast::harmonie::surface::point::simple",
                                    {"latlon": f"{p['lat']},{p['lon']}", "timestep": 60,
                                     "parameters": SAA_PARAMS}, nyt, 66)
            g = ryhmittele(rivit)
            if not g:
                raise RuntimeError("tyhjä vastaus")
            k = lahin(g.keys(), p["lat"], p["lon"], 1e9)
            ryhma = g[k]
            ajat = sorted({t for sarja in ryhma.values() for t, _ in sarja})

            def tasaa(param, d=1):
                m = dict(ryhma.get(param, []))
                return [pyor(m.get(t), d) for t in ajat]

            sade, tulkinta = muunna_sade(tasaa("PrecipitationAmount", 2))
            out.append({"nimi": p["nimi"], "jarvi": p.get("jarvi"), "lat_lahde": k[0], "lon_lahde": k[1], "ajat": ajat,
                        "T": tasaa("Temperature"), "ws": tasaa("WindSpeedMS"), "wg": tasaa("WindGust"),
                        "wd": tasaa("WindDirection", 0), "sade": sade, "sade_tulkinta": tulkinta,
                        "pilvi": tasaa("TotalCloudCover", 0), "paine": tasaa("Pressure"),
                        "sateily": tasaa("RadiationGlobal", 0)})
            print(f"  {p['nimi']}: {len(ajat)} tuntia ({ajat[0] if ajat else '-'} … {ajat[-1] if ajat else '-'}), sade {tulkinta}")
        except Exception as e:
            out.append({"nimi": p["nimi"], "virhe": f"{type(e).__name__}: {e}"[:300]})
            print(f"  {p['nimi']}: VIRHE {e}")
    if not any("ajat" in o for o in out):
        raise RuntimeError("yhdenkään pisteen sää ei onnistunut")
    return out


# ---------------------------------------------------------------- 4. lämpöhistoria

def yhdista_lampohistoria(vanha, paikka, lat, lon, uudet_paivat, nyt, sailyta_vrk=400):
    asemat = {a["paikka"]: a for a in (vanha or {}).get("asemat", []) if "paikka" in a}
    a = asemat.get(paikka) or {"paikka": paikka, "paivat": {}}
    a["paivat"] = dict(a.get("paivat", {}))
    a["paivat"].update(uudet_paivat)
    raja = (nyt - dt.timedelta(days=sailyta_vrk)).strftime("%Y-%m-%d")
    a["paivat"] = {d: v for d, v in sorted(a["paivat"].items()) if d >= raja}
    if lat is not None:
        a["lat"], a["lon"] = lat, lon
    asemat[paikka] = a
    return {"asemat": list(asemat.values())}


def hae_lampohistoria(nyt, vanha):
    tulos = vanha or {"asemat": []}
    onnistui = 0
    for paikka in LAMPOPAIKAT:
        try:
            rivit = fmi_hae("fmi::observations::weather::simple", {
                "place": paikka, "parameters": "t2m", "timestep": 60,
                "starttime": iso(nyt - dt.timedelta(hours=167)), "endtime": iso(nyt)})
            g = ryhmittele(rivit)
            if not g:
                raise RuntimeError("tyhjä vastaus")
            k = next(iter(g))
            paivat = vrk_keskiarvot(g[k].get("t2m", []))
            tulos = yhdista_lampohistoria(tulos, paikka, k[0], k[1], paivat, nyt)
            onnistui += 1
            print(f"  {paikka}: asema {k}, uusia vrk-keskiarvoja {len(paivat)}")
        except Exception as e:
            print(f"  {paikka}: VIRHE {e}")
    if onnistui == 0:
        raise RuntimeError("yhdenkään aseman lämpöhaku ei onnistunut")
    return tulos


# ---------------------------------------------------------------- 5.–6. Copernicus

def etsi_muuttuja(ds, standard_names, vihjeet):
    for v in ds.data_vars:
        if ds[v].attrs.get("standard_name") in standard_names:
            return v
    for v in ds.data_vars:
        if any(h in v.lower() for h in vihjeet):
            return v
    return None


def taulukko(a2d, kerroin):
    """2D numpy -> listat, kokonaisluvut, NaN -> None."""
    out = []
    for rivi in a2d:
        out.append([None if not math.isfinite(float(x)) else int(round(float(x) * kerroin)) for x in rivi])
    return out


def kerroin_yksikosta(avain, yksikko):
    y = (yksikko or "").strip().lower()
    if avain == "peitto_pct":
        return 1.0 if y in ("%", "percent", "percentage") else 100.0
    if avain == "paksuus_cm":
        return 1.0 if y in ("cm", "centimeters", "centimetres") else 100.0
    return 1.0


def _koordinaatit(da):
    latn = "latitude" if "latitude" in da.dims else "lat"
    lonn = "longitude" if "longitude" in da.dims else "lon"
    return latn, lonn


def _avaa(ds_id, alku, loppu, **lisa):
    import copernicusmarine  # asennetaan työnkulussa
    return copernicusmarine.open_dataset(
        dataset_id=ds_id,
        minimum_longitude=ALUE["lon_min"], maximum_longitude=ALUE["lon_max"],
        minimum_latitude=ALUE["lat_min"], maximum_latitude=ALUE["lat_max"],
        start_datetime=alku, end_datetime=loppu, **lisa)


def hae_jaa_malli(nyt):
    alku = (nyt - dt.timedelta(days=3)).strftime("%Y-%m-%dT00:00:00")
    loppu = (nyt + dt.timedelta(days=11)).strftime("%Y-%m-%dT00:00:00")
    virheet = []
    for ds_id, tunnittainen in (("cmems_mod_bal_phy_anfc_P1D-m", False),
                                ("cmems_mod_bal_phy_anfc_PT1H-i", True)):
        try:
            ds = _avaa(ds_id, alku, loppu)
            muuttujat = {
                "peitto_pct": etsi_muuttuja(ds, {"sea_ice_area_fraction"}, ("siconc", "iceconc", "ice_conc")),
                "paksuus_cm": etsi_muuttuja(ds, {"sea_ice_thickness"}, ("sithick", "icethick", "ice_thick")),
            }
            if not any(muuttujat.values()):
                raise RuntimeError(f"jäämuuttujia ei löytynyt: {list(ds.data_vars)}")
            tulos = {"dataset": ds_id, "muuttujat": {}}
            for avain, v in muuttujat.items():
                if not v:
                    continue
                da = ds[v]
                latn, lonn = _koordinaatit(da)
                for d in [d for d in da.dims if d not in ("time", latn, lonn)]:
                    da = da.isel({d: 0})
                if tunnittainen:
                    da = da.resample(time="1D").mean()
                da = da.transpose("time", latn, lonn).load()
                k = kerroin_yksikosta(avain, da.attrs.get("units", ""))
                tulos["muuttujat"][avain] = {
                    "nimi": v, "yksikko_lahde": da.attrs.get("units", ""),
                    "arvot": [taulukko(da.isel(time=i).values, k) for i in range(da.sizes["time"])]}
                tulos["lat"] = [round(float(x), 4) for x in da[latn].values]
                tulos["lon"] = [round(float(x), 4) for x in da[lonn].values]
                tulos["ajat"] = [str(t)[:10] for t in da["time"].values]
            nimet = ", ".join(a + "=" + m["nimi"] for a, m in tulos["muuttujat"].items())
            print(f"  {ds_id}: {len(tulos['ajat'])} vrk, ruudukko {len(tulos['lat'])}x{len(tulos['lon'])}, "
                  f"muuttujat {nimet}")
            if virheet:
                tulos["varalla_kaytetty"] = virheet
            return tulos
        except Exception as e:
            virheet.append(f"{ds_id}: {type(e).__name__}: {e}"[:300])
            print(f"  {ds_id}: VIRHE {e}")
    raise RuntimeError(" | ".join(virheet))


def hae_jaakartta(nyt):
    import numpy as np
    ds_id = "FMI-BAL-SEAICE_THICK-L4-NRT-OBS"
    ds = _avaa(ds_id, (nyt - dt.timedelta(days=7)).strftime("%Y-%m-%dT00:00:00"),
               nyt.strftime("%Y-%m-%dT23:59:59"))
    v = etsi_muuttuja(ds, {"sea_ice_thickness"}, ("thick",))
    if not v:
        raise RuntimeError(f"paksuusmuuttujaa ei löytynyt: {list(ds.data_vars)}")
    da = ds[v]
    latn, lonn = _koordinaatit(da)
    for d in [d for d in da.dims if d not in ("time", latn, lonn)]:
        da = da.isel({d: 0})
    da = da.transpose("time", latn, lonn).load()
    for i in reversed(range(da.sizes["time"])):
        a = da.isel(time=i).values
        if np.isfinite(a).any() and np.nanmax(a) > 0:
            k = kerroin_yksikosta("paksuus_cm", da.attrs.get("units", ""))
            print(f"  {ds_id}: {str(da['time'].values[i])[:10]}, ruudukko {a.shape}")
            return {"dataset": ds_id, "muuttuja": v, "yksikko_lahde": da.attrs.get("units", ""),
                    "aika": str(da["time"].values[i])[:10],
                    "lat": [round(float(x), 4) for x in da[latn].values],
                    "lon": [round(float(x), 4) for x in da[lonn].values],
                    "paksuus_cm": taulukko(a, k)}
    return {"dataset": ds_id, "aika": None, "huom": "ei jäätä viimeisen 7 vrk jääkartoissa"}


# ---------------------------------------------------------------- veden lämpö ja virtaus (Copernicus) -> data/vesi.json
# Hannu 23.11.2026: "Virtaus mm vedenkorkeusvaihtelun aiheuttama suunta ja voimakkuus, veden lämpötilasta mitä irti saa".
# Malli 2 km: kapeat salmet ja lahdet eivät erotu – virtausta salmissa kuvaa sovelluksessa myös vedenkorkeuden muutosnopeus.
VIRTA_TASOT_M = (0.5, 5.0)     # pinta ja noin 5 m [O]
VIRTA_VALI_H = 3               # aikaväli kartalle ja aikajanalle
VIRTA_HARVENNUS = 2            # joka toinen ruutu (~4 km) tiedoston koon vuoksi


def lahin_taso_indeksi(syvyydet, tavoite):
    return min(range(len(syvyydet)), key=lambda i: abs(float(syvyydet[i]) - tavoite))


def virta_taulukoiksi(u, v, kerroin=100.0):
    """u, v [aika][lat][lon] (m/s) -> kokonaisluvut cm/s, NaN -> None."""
    return [taulukko(u[i], kerroin) for i in range(len(u))], [taulukko(v[i], kerroin) for i in range(len(v))]


def hae_vesi(nyt, ulos_kansio):
    import numpy as np
    tulos = {"luotu": iso(nyt), "huom": "Copernicus BAL phy, 2 km malli; kapeat salmet eivät erotu. Ei navigointiin."}
    virheet = []
    # 1) lämpö: päiväkeskiarvot tästä päivästä 6 vrk, pinta ja pohja, täysi ruudukko (sisäsaariston ruudut säilyvät)
    try:
        ds = _avaa("cmems_mod_bal_phy_anfc_P1D-m", nyt.strftime("%Y-%m-%dT00:00:00"),
                   (nyt + dt.timedelta(days=5)).strftime("%Y-%m-%dT23:59:59"), minimum_depth=0, maximum_depth=1)
        vp = etsi_muuttuja(ds, {"sea_water_potential_temperature"}, ("thetao",))
        vb = etsi_muuttuja(ds, {"sea_water_potential_temperature_at_sea_floor"}, ("bottomt", "bottom_t"))
        if not vp and not vb:
            raise RuntimeError(f"lämpömuuttujia ei löytynyt: {list(ds.data_vars)}")
        lampo = {"dataset": "cmems_mod_bal_phy_anfc_P1D-m"}
        for avain, v in (("pinta", vp), ("pohja", vb)):
            if not v:
                continue
            da = ds[v]
            latn, lonn = _koordinaatit(da)
            for d in [d for d in da.dims if d not in ("time", latn, lonn)]:
                da = da.isel({d: 0})
            da = da.transpose("time", latn, lonn).load()
            lampo[avain] = [taulukko(da.isel(time=i).values, 10.0) for i in range(da.sizes["time"])]   # 0,1 °C
            lampo["ajat"] = [str(t)[:10] for t in da["time"].values]
            tulos["lat"] = [round(float(x), 4) for x in da[latn].values]
            tulos["lon"] = [round(float(x), 4) for x in da[lonn].values]
        tulos["lampo"] = lampo
        print(f"  lämpö: {len(lampo.get('ajat', []))} vrk, muuttujat {vp}, {vb}")
    except Exception as e:
        virheet.append(f"lämpö: {type(e).__name__}: {e}"[:300]); print(f"  lämpö: VIRHE {e}")
    # 2) virtaus: tunneittain, 3 h välein 48 h eteenpäin, kaksi syvyyttä
    try:
        alku = nyt.replace(minute=0, second=0) - dt.timedelta(hours=3)
        ds = _avaa("cmems_mod_bal_phy_anfc_PT1H-i", alku.strftime("%Y-%m-%dT%H:00:00"),
                   (alku + dt.timedelta(hours=54)).strftime("%Y-%m-%dT%H:00:00"), minimum_depth=0, maximum_depth=6)
        vu = etsi_muuttuja(ds, {"eastward_sea_water_velocity"}, ("uo",))
        vv = etsi_muuttuja(ds, {"northward_sea_water_velocity"}, ("vo",))
        if not vu or not vv:
            raise RuntimeError(f"virtausmuuttujia ei löytynyt: {list(ds.data_vars)}")
        du, dv = ds[vu], ds[vv]
        latn, lonn = _koordinaatit(du)
        syvn = next((d for d in du.dims if d not in ("time", latn, lonn)), None)
        ajat = du["time"].values
        valitut = [i for i, t in enumerate(ajat) if int(str(t)[11:13]) % VIRTA_VALI_H == 0]
        tasot, uu, vvv = [], [], []
        for tavoite in VIRTA_TASOT_M:
            if syvn:
                k = lahin_taso_indeksi(du[syvn].values, tavoite)
                tasot.append(round(float(du[syvn].values[k]), 2))
                a = du.isel({syvn: k, "time": valitut}); b = dv.isel({syvn: k, "time": valitut})
            else:
                tasot.append(0.0); a = du.isel(time=valitut); b = dv.isel(time=valitut)
            a = a.transpose("time", latn, lonn).isel({latn: slice(None, None, VIRTA_HARVENNUS), lonn: slice(None, None, VIRTA_HARVENNUS)}).load()
            b = b.transpose("time", latn, lonn).isel({latn: slice(None, None, VIRTA_HARVENNUS), lonn: slice(None, None, VIRTA_HARVENNUS)}).load()
            u_, v_ = virta_taulukoiksi(a.values, b.values)
            uu.append(u_); vvv.append(v_)
        tulos["virta"] = {"dataset": "cmems_mod_bal_phy_anfc_PT1H-i", "yksikko": "cm/s", "tasot_m": tasot,
                          "ajat": [str(ajat[i])[:16] + "Z" for i in valitut],
                          "lat": [round(float(x), 4) for x in a[latn].values], "lon": [round(float(x), 4) for x in a[lonn].values],
                          "u": uu, "v": vvv}
        print(f"  virta: {len(valitut)} aikaa, tasot {tasot} m, ruudukko {len(tulos['virta']['lat'])}x{len(tulos['virta']['lon'])}")
    except Exception as e:
        virheet.append(f"virta: {type(e).__name__}: {e}"[:300]); print(f"  virta: VIRHE {e}")
    if "lampo" not in tulos and "virta" not in tulos:
        raise RuntimeError(" | ".join(virheet))
    if virheet:
        tulos["virheet"] = virheet
    polku = os.path.join(ulos_kansio, "vesi.json")
    with open(polku, "w", encoding="utf-8") as f:
        json.dump(tulos, f, ensure_ascii=False, separators=(",", ":"))
    kt = round(os.path.getsize(polku) / 1024)
    print(f"  kirjoitettu {polku}: {kt} kt")
    return {"polku": "data/vesi.json", "kt": kt, "lampo": "lampo" in tulos, "virta": "virta" in tulos, "virheet": virheet}


# ---------------------------------------------------------------- syvyyskäyrät (Traficom, hae_syvyys.py)

def hae_syvyydet(data_kansio):
    """Merilohitutkan hae_syvyys.paivita jokaiselle osa-alueelle. Alle 30 vrk vanha julkaistu tiedosto käytetään
    sellaisenaan, joten Traficomin rajapintaa kuormitetaan vain kerran kuussa."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import hae_syvyys
    tulos = []
    for a in SYVYYS_ALUEET:
        kansio = os.path.join(data_kansio, "syvyys", a["nimi"])
        os.makedirs(kansio, exist_ok=True)
        print(f"  {a['nimi']} ({a['otsikko']})")
        tila = hae_syvyys.paivita(kansio, f"{SIVU}data/syvyys/{a['nimi']}/", loki=lambda s: print("    " + str(s)),
                                  alue=a["alue"])
        rivi = dict(a, polku=f"data/syvyys/{a['nimi']}/syvyys.json", **(tila or {}))
        polku = os.path.join(kansio, "syvyys.json")
        if os.path.exists(polku):
            rivi["kt"] = round(os.path.getsize(polku) / 1024)
        else:
            rivi["polku"] = None
        tulos.append(rivi)
    if not any(r.get("tila") in ("ok", "vanha") for r in tulos):
        raise RuntimeError("yhdenkään osa-alueen syvyyskäyrät eivät onnistuneet: "
                           + " | ".join(str(r.get("viesti", "")) for r in tulos)[:400])
    return tulos


def hae_vaylat_alueet(data_kansio):
    """Väyläviraston väylät ja turvalaitteet (merilohitutkan hae_vaylat.py) samoille osa-alueille kuin syvyyskäyrät.
    Alle 30 vrk vanha julkaistu tiedosto käytetään sellaisenaan."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import hae_vaylat
    tulos = []
    for a in SYVYYS_ALUEET + VAYLA_LISA_ALUEET:
        kansio = os.path.join(data_kansio, "vaylat", a["nimi"])
        os.makedirs(kansio, exist_ok=True)
        print(f"  {a['nimi']} ({a['otsikko']})")
        tila = hae_vaylat.paivita(kansio, f"{SIVU}data/vaylat/{a['nimi']}/", loki=lambda s: print("    " + str(s)), alue=a["alue"])
        rivi = dict(a, polku=f"data/vaylat/{a['nimi']}/vaylat.json", **(tila or {}))
        polku = os.path.join(kansio, "vaylat.json")
        if os.path.exists(polku):
            rivi["kt"] = round(os.path.getsize(polku) / 1024)
        else:
            rivi["polku"] = None
        tulos.append(rivi)
    if not any(r.get("tila") in ("ok", "vanha") for r in tulos):
        raise RuntimeError("yhdenkään osa-alueen väylät eivät onnistuneet: "
                           + " | ".join(str(r.get("viesti", "")) for r in tulos)[:400])
    return tulos


# ---------------------------------------------------------------- järvien vedenkorkeus (SYKE Hydrologiarajapinta)

def syke_json(polku, params=None):
    """Kokeilee rajapintaversiot järjestyksessä; ensimmäinen toimiva lukitaan tämän ajon ajaksi."""
    global _SYKE_TOIMIVA
    virheet = []
    for base in ([_SYKE_TOIMIVA] if _SYKE_TOIMIVA else SYKE_HYDRO_OSOITTEET):
        try:
            d = syke_json_osoitteesta(base, polku, params)
            if _SYKE_TOIMIVA != base:
                print(f"    SYKE-rajapinta: {base}")
            _SYKE_TOIMIVA = base
            return d
        except Exception as e:
            virheet.append(f"{base.rstrip('/').split('/')[-2]}: {e}"[:220])
    raise RuntimeError(" | ".join(virheet))


def syke_json_osoitteesta(base, polku, params=None):
    """OData JSON. 24.11.2026 ensimmäinen ajo: kaikki järvet epäonnistuivat, syy ei näkynyt (vain lokissa).
    Pyydetään JSON Accept-otsakkeella; jos vastaus ei ole JSONia, uudelleen $format=json. Virheeseen alku vastauksesta."""
    def hae(pp):
        url = base + polku + ("?" + urllib.parse.urlencode(pp, quote_via=urllib.parse.quote, safe="$") if pp else "")
        return http_get(url, yrityksia=2, aikaraja=60, otsakkeet={"Accept": "application/json"})
    raaka = hae(params)
    try:
        return json.loads(raaka)
    except ValueError:
        alku = raaka[:160].decode("utf-8", "replace").replace("\n", " ")
        if params and "$format" in params:
            raise RuntimeError(f"ei JSON-vastaus: {alku}")
        raaka2 = hae(dict(params or {}, **{"$format": "json"}))
        try:
            return json.loads(raaka2)
        except ValueError:
            raise RuntimeError(f"ei JSON-vastaus ({polku}): {alku}")


def syke_sivut(polku, params, enint=30000):
    """OData-sivutus: seuraa odata.nextLinkiä, muuten $skip."""
    out, skip, top = [], 0, int(params.get("$top", 1000))
    while True:
        d = syke_json(polku, dict(params, **{"$skip": skip}) if skip else params)
        v = d.get("value", [])
        out += v
        seuraava = d.get("odata.nextLink") or d.get("@odata.nextLink")
        if seuraava and len(out) < enint:
            skip = len(out)
            continue
        if len(v) < top or len(out) >= enint:
            return out
        skip += len(v)


def syke_asema(j, loki=print):
    """-> {id, nimi, tila}. Tunnettu id tarkistetaan, muuten haetaan nimellä (vedenkorkeus = Suure_Id 1)."""
    if j.get("syke_id"):
        try:
            v = syke_json("Paikka", {"$filter": f"Paikka_Id eq {j['syke_id']}"}).get("value", [])
            if v:
                return {"id": v[0]["Paikka_Id"], "nimi": v[0].get("Nimi"), "tila": v[0].get("Tila_Id"), "kentat": _kentat(v[0])}
            loki(f"    asemaa {j['syke_id']} ei löytynyt, haetaan nimellä")
        except Exception as e:
            loki(f"    aseman {j['syke_id']} tarkistus epäonnistui ({e}) – käytetään silti")
            return {"id": j["syke_id"], "nimi": None, "tila": None}
    v = syke_json("Paikka", {"$filter": f"substringof('{j['haku']}', Nimi) and Suure_Id eq 1"}).get("value", [])
    loki(f"    ehdokkaat: " + "; ".join(f"{x.get('Paikka_Id')} {x.get('Nimi')} (tila {x.get('Tila_Id')})" for x in v)[:600])
    if not v:
        raise RuntimeError(f"vedenkorkeusasemaa ei löytynyt nimellä {j['haku']}")
    v.sort(key=lambda x: (x.get("Tila_Id") != 1, "tekojärvi" not in str(x.get("Nimi", "")).lower(), x.get("Paikka_Id")))
    return {"id": v[0]["Paikka_Id"], "nimi": v[0].get("Nimi"), "tila": v[0].get("Tila_Id"), "kentat": _kentat(v[0])}


def _kentat(rec):
    """Aseman yksinkertaiset kentät talteen (korkeusjärjestelmän selvittämiseksi, 24.11.2026)."""
    return {k: v for k, v in rec.items() if not isinstance(v, (dict, list)) and not str(k).startswith("odata")}


def tasokorjaus(t):
    """VedenkTasoTieto-vastaus -> Tasokorjaus (cm) tai None; vastaus voi olla olio tai {"value": [...]}."""
    if isinstance(t, dict) and isinstance(t.get("value"), list):
        t = t["value"][0] if t["value"] else {}
    if isinstance(t, dict):
        for k, v in t.items():
            if str(k).lower() == "tasokorjaus" and isinstance(v, (int, float)):
                return v
    return None


def jarvi_paivat(rivit):
    """SYKE-rivit -> {päivä: arvo cm}; sama päivä useasti -> viimeisin."""
    out = {}
    for r in rivit:
        a, v = r.get("Aika"), r.get("Arvo")
        if a is None or v is None:
            continue
        out[str(a)[:10]] = round(float(v), 1)
    return out


def jarvi_historia(paivat, nyt):
    """Aiempien vuosien päivittäiset min / mediaani / max (avain KK-PP) ja kesän (15.6.–31.8.) mediaani."""
    raja = (nyt - dt.timedelta(days=330)).strftime("%Y-%m-%d")
    kertyma, kesa = {}, []
    for d, v in paivat.items():
        if d >= raja:
            continue
        kertyma.setdefault(d[5:], []).append(v)
        if "06-15" <= d[5:] <= "08-31":
            kesa.append(v)
    def med(a):
        a = sorted(a); n = len(a)
        return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2
    pv = {k: [min(a), round(med(a), 1), max(a), len(a)] for k, a in sorted(kertyma.items()) if len(a) >= 2}
    return {"pv": pv, "kesa_med_cm": round(med(kesa), 1) if kesa else None, "vuosia": len({d[:4] for d in paivat if d < raja}),
            "sarja": jarvi_sarja(paivat)}


def jarvi_sarja(paivat):
    """Koko päiväsarja tiiviisti {alku, cm: [..]} (puuttuva päivä = None). v006 (Hannu 24.11.2026): Lowrance-tallenteiden
    vedenkorkeuskorjaus tarvitsee tallennuspäivän vedenkorkeuden, myös yli 120 vrk vanhoille tallenteille."""
    if not paivat:
        return None
    pv = sorted(paivat)
    a, b = dt.date.fromisoformat(pv[0]), dt.date.fromisoformat(pv[-1])
    cm, d = [], a
    while d <= b:
        v = paivat.get(d.isoformat())
        cm.append(None if v is None else int(round(v)))
        d += dt.timedelta(days=1)
    return {"alku": pv[0], "cm": cm}


def hae_jarvet(nyt, vanha):
    vanhat = {j.get("tunnus"): j for j in (vanha or []) if isinstance(j, dict)}
    out, onnistui = [], 0
    for j in JARVET:
        print(f"  {j['nimi']}")
        rivi = {k: j[k] for k in ("tunnus", "nimi", "lat", "lon")}
        ed = vanhat.get(j["tunnus"]) or {}
        try:
            asema = syke_asema(j, loki=print)
            rivi["asema"] = asema
            # Korkeusjärjestelmä (Hannu 24.11.: Hirvijärven luotauskartta tehty peruskartan pinnasta 88,7 m) -> molemmat järjestelmät
            rivi["tasotieto"] = {}
            for jarj, avain in (("N60", "tasokorjaus_cm"), ("N2000", "tasokorjaus_n2000_cm")):
                try:
                    t = syke_json(f"VedenkTasoTieto(Paikka_Id={asema['id']},TasoKoordinaatisto='{jarj}')", {"$format": "json"})
                    rivi[avain] = tasokorjaus(t)
                    rivi["tasotieto"][jarj] = json.dumps(t, ensure_ascii=False)[:400]
                except Exception as e:
                    rivi[avain] = ed.get(avain); rivi["tasotieto"][jarj] = f"virhe: {e}"[:200]
                print(f"    tasotieto {jarj}: {rivi['tasotieto'][jarj][:200]}")
            tuore = jarvi_paivat(syke_sivut("Vedenkorkeus", {
                "$filter": f"Paikka_Id eq {asema['id']} and Aika ge datetime'{(nyt - dt.timedelta(days=JARVI_TUORE_VRK)):%Y-%m-%d}T00:00:00'",
                "$orderby": "Aika asc", "$top": 1000}))
            rivi["paivat"] = sorted(tuore.items())
            hist = ed.get("historia")
            ika = 999
            if hist and hist.get("luotu"):
                try:
                    ika = (nyt - dt.datetime.fromisoformat(hist["luotu"].replace("Z", "+00:00"))).days
                except Exception:
                    ika = 999
            if not hist or ika >= JARVI_HISTORIA_UUSINTA_VRK or (ed.get("asema") or {}).get("id") != asema["id"] or "sarja" not in hist:
                kaikki = jarvi_paivat(syke_sivut("Vedenkorkeus", {
                    "$filter": f"Paikka_Id eq {asema['id']} and Aika ge datetime'{nyt.year - JARVI_HISTORIA_VUODET}-01-01T00:00:00'",
                    "$orderby": "Aika asc", "$top": 1000}))
                hist = dict(jarvi_historia(kaikki, nyt), luotu=iso(nyt))
                print(f"    historia: {len(kaikki)} vrk, {hist['vuosia']} vuotta, kesän mediaani {hist['kesa_med_cm']} cm")
            rivi["historia"] = hist
            osat = (_SYKE_TOIMIVA or "").rstrip("/").split("/")
            rivi["rajapinta"] = osat[-2] if len(osat) >= 2 else None
            viim = rivi["paivat"][-1] if rivi["paivat"] else None
            print(f"    asema {asema['id']} {asema.get('nimi')}: {len(rivi['paivat'])} vrk, viimeisin {viim}, tasokorjaus {rivi.get('tasokorjaus_cm')}")
            onnistui += 1
        except Exception as e:
            print(f"    VIRHE {e}")
            rivi["virhe"] = f"{type(e).__name__}: {e}"[:300]
            for k in ("asema", "tasokorjaus_cm", "paivat", "historia"):
                if k in ed:
                    rivi[k] = ed[k]
            if ed.get("paivat"):
                rivi["edellinen"] = True
        out.append(rivi)
    if onnistui == 0 and not any(r.get("paivat") for r in out):
        raise RuntimeError("yhdenkään järven vedenkorkeus ei onnistunut: " + " | ".join(f"{r['nimi']}: {r.get('virhe')}" for r in out)[:450])
    return out


# ---------------------------------------------------------------- 7. tilasto

def kaudet(nyt, ensimmainen=2011):
    """Talvikaudet joulu–huhti, nimetty päättymisvuodella. Vain päättyneet kaudet."""
    viimeinen = nyt.year if nyt.month > 4 else nyt.year - 1
    for y in range(ensimmainen, viimeinen + 1):
        yield y, dt.datetime(y - 1, 12, 1, tzinfo=dt.timezone.utc), dt.datetime(y, 5, 1, tzinfo=dt.timezone.utc)


def hae_jakso_mareografit(alku, loppu):
    try:
        return fmi_hae("fmi::observations::mareograph::simple", {
            "starttime": iso(alku), "endtime": iso(loppu), "timestep": 60,
            "parameters": "WLEVN2K_PT1S_INSTANT"})
    except RuntimeError:
        if loppu - alku > dt.timedelta(hours=48):  # liian pitkä jakso? puolitetaan
            puoli = alku + (loppu - alku) / 2
            return hae_jakso_mareografit(alku, puoli) + hae_jakso_mareografit(puoli, loppu)
        raise


def laske_tilasto(nyt):
    asemat = {m["nimi"]: {"nimi": m["nimi"], "lat": m["lat"], "lon": m["lon"], "kaudet": []} for m in MAREOGRAFIT}
    for vuosi, alku, loppu in kaudet(nyt):
        tunnit = {m["nimi"]: {} for m in MAREOGRAFIT}
        puuttuvia = 0
        t = alku
        while t < loppu:
            t2 = min(t + dt.timedelta(hours=167), loppu)
            try:
                g = ryhmittele(hae_jakso_mareografit(t, t2))
                for m in MAREOGRAFIT:
                    k = lahin(g.keys(), m["lat"], m["lon"], MAREOGRAFI_MAX_KM)
                    if k is None:
                        continue
                    for aika, v in g[k].get("WLEVN2K_PT1S_INSTANT", []):
                        if v is not None and abs(v) < 4000:
                            tunnit[m["nimi"]][aika] = v / 10.0  # mm -> cm
            except Exception as e:
                puuttuvia += 1
                print(f"  {iso(t)}: VIRHE {e}")
            t = t2
            time.sleep(0.4)
        for nimi, sarja in tunnit.items():
            maksimit = vrk_maksimit(sorted(sarja.items()))
            asemat[nimi]["kaudet"].append({"kausi": f"{vuosi - 1}–{vuosi}", "tunteja": len(sarja),
                                           "vrk_max_cm": maksimit})
            print(f"  {nimi} {vuosi - 1}–{vuosi}: {len(sarja)} tuntia, {len(maksimit)} vrk"
                  + (f", {puuttuvia} jaksoa epäonnistui" if puuttuvia else ""))
    return {"laskettu": iso(nyt), "suure": "vuorokauden maksimi, cm N2000 (WLEVN2K_PT1S_INSTANT)",
            "asemat": list(asemat.values())}


# ---------------------------------------------------------------- pääohjelma

def lue_json(polku):
    if not polku or not os.path.exists(polku):
        return {}
    try:
        with open(polku, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"::warning::edellistä dataa ei voitu lukea: {e}")
        return {}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Pilkkitutka – hakuajo")
    ap.add_argument("ulos")
    ap.add_argument("--edellinen", default=None)
    ap.add_argument("--tilasto", action="store_true", help="laske mareografien talvitilasto (hidas)")
    args = ap.parse_args(argv)

    nyt = nyt_utc()
    ed = lue_json(args.edellinen)
    data = {"versio": VERSIO, "haettu": iso(nyt), "alue": ALUE, "pisteet": PISTEET,
            "mareografit_maaritys": MAREOGRAFIT, "tila": {}}

    def vaihe(nimi, fn, varalla=None):
        print(f"===== {nimi}")
        t0 = time.time()
        try:
            arvo = fn()
            data["tila"][nimi] = {"ok": True, "s": round(time.time() - t0)}
            return arvo
        except Exception as e:
            viesti = f"{type(e).__name__}: {e}"[:500]
            print(f"::warning::{nimi}: {viesti}")
            data["tila"][nimi] = {"ok": False, "virhe": viesti, "s": round(time.time() - t0)}
            if varalla is not None:
                data["tila"][nimi]["edellinen_kaytossa"] = ed.get("haettu")
            return varalla

    data["mareografit"] = vaihe("mareografit", lambda: hae_mareografit(nyt), ed.get("mareografit"))
    data["vk_ennuste"] = vaihe("vk_ennuste", lambda: hae_vk_ennuste(nyt), ed.get("vk_ennuste"))
    data["saa"] = vaihe("saa", lambda: hae_saa(nyt), ed.get("saa"))
    data["lampohistoria"] = vaihe("lampohistoria", lambda: hae_lampohistoria(nyt, ed.get("lampohistoria")),
                                  ed.get("lampohistoria"))
    data["jaa_malli"] = vaihe("jaa_malli", lambda: hae_jaa_malli(nyt), ed.get("jaa_malli"))
    data["jaakartta"] = vaihe("jaakartta", lambda: hae_jaakartta(nyt), ed.get("jaakartta"))
    data["syvyys_alueet"] = vaihe("syvyys", lambda: hae_syvyydet(os.path.dirname(os.path.abspath(args.ulos))),
                                  ed.get("syvyys_alueet"))
    data["vaylat_alueet"] = vaihe("vaylat", lambda: hae_vaylat_alueet(os.path.dirname(os.path.abspath(args.ulos))),
                                  ed.get("vaylat_alueet"))
    # epäonnistuessa työnkulku on jo kopioinut edellisen vesi.json:n paikalleen -> viittaus edelliseen
    data["vesi"] = vaihe("vesi", lambda: hae_vesi(nyt, os.path.dirname(os.path.abspath(args.ulos))), ed.get("vesi"))
    data["jarvet"] = vaihe("jarvet", lambda: hae_jarvet(nyt, ed.get("jarvet")), ed.get("jarvet"))
    if args.tilasto:
        data["vk_tilasto"] = vaihe("vk_tilasto", lambda: laske_tilasto(nyt), ed.get("vk_tilasto"))
    else:
        data["vk_tilasto"] = ed.get("vk_tilasto")
        data["tila"]["vk_tilasto"] = {"ok": data["vk_tilasto"] is not None, "kantaa_edellisesta": True}

    os.makedirs(os.path.dirname(os.path.abspath(args.ulos)), exist_ok=True)
    with open(args.ulos, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    koko = os.path.getsize(args.ulos) / 1024
    ok = sum(1 for t in data["tila"].values() if t.get("ok"))
    print(f"Kirjoitettu {args.ulos}: {koko:.0f} kt, vaiheita ok {ok}/{len(data['tila'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
