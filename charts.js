/* ==========================================================================
   Gráficos do relatório — SVG simples, sem bibliotecas.
   Lê data/indicadores.json (gerado por scripts/build_data.py).
   ========================================================================== */
(() => {
  "use strict";

  const COR = {
    rural: "#c0582b",
    urbano: "#2a78d6",
    assent: "#7a4fa8",
    base: "#b9b5aa",
    paralisada: "#d99a00",
    extinta: "#c8323c",
  };
  const fmt = (n) => Number(n).toLocaleString("pt-BR");
  const pct = (v, casas = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(casas).replace(".", ",")}%`;
  const NS = "http://www.w3.org/2000/svg";

  /* ---------------------------------------------------------------- helpers */
  function svg(el, w, h) {
    el.innerHTML = "";
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", `0 0 ${w} ${h}`);
    s.setAttribute("role", "img");
    el.appendChild(s);
    return s;
  }
  function add(parent, tag, attrs = {}, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    parent.appendChild(n);
    return n;
  }
  function tooltip(el) {
    let t = el.querySelector(".tooltip");
    if (!t) { t = document.createElement("div"); t.className = "tooltip"; t.hidden = true; el.appendChild(t); }
    return {
      show(x, y, html) { t.innerHTML = html; t.style.left = `${x}px`; t.style.top = `${y}px`; t.hidden = false; },
      hide() { t.hidden = true; },
    };
  }
  function niceMax(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    return Math.ceil(v / p) * p;
  }
  function legenda(el, itens) {
    const d = document.createElement("div");
    d.className = "legend-inline";
    d.innerHTML = itens.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("");
    el.prepend(d);
  }

  /* ------------------------------------------------ gráfico de linhas */
  function linhas(el, { xs, series, yMax, yFmt = fmt, altura = 320, rotuloFinal = true }) {
    const W = el.clientWidth, H = altura;
    const m = { t: 12, r: rotuloFinal ? 110 : 16, b: 28, l: 48 };
    const s = svg(el, W, H);
    const max = yMax ?? niceMax(Math.max(...series.flatMap((d) => d.values)));
    const x = (i) => m.l + (i / (xs.length - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - v / max) * (H - m.t - m.b);

    const g = add(s, "g", { class: "grid" });
    const ax = add(s, "g", { class: "axis" });
    for (let k = 0; k <= 4; k++) {
      const v = (max / 4) * k;
      add(g, "line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: k === 0 ? "zero" : "" });
      add(ax, "text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, yFmt(v));
    }
    const passo = W < 560 ? 6 : 3;
    xs.forEach((a, i) => {
      if (i % passo === 0 || i === xs.length - 1) add(ax, "text", { x: x(i), y: H - 6, "text-anchor": "middle" }, a);
    });

    for (const d of series) {
      add(s, "polyline", {
        class: "series", stroke: d.color,
        points: d.values.map((v, i) => `${x(i)},${y(v)}`).join(" "),
        ...(d.dash ? { "stroke-dasharray": "5 4" } : {}),
      });
      if (rotuloFinal) {
        const last = d.values.length - 1;
        add(s, "text", { class: "lbl-strong", x: x(last) + 8, y: y(d.values[last]) + 4 }, d.name);
      }
    }

    // camada de hover: mira + tooltip com todas as séries
    const cross = add(s, "line", { class: "crosshair", y1: m.t, y2: H - m.b, visibility: "hidden" });
    const dots = series.map((d) => add(s, "circle", { r: 4.5, fill: d.color, class: "dot-hover", visibility: "hidden" }));
    const tip = tooltip(el);
    const hit = add(s, "rect", { class: "hit", x: m.l, y: 0, width: W - m.l - m.r, height: H });
    hit.addEventListener("mousemove", (e) => {
      const r = s.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(xs.length - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (xs.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      series.forEach((d, k) => {
        dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(d.values[i])); dots[k].setAttribute("visibility", "visible");
      });
      const topo = Math.min(...series.map((d) => y(d.values[i])));
      tip.show((x(i) / W) * r.width, (topo / H) * r.height,
        `<b>${xs[i]}</b>` + series.map((d) => `<div class="row"><i style="background:${d.color}"></i>${d.name}: <b>${(d.tipFmt || yFmt)(d.values[i], i)}</b></div>`).join(""));
    });
    hit.addEventListener("mouseleave", () => {
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
      tip.hide();
    });
  }

  /* ------------------------------------------------ barras verticais */
  function barrasV(el, { xs, values, color, destaque = [], altura = 280, tipFmt, extraLinha }) {
    const W = el.clientWidth, H = altura;
    const m = { t: 20, r: 12, b: 28, l: 48 };
    const s = svg(el, W, H);
    const max = niceMax(Math.max(...values, ...(extraLinha ? extraLinha.values : [])));
    const bw = (W - m.l - m.r) / xs.length;
    const x = (i) => m.l + i * bw;
    const y = (v) => m.t + (1 - v / max) * (H - m.t - m.b);

    const g = add(s, "g", { class: "grid" });
    const ax = add(s, "g", { class: "axis" });
    for (let k = 0; k <= 4; k++) {
      const v = (max / 4) * k;
      add(g, "line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: k === 0 ? "zero" : "" });
      add(ax, "text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, fmt(v));
    }
    const passo = W < 560 ? 4 : 2;
    xs.forEach((a, i) => {
      if (i % passo === 0 || i === xs.length - 1) add(ax, "text", { x: x(i) + bw / 2, y: H - 6, "text-anchor": "middle" }, a);
    });

    const tip = tooltip(el);
    const bars = values.map((v, i) => {
      const h = Math.max(0, y(0) - y(v));
      const gap = Math.max(2, bw * 0.18);
      const b = add(s, "path", { class: "bar", fill: color, d: barraArredondada(x(i) + gap / 2, y(v), bw - gap, h, 3) });
      if (destaque.includes(i)) add(s, "text", { class: "lbl", x: x(i) + bw / 2, y: y(v) - 6, "text-anchor": "middle" }, fmt(v));
      return b;
    });

    if (extraLinha) {
      add(s, "polyline", {
        class: "series", stroke: extraLinha.color,
        points: extraLinha.values.map((v, i) => `${x(i) + bw / 2},${y(v)}`).join(" "),
      });
    }

    values.forEach((v, i) => {
      const hit = add(s, "rect", { class: "hit", x: x(i), y: 0, width: bw, height: H });
      hit.addEventListener("mouseenter", () => {
        bars.forEach((b, k) => b.classList.toggle("dim", k !== i));
        const r = s.getBoundingClientRect();
        const topo = Math.min(y(v), extraLinha ? y(extraLinha.values[i]) : Infinity);
        tip.show(((x(i) + bw / 2) / W) * r.width, (topo / H) * r.height, tipFmt(i));
      });
      hit.addEventListener("mouseleave", () => { bars.forEach((b) => b.classList.remove("dim")); tip.hide(); });
    });
  }

  function barraArredondada(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /* ------------------------------------------------ barras horizontais (% de perda) */
  function barrasH(el, { linhas: rows, max = 100 }) {
    const W = el.clientWidth;
    const rowH = 54;
    const labelW = Math.min(170, W * 0.34);
    const m = { t: 4, r: 64, b: 4, l: labelW };
    const H = m.t + m.b + rows.length * rowH;
    const s = svg(el, W, H);
    const x = (v) => m.l + (v / max) * (W - m.l - m.r);
    const tip = tooltip(el);

    rows.forEach((d, i) => {
      const y0 = m.t + i * rowH;
      add(s, "text", { class: "lbl-strong", x: 0, y: y0 + 20 }, d.label);
      add(s, "text", { class: "lbl", x: 0, y: y0 + 38 }, d.nota);
      add(s, "rect", { x: m.l, y: y0 + 12, width: W - m.l - m.r, height: 20, rx: 3, fill: "#efece4" });
      add(s, "path", { class: "bar", fill: d.color, d: barraHArredondada(m.l, y0 + 12, x(d.value) - m.l, 20, 3) });
      add(s, "text", { class: "lbl-strong", x: x(d.value) + 8, y: y0 + 27 }, pct(-d.value));
      const hit = add(s, "rect", { class: "hit", x: 0, y: y0, width: W, height: rowH });
      hit.addEventListener("mouseenter", () => {
        const r = s.getBoundingClientRect();
        tip.show((x(d.value) / W) * r.width, ((y0 + 10) / H) * r.height, d.tip);
      });
      hit.addEventListener("mouseleave", () => tip.hide());
    });
  }
  function barraHArredondada(x, y, w, h, r) {
    r = Math.min(r, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }

  /* ---------------------------------------------------------------- figuras */
  function desenhar(D) {
    const anos = D.anos;
    const perda = (a, b) => ((a - b) / a) * 100;

    // 02 — rural x urbano
    const elRU = document.getElementById("chart-rural-urbano");
    linhas(elRU, {
      xs: anos,
      series: [
        { name: "Urbanas", color: COR.urbano, values: D.urbanas },
        { name: "Do campo", color: COR.rural, values: D.rurais },
      ],
    });
    legenda(elRU, [["Escolas do campo (rurais)", COR.rural], ["Escolas urbanas", COR.urbano]]);

    // 03 — redes
    const R = D.rurais_por_rede;
    const ult = anos.length - 1;
    const tot0 = D.rurais[0], tot1 = D.rurais[ult];
    barrasH(document.getElementById("chart-redes"), {
      linhas: [
        { label: "Estadual", nota: `${fmt(R.estadual[0])} → ${fmt(R.estadual[ult])} escolas`, value: perda(R.estadual[0], R.estadual[ult]), color: COR.rural,
          tip: `<b>Rede estadual</b><br>${fmt(R.estadual[0] - R.estadual[ult])} escolas a menos` },
        { label: "Municipal", nota: `${fmt(R.municipal[0])} → ${fmt(R.municipal[ult])} escolas`, value: perda(R.municipal[0], R.municipal[ult]), color: COR.rural,
          tip: `<b>Rede municipal</b><br>${fmt(R.municipal[0] - R.municipal[ult])} escolas a menos<br>${Math.round(((R.municipal[0] - R.municipal[ult]) / (tot0 - tot1)) * 100)}% de todas as perdas` },
        { label: "Total", nota: `${fmt(tot0)} → ${fmt(tot1)} escolas`, value: perda(tot0, tot1), color: "#6f6a60",
          tip: `<b>Todas as redes</b><br>${fmt(tot0 - tot1)} escolas a menos` },
      ],
    });

    // 04 — perdas por ano
    const perdas = D.rurais.slice(1).map((v, i) => D.rurais[i] - v);
    const top = perdas.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((d) => d[1]);
    barrasV(document.getElementById("chart-perdas-ano"), {
      xs: anos.slice(1), values: perdas, color: COR.rural, destaque: top,
      tipFmt: (i) => `<b>${anos[i + 1]}</b><br>${fmt(perdas[i])} escolas a menos<br>${fmt(D.rurais[i + 1])} em funcionamento`,
    });

    // 04 — paralisadas x extintas (a partir de 2011)
    const i0 = anos.indexOf(2011);
    const elPE = document.getElementById("chart-paralisadas");
    barrasV(elPE, {
      xs: anos.slice(i0), values: D.rurais_extintas.slice(i0), color: COR.extinta,
      destaque: [anos.indexOf(2019) - i0],
      extraLinha: { values: D.rurais_paralisadas.slice(i0), color: COR.paralisada },
      tipFmt: (i) => `<b>${anos[i0 + i]}</b>` +
        `<div class="row"><i style="background:${COR.paralisada}"></i>Paralisadas: <b>${fmt(D.rurais_paralisadas[i0 + i])}</b></div>` +
        `<div class="row"><i style="background:${COR.extinta}"></i>Extintas no ano: <b>${fmt(D.rurais_extintas[i0 + i])}</b></div>`,
    });
    legenda(elPE, [["Paralisadas (linha)", COR.paralisada], ["Extintas no ano (barras)", COR.extinta]]);

    // 05 — mesorregiões (maior perda primeiro)
    const meso = Object.entries(D.mesorregioes)
      .map(([nome, s]) => ({ nome, ini: s[0], fim: s[ult] }))
      .sort((a, b) => perda(b.ini, b.fim) - perda(a.ini, a.fim));
    barrasH(document.getElementById("chart-meso"), {
      linhas: meso.map((m) => ({
        label: m.nome.replace(" Paraibano", "").replace(" Paraibana", ""),
        nota: `${fmt(m.ini)} → ${fmt(m.fim)}`,
        value: perda(m.ini, m.fim), color: COR.rural,
        tip: `<b>${m.nome}</b><br>${fmt(m.ini - m.fim)} escolas a menos`,
      })),
    });

    // 05 — tabela de municípios
    const top10 = D.municipios.slice(0, 10);
    document.getElementById("tabela-municipios").innerHTML = `
      <table class="tbl">
        <thead><tr><th>Município</th><th class="num">2007</th><th class="num">2025</th><th class="num">Variação</th></tr></thead>
        <tbody>${top10.map((m) => `
          <tr><td>${m.nome}<span class="meso">${m.meso}</span></td>
            <td class="num">${m.ini}</td><td class="num">${m.fim}</td>
            <td class="num perda">${pct(-perda(m.ini, m.fim), 0)}</td></tr>`).join("")}
        </tbody>
      </table>`;

    // 06 — índice 2007 = 100
    const idx = (s) => s.map((v) => (v / s[0]) * 100);
    const elA = document.getElementById("chart-assentamentos");
    const bruto = { "Em área de assentamento": D.area_assentamento, "Todas do campo": D.rurais };
    linhas(elA, {
      xs: anos, yMax: 120, yFmt: (v) => Math.round(v),
      series: [
        { name: "Assentamentos", color: COR.assent, values: idx(D.area_assentamento),
          tipFmt: (v, i) => `${Math.round(v)} (${fmt(bruto["Em área de assentamento"][i])} escolas)` },
        { name: "Todas", color: COR.rural, values: idx(D.rurais),
          tipFmt: (v, i) => `${Math.round(v)} (${fmt(bruto["Todas do campo"][i])} escolas)` },
      ],
    });
    legenda(elA, [["Escolas em área de assentamento", COR.assent], ["Todas as escolas do campo", COR.rural]]);
  }

  /* ---------------------------------------------------------------- navegação ativa */
  function navAtiva() {
    const links = [...document.querySelectorAll(".topnav-links a")];
    const alvo = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    const obs = new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.classList.remove("active"));
        const a = alvo.get(e.target.id);
        if (!a) continue;
        a.classList.add("active");
        // Rola só a barra de links (no celular); scrollIntoView também rolaria a página
        const barra = a.parentElement;
        if (barra.scrollWidth > barra.clientWidth) {
          barra.scrollLeft = a.offsetLeft - barra.offsetLeft - barra.clientWidth / 2 + a.offsetWidth / 2;
        }
      }
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("section[id]").forEach((s) => obs.observe(s));
  }

  /* ---------------------------------------------------------------- início */
  fetch("data/indicadores.json")
    .then((r) => r.json())
    .then((D) => {
      desenhar(D);
      let t;
      let largura = window.innerWidth;
      window.addEventListener("resize", () => {
        if (window.innerWidth === largura) return;
        largura = window.innerWidth;
        clearTimeout(t);
        t = setTimeout(() => desenhar(D), 150);
      });
    })
    .catch((err) => console.error("Erro ao carregar indicadores:", err));
  navAtiva();
})();
