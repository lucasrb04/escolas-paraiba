# Observatório Paraibano das Escolas do Campo

Mapa interativo (Leaflet + canvas) do fechamento das escolas do campo na Paraíba, 2007–2025.

## Rodar localmente

```bash
python3 -m http.server 8000   # na raiz do site
# abrir http://localhost:8000
```

(Abrir o `index.html` direto do disco não funciona: o navegador bloqueia `fetch` de arquivos locais.)

## Estrutura

```
index.html  style.css              relatório (texto + gráficos) com o mapa ao final
charts.js                            gráficos do relatório (lê data/indicadores.json)
app.js                               mapa (Leaflet + canvas)
data/                                GeoJSON consumidos pelo mapa (caminhos em CONFIG.dados no app.js)
  escolas_campo.geojson
  assentamentos_reforma_agraria.geojson
  regioes_pb.geojson
  resumo_anual.json                  totais por ano, para conferência
  indicadores.json                   séries e rankings usados nos gráficos do texto
scripts/build_data.py                converte a planilha → data/
scripts/fontes/                      malha IBGE (municípios PB) e shapefile INCRA (assentamentos PB)
```

## Regerar os dados

```bash
uv run scripts/build_data.py
# ou: pip install openpyxl pyshp && python3 scripts/build_data.py
```

O script lê as abas `2007`…`2025` de `Levantamento de dados.xlsx` (colunas do Censo Escolar) e
exporta toda escola que foi rural (`TP_LOCALIZACAO = 2`) em pelo menos um ano. Cada escola leva a
situação ano a ano em uma string de 19 caracteres, o que permite ao slider trocar de ano sem
recarregar nada.

### Coordenadas das escolas

A planilha **não tem latitude/longitude**. Enquanto não houver coordenadas, cada escola é posicionada
num ponto aproximado (determinístico) dentro do seu município, com `coord: "aproximada"`.

Para posições reais, salve `scripts/fontes/coordenadas_escolas.csv` com as colunas
`CO_ENTIDADE` (ou `Código INEP`), `Latitude` e `Longitude` — por exemplo, exportado do
Catálogo de Escolas do INEP ou do QGIS — e rode o script de novo.

### Vínculo com o MST

A base do INCRA não informa vínculo com o MST. Preencha a propriedade `mst` (true/false) em
`assentamentos_reforma_agraria.geojson` (ex.: pela tabela de atributos no QGIS): os assentamentos com
`mst: true` aparecem com contorno vermelho e "Vínculo MST: Sim" no popup.
