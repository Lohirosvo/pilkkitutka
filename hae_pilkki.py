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

VERSIO = "v002"
UA = "pilkkitutka/v002 (+https://lohirosvo.github.io/pilkkitutka/)"
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
LAMPOPAIKAT = ["Maalahti", "Vaasa", "Kaskinen"]

SAA_PARAMS = "Temperature,WindSpeedMS,WindGust,WindDirection,PrecipitationAmount,TotalCloudCover,Pressure"
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


def http_get(url, yrityksia=3, aikaraja=90):
    viimeisin = "tuntematon virhe"
    for i in range(yrityksia):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
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
    for p in PISTEET:
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
            out.append({"nimi": p["nimi"], "lat_lahde": k[0], "lon_lahde": k[1], "ajat": ajat,
                        "T": tasaa("Temperature"), "ws": tasaa("WindSpeedMS"), "wg": tasaa("WindGust"),
                        "wd": tasaa("WindDirection", 0), "sade": sade, "sade_tulkinta": tulkinta,
                        "pilvi": tasaa("TotalCloudCover", 0), "paine": tasaa("Pressure")})
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


def _avaa(ds_id, alku, loppu):
    import copernicusmarine  # asennetaan työnkulussa
    return copernicusmarine.open_dataset(
        dataset_id=ds_id,
        minimum_longitude=ALUE["lon_min"], maximum_longitude=ALUE["lon_max"],
        minimum_latitude=ALUE["lat_min"], maximum_latitude=ALUE["lat_max"],
        start_datetime=alku, end_datetime=loppu)


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
