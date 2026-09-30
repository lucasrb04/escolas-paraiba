# /// script
# requires-python = ">=3.10"
# dependencies = ["openpyxl", "pyshp"]
# ///
"""
Converte "Levantamento de dados.xlsx" (Censo Escolar/INEP, abas 2007..2025)
nos arquivos estáticos consumidos pelo mapa em ../data/.

Uso (a partir da raiz do site):
    uv run scripts/build_data.py
  ou
    pip install openpyxl pyshp && python3 scripts/build_data.py

Saídas:
    data/escolas_campo.geojson               1 ponto por escola que foi rural em algum ano
    data/regioes_pb.geojson                  municípios da PB (IBGE) com meso/microrregião etc.
    data/assentamentos_reforma_agraria.geojson  projetos de assentamento (INCRA/SIGEF)
    data/resumo_anual.json                   totais por ano (para conferência)
    data/indicadores.json                    séries e rankings usados no texto/gráficos da página

COORDENADAS: a planilha não traz latitude/longitude. Se existir
scripts/fontes/coordenadas_escolas.csv (ex.: exportado do Catálogo de Escolas
do INEP, com colunas "Código INEP"/CO_ENTIDADE + Latitude + Longitude), essas
coordenadas são usadas. Escolas sem coordenada recebem um ponto aproximado,
determinístico, dentro do polígono do seu município (propriedade coord="aproximada").
"""
import csv
import json
import random
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl
import shapefile

ROOT = Path(__file__).resolve().parent.parent
FONTES = ROOT / "scripts" / "fontes"
OUT = ROOT / "data"
XLSX = ROOT / "Levantamento de dados.xlsx"
ANOS = list(range(2007, 2026))

# Colunas das abas anuais (layout do Censo Escolar)
COL = {"ano": 0, "municipio": 1, "co_municipio": 2, "nome": 3, "id": 4,
       "dependencia": 5, "localizacao": 7, "loc_dif": 8, "situacao": 9}


def norm(s):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- municípios
def carregar_municipios():
    malha = json.loads((FONTES / "ibge_malha_municipios_pb.geojson").read_text())
    info = {m["id"]: m for m in json.loads((FONTES / "ibge_municipios_pb.json").read_text())}
    feats = []
    for f in malha["features"]:
        cod = int(f["properties"]["codarea"])
        m = info[cod]
        micro = m["microrregiao"]
        imed = m["regiao-imediata"]
        f["properties"] = {
            "co_municipio": cod,
            "municipio": m["nome"],
            "mesorregiao": micro["mesorregiao"]["nome"],
            "microrregiao": micro["nome"],
            "regiao_imediata": imed["nome"],
            "regiao_intermediaria": imed["regiao-intermediaria"]["nome"],
        }
        feats.append(f)
    return feats


def aneis(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return polys


def ponto_no_poligono(x, y, poly):
    dentro = False
    for anel in poly:
        n = len(anel)
        for i in range(n):
            x1, y1 = anel[i]
            x2, y2 = anel[(i + 1) % n]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                dentro = not dentro
    return dentro


def ponto_aleatorio(geom, seed):
    rnd = random.Random(seed)
    polys = aneis(geom)
    xs = [p[0] for poly in polys for p in poly[0]]
    ys = [p[1] for poly in polys for p in poly[0]]
    for _ in range(500):
        x, y = rnd.uniform(min(xs), max(xs)), rnd.uniform(min(ys), max(ys))
        if any(ponto_no_poligono(x, y, poly) for poly in polys):
            return round(x, 5), round(y, 5)
    return round(sum(xs) / len(xs), 5), round(sum(ys) / len(ys), 5)


# ---------------------------------------------------------------- coordenadas
def carregar_coordenadas():
    arq = FONTES / "coordenadas_escolas.csv"
    if not arq.exists():
        return {}
    texto = arq.read_text(encoding="utf-8-sig", errors="replace")
    dialect = csv.Sniffer().sniff(texto[:4000], delimiters=",;\t")
    coords = {}
    for row in csv.DictReader(texto.splitlines(), dialect=dialect):
        r = {norm(k): v for k, v in row.items() if k}
        cod = to_int(r.get("COENTIDADE") or r.get("CODIGOINEP") or r.get("CODINEP"))
        try:
            lat = float(str(r.get("LATITUDE", "")).replace(",", "."))
            lon = float(str(r.get("LONGITUDE", "")).replace(",", "."))
        except ValueError:
            continue
        if cod and -9 < lat < -5.5 and -39 < lon < -34.5:
            coords[cod] = (round(lon, 6), round(lat, 6))
    print(f"coordenadas_escolas.csv: {len(coords)} escolas com coordenadas válidas")
    return coords


# ---------------------------------------------------------------- escolas
def carregar_escolas():
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    esc = {}
    # escolas em funcionamento por ano, localização e rede (como na aba ANÁLISES)
    agregado = {a: Counter() for a in ANOS}
    for i, ano in enumerate(ANOS):
        ws = wb[str(ano)]
        for row in ws.iter_rows(min_row=2, values_only=True):
            cod = to_int(row[COL["id"]])
            if cod is None:
                continue
            e = esc.setdefault(cod, {"sit": ["0"] * len(ANOS), "rural": ["0"] * len(ANOS)})
            # dados cadastrais: o registro mais recente prevalece
            e["nome"] = str(row[COL["nome"]]).strip()
            e["municipio"] = row[COL["municipio"]]
            e["co_municipio"] = to_int(row[COL["co_municipio"]])
            e["dependencia"] = to_int(row[COL["dependencia"]])
            dif = to_int(row[COL["loc_dif"]])
            if dif:
                e.setdefault("loc_dif", set()).add(dif)
            e["sit"][i] = str(to_int(row[COL["situacao"]]) or 0)
            e["rural"][i] = "1" if to_int(row[COL["localizacao"]]) == 2 else "0"
            loc = "rural" if e["rural"][i] == "1" else "urbana"
            agregado[ano][(loc, e["sit"][i], e["dependencia"])] += 1
        print(f"  aba {ano} lida")
    return esc, agregado


def main():
    OUT.mkdir(exist_ok=True)
    municipios = carregar_municipios()
    geom_mun = {f["properties"]["co_municipio"]: f["geometry"] for f in municipios}
    mun_por_nome = {norm(f["properties"]["municipio"]): f["properties"]["co_municipio"] for f in municipios}
    coords = carregar_coordenadas()

    print("Lendo planilha (pode levar ~1 min)...")
    esc, agregado = carregar_escolas()

    feats, resumo = [], {a: Counter() for a in ANOS}
    nunca_ativas = 0
    for cod, e in esc.items():
        if "1" not in e["rural"]:
            continue  # nunca foi escola do campo
        sit, rural = "".join(e["sit"]), "".join(e["rural"])
        ativos = [i for i in range(len(ANOS)) if sit[i] == "1" and rural[i] == "1"]
        if not ativos:
            # Nunca funcionou como escola rural na série (ex.: ~1.000 cadastros que surgem
            # em 2011 já paralisados). Não é um fechamento ocorrido no período.
            nunca_ativas += 1
            continue
        for i, a in enumerate(ANOS):
            if rural[i] == "1":
                resumo[a][{"1": "ativas", "2": "paralisadas"}.get(sit[i], "extintas")] += 1

        ultimo = ANOS[ativos[-1]]
        fechamento = ultimo + 1 if ultimo < ANOS[-1] else None

        if cod in coords:
            lon, lat = coords[cod]
            origem = "inep"
        else:
            lon, lat = ponto_aleatorio(geom_mun[e["co_municipio"]], cod)
            origem = "aproximada"

        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "id": cod,
                "nome": e["nome"],
                "municipio": e["municipio"],
                "co_municipio": e["co_municipio"],
                "dependencia": e["dependencia"],
                "loc_dif": sorted(e.get("loc_dif", [])),
                # 1 caractere por ano (2007..2025): 0=ausente 1=ativa 2=paralisada 3/4=extinta
                "sit": sit,
                # 1 caractere por ano: 1=rural 0=urbana/ausente
                "rural": rural,
                "ultimo_ano_ativa": ultimo,
                "ano_fechamento": fechamento,
                "coord": origem,
            },
        })

    dump(OUT / "escolas_campo.geojson", {"type": "FeatureCollection", "anos": ANOS, "features": feats})
    dump(OUT / "regioes_pb.geojson", {"type": "FeatureCollection", "features": municipios})
    dump(OUT / "resumo_anual.json", {a: dict(c) for a, c in resumo.items()})
    assentamentos = gerar_assentamentos(mun_por_nome)
    gerar_indicadores(feats, agregado, municipios, assentamentos)

    print(f"\n{len(feats)} escolas do campo exportadas; {nunca_ativas} cadastros nunca ativos ignorados "
          f"({sum(1 for f in feats if f['properties']['coord'] == 'inep')} com coordenada INEP)")
    for a in (2007, 2016, 2025):
        print(f"  {a}: {dict(resumo[a])}")


# Grafias do INCRA que diferem do nome oficial do IBGE
ALIAS_MUNICIPIO = {"SAODOMINGOSDEPOMBAL": "SAODOMINGOS", "SERIDO": "SAOVICENTEDOSERIDO"}


def gerar_assentamentos(mun_por_nome):
    r = shapefile.Reader(str(FONTES / "incra" / "Assentamento Brasil_PB"), encoding="latin1")
    feats = []
    for sr in r.iterShapeRecords():
        d = sr.record.as_dict()
        geom = sr.shape.__geo_interface__
        feats.append({
            "type": "Feature",
            "geometry": arredondar(geom),
            "properties": {
                "cd_sipra": d["cd_sipra"],
                "nome": d["nome_proje"],
                "municipio": d["municipio"],
                "co_municipio": mun_por_nome.get(ALIAS_MUNICIPIO.get(norm(d["municipio"]), norm(d["municipio"]))),
                "area_ha": to_float(d["area_hecta"]),
                "capacidade": d["capacidade"],
                "familias": d["num_famili"],
                "fase": d["fase"],
                "data_criacao": d["data_de_cr"],
                "forma_obtencao": d["forma_obte"],
                # Vinculação ao MST não consta na base do INCRA: preencher no QGIS
                # (true/false) para que o mapa destaque esses assentamentos.
                "mst": None,
            },
        })
    dump(OUT / "assentamentos_reforma_agraria.geojson", {"type": "FeatureCollection", "features": feats})
    sem_mun = [f["properties"]["municipio"] for f in feats if not f["properties"]["co_municipio"]]
    print(f"{len(feats)} assentamentos exportados; sem município casado: {sem_mun}")
    return feats


# ---------------------------------------------------------------- indicadores
REDES = {1: "federal", 2: "estadual", 3: "municipal", 4: "privada"}


def gerar_indicadores(feats, agregado, municipios, assentamentos):
    n = len(ANOS)
    P = [f["properties"] for f in feats]
    ativa = lambda p, i: p["sit"][i] == "1" and p["rural"][i] == "1"
    info_mun = {m["properties"]["co_municipio"]: m["properties"] for m in municipios}

    def serie(filtro=lambda p: True):
        return [sum(1 for p in P if filtro(p) and ativa(p, i)) for i in range(n)]

    def funcionando(loc, dep=None):
        return [sum(v for (l, s, d), v in agregado[a].items()
                    if l == loc and s == "1" and (dep is None or d == dep)) for a in ANOS]

    # municípios
    por_mun = defaultdict(lambda: [0] * n)
    for p in P:
        for i in range(n):
            por_mun[p["co_municipio"]][i] += ativa(p, i)
    municipios_out = [{
        "co": co, "nome": info_mun[co]["municipio"], "meso": info_mun[co]["mesorregiao"],
        "ini": s[0], "fim": s[-1],
    } for co, s in por_mun.items() if s[0]]

    meso = defaultdict(lambda: [0] * n)
    for co, s in por_mun.items():
        for i in range(n):
            meso[info_mun[co]["mesorregiao"]][i] += s[i]

    com_assent = {f["properties"]["co_municipio"] for f in assentamentos}

    # tempo entre o último ano ativa e a extinção formal (TP_SITUACAO 3) no Censo
    latencias = []
    for p in P:
        if "3" in p["sit"] and p["ultimo_ano_ativa"]:
            ext = ANOS[p["sit"].index("3")]
            if ext > p["ultimo_ano_ativa"]:
                latencias.append(ext - p["ultimo_ano_ativa"])
    latencias.sort()

    reabertas = sum(1 for p in P if any(
        p["sit"][i] != "1" and p["sit"][i - 1] == "1" and "1" in p["sit"][i + 1:] for i in range(1, n)))

    ind = {
        "anos": ANOS,
        "rurais": funcionando("rural"),
        "urbanas": funcionando("urbana"),
        "rurais_por_rede": {nome: funcionando("rural", d) for d, nome in REDES.items()},
        "rurais_paralisadas": [sum(v for (l, s, d), v in agregado[a].items() if l == "rural" and s == "2") for a in ANOS],
        "rurais_extintas": [sum(v for (l, s, d), v in agregado[a].items() if l == "rural" and s == "3") for a in ANOS],
        "mesorregioes": dict(meso),
        "municipios": sorted(municipios_out, key=lambda m: m["fim"] - m["ini"]),
        "area_assentamento": serie(lambda p: 1 in p["loc_dif"]),
        "mun_com_assentamento": [sum(por_mun[c][i] for c in por_mun if c in com_assent) for i in range(n)],
        "mun_sem_assentamento": [sum(por_mun[c][i] for c in por_mun if c not in com_assent) for i in range(n)],
        "n_mun_com_assentamento": len(com_assent),
        "familias_assentadas": sum(f["properties"]["familias"] or 0 for f in assentamentos),
        "n_assentamentos": len(assentamentos),
        "reabertas": reabertas,
        "latencia_extincao_mediana": latencias[len(latencias) // 2] if latencias else None,
        "n_extintas_apos_paralisacao": len(latencias),
    }
    dump(OUT / "indicadores.json", ind)


def to_float(v):
    try:
        return round(float(str(v).replace(",", ".")), 2)
    except ValueError:
        return None


def arredondar(g):
    def rec(c):
        return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], float) else [rec(x) for x in c]
    return {"type": g["type"], "coordinates": rec(g["coordinates"])}


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"-> {path.relative_to(ROOT)} ({path.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
