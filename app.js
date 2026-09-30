/* ==========================================================================
   Observatório Paraibano das Escolas do Campo — mapa interativo
   Leaflet 1.9 + L.circleMarker em renderizador Canvas (sem DOM por ponto)
   ========================================================================== */
(() => {
  "use strict";

  /* ------------------------------------------------------------------------
   * CONFIGURAÇÃO
   * ------------------------------------------------------------------------
   * >>> COLOQUE SEUS ARQUIVOS GEOJSON NA PASTA  data/  <<<
   * Os nomes abaixo são os gerados por scripts/build_data.py. Se exportar
   * novas versões pelo QGIS, basta sobrescrever os arquivos (mesmo nome) ou
   * alterar os caminhos aqui.
   *
   * escolas_campo.geojson — Point, propriedades:
   *   id, nome, municipio, co_municipio, dependencia (1 fed, 2 est, 3 mun, 4 priv),
   *   loc_dif [códigos TP_LOCALIZACAO_DIFERENCIADA], sit (1 char/ano 2007..2025:
   *   0 ausente, 1 ativa, 2 paralisada, 3/4 extinta), rural (1 char/ano: 1 rural),
   *   ultimo_ano_ativa, ano_fechamento, coord ("inep" | "aproximada")
   * assentamentos_reforma_agraria.geojson — Polygon/MultiPolygon, propriedades:
   *   nome, municipio, co_municipio, familias, capacidade, area_ha, data_criacao,
   *   fase, forma_obtencao, mst (true/false/null)
   * regioes_pb.geojson — Polygon/MultiPolygon dos municípios, propriedades:
   *   co_municipio, municipio, mesorregiao, microrregiao, regiao_imediata,
   *   regiao_intermediaria
   * ---------------------------------------------------------------------- */
  const CONFIG = {
    dados: {
      escolas: "data/escolas_campo.geojson",
      assentamentos: "data/assentamentos_reforma_agraria.geojson",
      regioes: "data/regioes_pb.geojson",
    },
    anoInicial: 2007,
    anoFinal: 2025,
    centro: [-7.115, -36.82],
    zoom: 8,
    // Mapa base claro. Alternativa: OpenStreetMap padrão
    //   url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "&copy; OpenStreetMap"
    tiles: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      attribution: "Base &copy; Esri, HERE, Garmin, &copy; OpenStreetMap",
      maxZoom: 16,
    },
    velocidadeAnimacaoMs: 700,
  };

  const ANOS = range(CONFIG.anoInicial, CONFIG.anoFinal);

  const CORES = {
    ativa: "#1b8a5a",
    paralisada: "#d99a00",
    fechada: "#c8323c",
    reclass: "#8a8f99",
    assent: "#7a4fa8",
    assentMst: "#b3261e",
    // Categórico fixo por mesorregião (oeste → leste não importa: a cor segue a entidade)
    meso: {
      "Mata Paraibana": "#2a78d6",
      "Agreste Paraibano": "#e87ba4",
      "Borborema": "#4a3aa7",
      "Sertão Paraibano": "#1baf7a",
    },
    // Sequencial (um só matiz, claro → escuro) para % de perda de escolas ativas
    perda: ["#f3ebe1", "#e2cbb0", "#c9a27a", "#a8764c", "#7a4e2a"],
    perdaLimites: [0.2, 0.4, 0.6, 0.8],
  };

  const STATUS_LABEL = {
    ativa: "Ativa",
    paralisada: "Paralisada",
    fechada: "Fechada",
    reclass: "Ativa (urbana)",
  };
  const REDE = { 1: "Federal", 2: "Estadual", 3: "Municipal", 4: "Privada" };
  const LOC_DIF = {
    1: "Área de assentamento",
    2: "Terra indígena",
    3: "Comunidade remanescente de quilombos",
  };

  /* ------------------------------------------------------------------------
   * ESTADO
   * ---------------------------------------------------------------------- */
  const state = {
    ano: CONFIG.anoInicial,
    mostrarFechadas: true,
    somenteAssentamento: false,
    rede: "",
    modoRegioes: "perda",
    escolas: [],          // { props, marker, status }
    ativasPorMun: {},     // co_municipio -> [ativas por ano]
  };
  const idx = (ano) => ano - CONFIG.anoInicial;
  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------------
   * MAPA
   * ---------------------------------------------------------------------- */
  // scrollWheelZoom desligado: a roda do mouse rola a página até o usuário clicar no mapa
  const map = L.map("map", { center: CONFIG.centro, zoom: CONFIG.zoom, minZoom: 7, scrollWheelZoom: false });
  const dica = L.DomUtil.create("div", "map-hint", map.getContainer().parentElement);
  dica.textContent = "Clique no mapa para ativar o zoom com a roda do mouse";
  map.once("click", () => { map.scrollWheelZoom.enable(); dica.classList.add("hidden"); });
  L.tileLayer(CONFIG.tiles.url, { attribution: CONFIG.tiles.attribution, maxZoom: CONFIG.tiles.maxZoom }).addTo(map);

  // Panes garantem a ordem: municípios < assentamentos < escolas
  map.createPane("regioes").style.zIndex = 350;
  map.createPane("assentamentos").style.zIndex = 400;
  map.createPane("escolas").style.zIndex = 450;

  // UM único canvas para todos os ~5.000 pontos
  const canvasEscolas = L.canvas({ pane: "escolas", padding: 0.5, tolerance: 3 });

  L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);

  /* ------------------------------------------------------------------------
   * MÓDULO: situação de uma escola num ano
   * ---------------------------------------------------------------------- */
  const Situacao = {
    em(p, i) {
      const s = p.sit[i];
      if (s === "0") return p._primeiro <= i ? "fechada" : null; // ainda não existia → oculta
      if (s === "1") return p.rural[i] === "1" ? "ativa" : "reclass";
      if (s === "2") return "paralisada";
      return "fechada";
    },
    passaFiltros(p) {
      if (state.rede && String(p.dependencia) !== state.rede) return false;
      if (state.somenteAssentamento && !p.loc_dif.includes(1)) return false;
      return true;
    },
  };

  /* ------------------------------------------------------------------------
   * MÓDULO: camada de escolas (circleMarker + canvas)
   * ---------------------------------------------------------------------- */
  const CamadaEscolas = {
    grupo: L.featureGroup(),

    raioBase() {
      const z = map.getZoom();
      return Math.max(2.5, Math.min(8, 1.2 * (z - 5)));
    },

    estilo(status) {
      const r = this.raioBase();
      if (!status) return { radius: 0, stroke: false, fillOpacity: 0 };
      const cor = CORES[status];
      const fechada = status === "fechada";
      return {
        radius: fechada ? r * 0.75 : r,
        stroke: true,
        color: "#ffffff",
        weight: fechada ? 0.5 : 0.8,
        opacity: fechada ? 0.5 : 0.9,
        fillColor: cor,
        fillOpacity: fechada ? 0.45 : 0.9,
      };
    },

    construir(geojson) {
      // Desenha primeiro as que fecharam cedo; as que seguem ativas ficam por cima
      const feats = geojson.features.slice().sort((a, b) =>
        (a.properties.ano_fechamento ?? 9999) - (b.properties.ano_fechamento ?? 9999));

      for (const f of feats) {
        const p = f.properties;
        p.loc_dif = p.loc_dif || [];
        p._primeiro = [...p.sit].findIndex((c) => c !== "0");
        const [lon, lat] = f.geometry.coordinates;
        const marker = L.circleMarker([lat, lon], { renderer: canvasEscolas, radius: 0, stroke: false });
        marker.feature = f;
        const item = { props: p, marker, status: undefined };
        marker._item = item;
        state.escolas.push(item);
        this.grupo.addLayer(marker);
      }

      this.grupo.on("click", (e) => {
        const item = e.layer._item;
        if (!item.status) return;
        L.popup({ maxWidth: 320 }).setLatLng(e.layer.getLatLng()).setContent(Popups.escola(item)).openOn(map);
      });
      map.on("zoomend", () => this.atualizar(true));
    },

    atualizar(forcar = false) {
      const i = idx(state.ano);
      for (const item of state.escolas) {
        let st = Passa(item.props) ? Situacao.em(item.props, i) : null;
        if (st === "fechada" && !state.mostrarFechadas) st = null;
        if (st !== item.status || forcar) {
          item.status = st;
          item.marker.setStyle(this.estilo(st));
        }
      }
    },
  };
  const Passa = (p) => Situacao.passaFiltros(p);

  /* ------------------------------------------------------------------------
   * MÓDULO: municípios / divisões regionais
   * ---------------------------------------------------------------------- */
  const CamadaRegioes = {
    layer: null,

    construir(geojson) {
      this.layer = L.geoJSON(geojson, {
        pane: "regioes",
        style: (f) => this.estilo(f),
        onEachFeature: (f, lyr) => {
          lyr.bindTooltip(() => Popups.municipio(f.properties), { sticky: true, direction: "top", opacity: 0.95 });
          lyr.on("mouseover", () => lyr.setStyle({ weight: 2, color: "#1f2320" }));
          lyr.on("mouseout", () => lyr.setStyle(this.estilo(f)));
        },
      });
    },

    perda(co) {
      const serie = state.ativasPorMun[co];
      if (!serie || !serie[0]) return null;
      return 1 - serie[idx(state.ano)] / serie[0];
    },

    estilo(f) {
      const base = { weight: 0.7, color: "#8a8f99", opacity: 0.8, fillOpacity: 0 };
      const p = f.properties;
      if (state.modoRegioes === "mesorregiao") {
        return { ...base, fillColor: CORES.meso[p.mesorregiao] || "#ccc", fillOpacity: 0.18 };
      }
      if (state.modoRegioes === "perda") {
        const v = this.perda(p.co_municipio);
        if (v === null) return { ...base, fillColor: "#e2e0d8", fillOpacity: 0.3 };
        const k = CORES.perdaLimites.findIndex((lim) => v < lim);
        return { ...base, fillColor: CORES.perda[k === -1 ? 4 : k], fillOpacity: 0.55 };
      }
      return base;
    },

    atualizar() {
      if (this.layer) this.layer.setStyle((f) => this.estilo(f));
      Legenda.regioes();
    },
  };

  /* ------------------------------------------------------------------------
   * MÓDULO: assentamentos da Reforma Agrária
   * ---------------------------------------------------------------------- */
  const CamadaAssentamentos = {
    layer: null,
    construir(geojson) {
      this.layer = L.geoJSON(geojson, {
        pane: "assentamentos",
        style: (f) => ({
          color: f.properties.mst === true ? CORES.assentMst : CORES.assent,
          weight: f.properties.mst === true ? 2 : 1.2,
          fillColor: CORES.assent,
          fillOpacity: 0.3,
        }),
        onEachFeature: (f, lyr) => lyr.bindPopup(() => Popups.assentamento(f.properties), { maxWidth: 320 }),
      });
    },
  };

  /* ------------------------------------------------------------------------
   * MÓDULO: conteúdo de popups/tooltips
   * ---------------------------------------------------------------------- */
  const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("pt-BR"));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const Popups = {
    escola({ props: p, status }) {
      const traj = ANOS.map((ano, i) => {
        const st = Situacao.em(p, i);
        const cls = { ativa: "s1", paralisada: "s2", fechada: "s3", reclass: "su" }[st] || "";
        const cur = ano === state.ano ? " cur" : "";
        return `<span class="${cls}${cur}" title="${ano}: ${STATUS_LABEL[st] || "não existia"}"></span>`;
      }).join("");
      const dif = p.loc_dif.map((c) => LOC_DIF[c] || `Área diferenciada (cód. ${c})`).join(", ");
      return `
        <p class="pp-title">${esc(p.nome)}</p>
        <div class="pp-sub">${esc(p.municipio)} · INEP ${p.id}</div>
        <table class="pp-table">
          <tr><td>Situação em ${state.ano}</td><td><span class="pp-badge"><span class="dot ${status}"></span>${STATUS_LABEL[status]}</span></td></tr>
          <tr><td>Ano de fechamento</td><td>${p.ano_fechamento ?? "Em funcionamento"}</td></tr>
          <tr><td>Último ano ativa</td><td>${p.ultimo_ano_ativa ?? "–"}</td></tr>
          <tr><td>Rede</td><td>${REDE[p.dependencia] || "–"}</td></tr>
          ${dif ? `<tr><td>Localização</td><td>${esc(dif)}</td></tr>` : ""}
        </table>
        <div class="pp-traj">${traj}</div>
        <div class="pp-traj-lbl"><span>${CONFIG.anoInicial}</span><span>${CONFIG.anoFinal}</span></div>
        ${p.coord === "aproximada" ? '<div class="pp-note">Posição aproximada dentro do município.</div>' : ""}`;
    },

    municipio(p) {
      const serie = state.ativasPorMun[p.co_municipio];
      const a0 = serie ? serie[0] : 0;
      const a1 = serie ? serie[idx(state.ano)] : 0;
      const perda = a0 ? Math.round((1 - a1 / a0) * 100) : null;
      return `<strong>${esc(p.municipio)}</strong><br>
        <span style="color:#7a817c">${esc(p.mesorregiao)} · ${esc(p.regiao_imediata)}</span><br>
        Escolas do campo ativas: ${fmt(a0)} (${CONFIG.anoInicial}) → ${fmt(a1)} (${state.ano})
        ${perda !== null ? `<br>Variação: <strong>${perda > 0 ? "−" : "+"}${Math.abs(perda)}%</strong>` : ""}`;
    },

    assentamento(p) {
      const serie = state.ativasPorMun[p.co_municipio];
      const mst = p.mst === true ? "Sim" : p.mst === false ? "Não" : "Não informado";
      return `
        <p class="pp-title">${esc(p.nome)}</p>
        <div class="pp-sub">${esc(p.municipio)} · SIPRA ${esc(p.cd_sipra)}</div>
        <table class="pp-table">
          <tr><td>Famílias</td><td>${fmt(p.familias)} de ${fmt(p.capacidade)}</td></tr>
          <tr><td>Área</td><td>${fmt(p.area_ha)} ha</td></tr>
          <tr><td>Criação</td><td>${esc(p.data_criacao) || "–"}</td></tr>
          <tr><td>Obtenção</td><td>${esc(p.forma_obtencao) || "–"}</td></tr>
          <tr><td>Vínculo MST</td><td>${mst}</td></tr>
          ${serie ? `<tr><td>Escolas do campo<br>no município</td><td>${fmt(serie[0])} ativas em ${CONFIG.anoInicial}<br>${fmt(serie[idx(state.ano)])} ativas em ${state.ano}</td></tr>` : ""}
        </table>`;
    },
  };

  /* ------------------------------------------------------------------------
   * MÓDULO: indicadores + mini-gráfico
   * ---------------------------------------------------------------------- */
  const Indicadores = {
    serieAtivas: [],

    recalcular() {
      // Série de ativas por ano (respeita filtros de rede / assentamento)
      const serie = ANOS.map(() => 0);
      const porMun = {};
      for (const { props: p } of state.escolas) {
        const passa = Passa(p);
        for (let i = 0; i < ANOS.length; i++) {
          if (p.sit[i] === "1" && p.rural[i] === "1") {
            if (passa) serie[i]++;
            (porMun[p.co_municipio] ||= ANOS.map(() => 0))[i]++;
          }
        }
      }
      this.serieAtivas = serie;
      state.ativasPorMun = porMun; // mapa de municípios sempre com o total (sem filtro)
      Grafico.desenhar(serie);
    },

    atualizar() {
      const i = idx(state.ano);
      let para = 0, fech = 0;
      for (const { props: p } of state.escolas) {
        if (!Passa(p)) continue;
        const st = Situacao.em(p, i);
        if (st === "paralisada") para++;
        else if (st === "fechada") fech++;
      }
      const ativas = this.serieAtivas[i];
      const ini = this.serieAtivas[0];
      $("stat-ano").textContent = state.ano;
      $("stat-ativas").textContent = fmt(ativas);
      $("stat-paralisadas").textContent = fmt(para);
      $("stat-fechadas").textContent = fmt(fech);
      const v = ini ? ((ativas - ini) / ini) * 100 : 0;
      $("stat-variacao").innerHTML = i === 0
        ? `Ponto de partida da série: <strong>${fmt(ini)}</strong> escolas do campo ativas.`
        : `<strong>${v <= 0 ? "−" : "+"}${Math.abs(v).toFixed(1).replace(".", ",")}%</strong> de escolas ativas em relação a ${CONFIG.anoInicial}.`;
      Grafico.cursor(i);
    },
  };

  const Grafico = {
    W: 340, H: 90, pad: { l: 30, r: 6, t: 8, b: 16 },
    svg: null, serie: [],

    x(i) { return this.pad.l + (i / (ANOS.length - 1)) * (this.W - this.pad.l - this.pad.r); },
    y(v) { return this.pad.t + (1 - v / this.max) * (this.H - this.pad.t - this.pad.b); },

    desenhar(serie) {
      this.serie = serie;
      this.max = Math.max(1, Math.ceil(Math.max(...serie) / 1000) * 1000);
      const pts = serie.map((v, i) => `${this.x(i).toFixed(1)},${this.y(v).toFixed(1)}`);
      const base = this.y(0);
      const ticks = [0, this.max / 2, this.max];
      const passo = (this.W - this.pad.l - this.pad.r) / (ANOS.length - 1);
      $("chart").innerHTML = `
        <svg viewBox="0 0 ${this.W} ${this.H}" role="img" aria-label="Escolas do campo ativas por ano, ${CONFIG.anoInicial}–${CONFIG.anoFinal}">
          ${ticks.map((t) => `<line class="grid" x1="${this.pad.l}" x2="${this.W - this.pad.r}" y1="${this.y(t)}" y2="${this.y(t)}"/>
            <text class="axis" x="${this.pad.l - 4}" y="${this.y(t) + 3}" text-anchor="end">${fmt(t)}</text>`).join("")}
          <polygon class="area" points="${this.x(0)},${base} ${pts.join(" ")} ${this.x(ANOS.length - 1)},${base}"/>
          <polyline class="line" points="${pts.join(" ")}"/>
          <line class="cursor" id="g-cursor" y1="${this.pad.t}" y2="${base}"/>
          <circle class="marker" id="g-marker" r="4"/>
          ${ANOS.map((a, i) => `<rect class="hit" data-i="${i}" x="${this.x(i) - passo / 2}" y="0" width="${passo}" height="${this.H}"/>`).join("")}
          <text class="axis" x="${this.x(0)}" y="${this.H - 2}" text-anchor="start">${CONFIG.anoInicial}</text>
          <text class="axis" x="${this.x(ANOS.length - 1)}" y="${this.H - 2}" text-anchor="end">${CONFIG.anoFinal}</text>
        </svg><div class="chart-tip" id="g-tip" hidden></div>`;
      this.svg = $("chart").querySelector("svg");
      this.svg.querySelectorAll(".hit").forEach((r) => {
        const i = +r.dataset.i;
        r.addEventListener("mouseenter", () => this.tip(i));
        r.addEventListener("mouseleave", () => ($("g-tip").hidden = true));
        r.addEventListener("click", () => UI.definirAno(ANOS[i]));
      });
    },

    cursor(i) {
      if (!this.svg) return;
      const x = this.x(i), y = this.y(this.serie[i]);
      const c = $("g-cursor"), m = $("g-marker");
      c.setAttribute("x1", x); c.setAttribute("x2", x);
      m.setAttribute("cx", x); m.setAttribute("cy", y);
    },

    tip(i) {
      const t = $("g-tip");
      t.hidden = false;
      t.textContent = `${ANOS[i]}: ${fmt(this.serie[i])} ativas`;
      t.style.left = `${(this.x(i) / this.W) * 100}%`;
    },
  };

  /* ------------------------------------------------------------------------
   * MÓDULO: legenda dinâmica das regiões
   * ---------------------------------------------------------------------- */
  const Legenda = {
    regioes() {
      const el = $("legend-regioes");
      if (!map.hasLayer(CamadaRegioes.layer || L.layerGroup())) { el.innerHTML = ""; return; }
      if (state.modoRegioes === "perda") {
        el.innerHTML = `<div class="ramp-title">Perda de escolas do campo ativas, ${CONFIG.anoInicial}→${state.ano}</div>
          <div class="ramp">${CORES.perda.map((c) => `<span style="background:${c}"></span>`).join("")}</div>
          <div class="ramp-labels"><span>0%</span><span>20%</span><span>40%</span><span>60%</span><span>80%</span><span>100%</span></div>`;
      } else if (state.modoRegioes === "mesorregiao") {
        el.innerHTML = `<ul class="legend">${Object.entries(CORES.meso).map(([n, c]) =>
          `<li><span class="swatch" style="background:${c}33;border:1.5px solid ${c}"></span>${n}</li>`).join("")}</ul>`;
      } else {
        el.innerHTML = "";
      }
    },
  };

  /* ------------------------------------------------------------------------
   * MÓDULO: interface (controles da sidebar)
   * ---------------------------------------------------------------------- */
  const UI = {
    timer: null,
    rafPendente: false,

    definirAno(ano) {
      state.ano = ano;
      $("slider-ano").value = ano;
      this.agendarRender();
    },

    // Agrupa eventos do slider num único redesenho por frame
    agendarRender() {
      if (this.rafPendente) return;
      this.rafPendente = true;
      requestAnimationFrame(() => {
        this.rafPendente = false;
        CamadaEscolas.atualizar();
        Indicadores.atualizar();
        CamadaRegioes.atualizar();
      });
    },

    alternarCamada(checkbox, layer) {
      const aplicar = () => {
        if (!layer) return;
        checkbox.checked ? layer.addTo(map) : map.removeLayer(layer);
        Legenda.regioes();
      };
      checkbox.addEventListener("change", aplicar);
      aplicar();
    },

    play() {
      const btn = $("btn-play");
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        btn.textContent = "▶";
        btn.setAttribute("aria-label", "Reproduzir animação");
        return;
      }
      if (state.ano >= CONFIG.anoFinal) this.definirAno(CONFIG.anoInicial);
      btn.textContent = "❚❚";
      btn.setAttribute("aria-label", "Pausar animação");
      this.timer = setInterval(() => {
        if (state.ano >= CONFIG.anoFinal) return this.play();
        this.definirAno(state.ano + 1);
      }, CONFIG.velocidadeAnimacaoMs);
    },

    ligar() {
      $("slider-ano").addEventListener("input", (e) => this.definirAno(+e.target.value));
      $("btn-play").addEventListener("click", () => this.play());

      $("flt-fechadas").addEventListener("change", (e) => {
        state.mostrarFechadas = e.target.checked;
        CamadaEscolas.atualizar();
      });
      const refiltrar = () => {
        Indicadores.recalcular();
        CamadaEscolas.atualizar();
        Indicadores.atualizar();
      };
      $("flt-assentamento").addEventListener("change", (e) => { state.somenteAssentamento = e.target.checked; refiltrar(); });
      $("flt-rede").addEventListener("change", (e) => { state.rede = e.target.value; refiltrar(); });
      $("sel-regioes").addEventListener("change", (e) => { state.modoRegioes = e.target.value; CamadaRegioes.atualizar(); });

      this.alternarCamada($("lyr-regioes"), CamadaRegioes.layer);
      this.alternarCamada($("lyr-assentamentos"), CamadaAssentamentos.layer);
      this.alternarCamada($("lyr-escolas"), CamadaEscolas.grupo);
    },
  };

  /* ------------------------------------------------------------------------
   * CARGA DE DADOS
   * ---------------------------------------------------------------------- */
  async function carregar(url, obrigatorio = true) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      console.warn(`Não foi possível carregar ${url}:`, err);
      if (obrigatorio) throw err;
      return null;
    }
  }

  async function iniciar() {
    try {
      const [escolas, assentamentos, regioes] = await Promise.all([
        carregar(CONFIG.dados.escolas),
        carregar(CONFIG.dados.assentamentos, false),
        carregar(CONFIG.dados.regioes, false),
      ]);

      CamadaEscolas.construir(escolas);
      if (regioes) {
        CamadaRegioes.construir(regioes);
        map.fitBounds(CamadaRegioes.layer.getBounds(), { padding: [10, 10] });
      }
      else $("lyr-regioes").disabled = true;
      if (assentamentos) CamadaAssentamentos.construir(assentamentos);
      else $("lyr-assentamentos").disabled = true;

      Indicadores.recalcular();
      UI.ligar();
      CamadaEscolas.atualizar(true);
      Indicadores.atualizar();
      CamadaRegioes.atualizar();

      const aprox = escolas.features.filter((f) => f.properties.coord === "aproximada").length;
      if (aprox) {
        $("nota-coordenadas").textContent =
          `${fmt(aprox)} de ${fmt(escolas.features.length)} escolas estão posicionadas de forma aproximada ` +
          `dentro do seu município, pois a planilha não traz coordenadas. Para posições exatas, adicione ` +
          `scripts/fontes/coordenadas_escolas.csv (Catálogo de Escolas/INEP) e rode scripts/build_data.py.`;
      }
      $("loading").classList.add("done");
    } catch (err) {
      $("loading").textContent =
        "Erro ao carregar os dados. Sirva a pasta por HTTP (ex.: python3 -m http.server) e verifique data/.";
      console.error(err);
    }
  }

  function range(a, b) {
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }

  iniciar();
})();
