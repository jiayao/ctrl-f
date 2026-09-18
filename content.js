// Jev Find — content script.
//
// Ctrl-F asks "does this byte sequence occur here?". This asks Jev, for every
// sentence on the page, "is this what the query is looking for?" and paints
// the answer as a probability. Jev never writes anything the reader sees; it
// only points. Code does the splitting, batching, thresholds and painting.
//
// Pipeline:  page text -> sentences (with DOM ranges) -> windows of N lines
//            -> one request per window, one Noul per line -> highlights by p.

(() => {
  if (window.__jevfind) return;

  const HI_CUT = 0.72;          // solid highlight at or above this
  const MIN_LEN = 12;           // ignore fragments shorter than this
  const MAX_LEN = 480;          // hard-split sentences longer than this
  const STYLE_ID = "jevfind-style";

  const BLOCK_TAGS = new Set(["P", "DIV", "LI", "TD", "TH", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE",
    "ARTICLE", "SECTION", "DD", "DT", "FIGCAPTION", "SUMMARY", "CAPTION", "LABEL", "MAIN", "ASIDE", "HEADER", "FOOTER",
    "NAV", "UL", "OL", "TABLE", "TR", "BODY", "DETAILS", "FIELDSET", "FORM"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "CANVAS",
    "IFRAME", "CODE", "KBD", "TEMPLATE", "HEAD", "TITLE", "BUTTON"]);

  const state = {
    open: false, query: "", sentences: [], matches: [], current: -1, threshold: 0.45,
    generation: 0, literal: new Set(), cache: new Map(), settings: null, status: "",
    pending: 0, total: 0, usage: 0,
  };

  // ------------------------------------------------------------ extraction
  const blockCache = new WeakMap();
  function isBlock(el) {
    if (blockCache.has(el)) return blockCache.get(el);
    let b = BLOCK_TAGS.has(el.tagName);
    if (!b) {
      const d = getComputedStyle(el).display;
      b = d !== "inline" && d !== "inline-block" && d !== "contents" && d !== "inline-flex" && d !== "inline-grid";
    }
    blockCache.set(el, b);
    return b;
  }
  function nearestBlock(node) {
    let el = node.parentElement;
    while (el && el !== document.body && !isBlock(el)) el = el.parentElement;
    return el || document.body;
  }
  function skippable(el) {
    for (let e = el; e; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName) || e.id === "jevfind-host") return true;
      if (e.getAttribute && e.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
  }

  function extract() {
    const blocks = new Map(); // block element -> [{node, start, end}]
    const order = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (skippable(n.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const b = nearestBlock(n);
      if (!blocks.has(b)) { blocks.set(b, []); order.push(b); }
      const arr = blocks.get(b);
      const start = arr.length ? arr[arr.length - 1].end : 0;
      arr.push({ node: n, start, end: start + n.nodeValue.length });
    }
    const out = [];
    for (const b of order) {
      if (b.getClientRects().length === 0) continue; // hidden
      const nodes = blocks.get(b);
      const text = nodes.map((x) => x.node.nodeValue).join("");
      for (const [s, e] of splitSentences(text)) {
        const t = text.slice(s, e);
        if (t.trim().length < MIN_LEN) continue;
        out.push({ text: t.replace(/\s+/g, " ").trim(), nodes, s, e, block: b });
      }
    }
    return out;
  }

  // Sentence boundaries: terminal punctuation followed by whitespace and an
  // opener/capital/digit. Block boundaries are always sentence boundaries.
  function splitSentences(text) {
    const spans = [];
    let start = 0;
    const re = /[.!?…]+["'”’)\]]*\s+(?=[A-Z0-9"'“‘(\[¿¡•—-])/g;
    let m;
    const ABBR = /(?:^|\s|\()(?:e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|Prof|St|No|Fig|Inc|Ltd|Co|Jr|Sr|U\.S|U\.K|a\.m|p\.m|[A-Z])$/;
    while ((m = re.exec(text))) {
      if (ABBR.test(text.slice(Math.max(0, m.index - 8), m.index))) continue; // "e.g. VAT" is not a boundary
      spans.push([start, m.index + m[0].length]);
      start = m.index + m[0].length;
    }
    spans.push([start, text.length]);
    // hard-split anything too long at a word boundary; drop pure whitespace
    const out = [];
    for (let [s, e] of spans) {
      while (e - s > MAX_LEN) {
        let cut = text.lastIndexOf(" ", s + MAX_LEN);
        if (cut <= s + MAX_LEN / 2) cut = s + MAX_LEN;
        out.push(trimSpan(text, s, cut)); s = cut;
      }
      out.push(trimSpan(text, s, e));
    }
    return out.filter(([s, e]) => e > s);
  }
  function trimSpan(text, s, e) {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    return [s, e];
  }

  function rangeFor(sent) {
    const locate = (off, preferEnd) => {
      for (const x of sent.nodes) {
        if (off < x.end || (preferEnd && off === x.end)) return [x.node, Math.max(0, off - x.start)];
      }
      const last = sent.nodes[sent.nodes.length - 1];
      return [last.node, last.node.nodeValue.length];
    };
    try {
      const r = new Range();
      const [sn, so] = locate(sent.s, false);
      const [en, eo] = locate(sent.e, true);
      r.setStart(sn, so); r.setEnd(en, eo);
      return r;
    } catch { return null; }
  }

  // ------------------------------------------------------------- questions
  const lid = (i) => "S" + String(i + 1).padStart(2, "0");

  function buildRequest(query, lines) {
    const passage = lines.map((t, i) => `${lid(i)}| ${t}`).join("\n");
    const questions = {};
    lines.forEach((_, i) => {
      const id = lid(i);
      questions[id] = {
        type: "noul",
        instructions: {
          question: `Does line ${id} of \`passage\` contain, state, or clearly express what \`query\` is looking for?`,
          focus: `Match meaning and intent, not exact words. A paraphrase counts; a line that merely shares vocabulary with the query does not. Other lines are context only: judge ${id} by itself.`,
          line: id,
        },
        criteria: {
          true: `Line ${id} says, or directly implies, the thing the query is looking for. A reader searching for this would want to land here.`,
          false: `Line ${id} is about something else, or only overlaps with the query in wording.`,
        },
      };
    });
    return { state: { query, passage }, questions };
  }

  // --------------------------------------------------------------- search
  let debounceTimer = null;
  function scheduleSearch() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 650);
  }

  async function runSearch() {
    const q = ui.input.value.trim();
    state.query = q;
    const gen = ++state.generation;
    state.matches = []; state.current = -1; state.literal = new Set();
    if (q.length < 2) { paint(); setStatus(""); return; }

    state.settings = await send({ type: "settings" }); // re-read each search: the key may have just been added
    if (!state.settings.apiKey) {
      paint(); setStatus("No API key yet.", "settings"); return;
    }
    if (!state.sentences.length) state.sentences = extract();
    const sents = state.sentences;

    // what plain ctrl-F would have found, for the comparison line
    const ql = q.toLowerCase();
    sents.forEach((s, i) => { if (s.text.toLowerCase().includes(ql)) state.literal.add(i); });

    const N = Math.max(5, Math.min(60, state.settings.windowSize || 25));
    const windows = [];
    for (let i = 0; i < sents.length; i += N) windows.push({ from: i, lines: sents.slice(i, i + N).map((s) => s.text) });
    state.total = windows.length; state.pending = windows.length; state.usage = 0;
    for (const s of sents) s.p = undefined;
    setStatus(`Judging ${sents.length} sentences in ${windows.length} passes…`);
    paint();

    const conc = Math.max(1, Math.min(8, state.settings.concurrency || 4));
    let cursor = 0, failed = null;
    const worker = async () => {
      while (cursor < windows.length && gen === state.generation) {
        const w = windows[cursor++];
        const key = hash(q + "\u0000" + w.lines.join("\u0001"));
        let answers = state.cache.get(key);
        if (!answers) {
          const res = await send({ type: "judge", ...buildRequest(q, w.lines) });
          if (gen !== state.generation) return;
          if (res.error) { failed = res.error; state.pending--; continue; }
          answers = res.answers; state.cache.set(key, answers);
          state.usage += res.usage?.input_tokens || 0;
        }
        w.lines.forEach((_, i) => {
          const a = answers[lid(i)];
          sents[w.from + i].p = a && typeof a.noul === "number" ? a.noul : 0;
        });
        state.pending--;
        collect(); paint();
        setStatus(state.pending ? `Judging… ${state.total - state.pending}/${state.total}` : "");
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    if (gen !== state.generation) return;
    if (failed) {
      const msg = failed === "bad_key" ? "API key rejected." : failed === "no_key" ? "No API key yet." : `Jev error: ${failed}`;
      setStatus(msg, failed === "bad_key" || failed === "no_key" ? "settings" : null);
    } else {
      collect(); paint();
      if (state.matches.length && state.current < 0) goTo(0);
      summarize();
    }
  }

  function collect() {
    state.matches = [];
    state.sentences.forEach((s, i) => { if (s.p !== undefined && s.p >= state.threshold) state.matches.push(i); });
    if (state.current >= state.matches.length) state.current = state.matches.length ? 0 : -1;
  }

  function summarize() {
    const n = state.matches.length, lit = state.literal.size;
    const onlyJev = state.matches.filter((i) => !state.literal.has(i)).length;
    let s = n === 0 ? "Nothing on this page reads as a match." : `${n} match${n === 1 ? "" : "es"}`;
    if (n) s += lit ? ` · ctrl-F would find ${lit}` : " · ctrl-F would find none";
    if (n && onlyJev && lit) s += ` · ${onlyJev} only here`;
    setStatus(s);
  }

  // -------------------------------------------------------------- painting
  const HL = {};
  function ensureHighlights() {
    if (!("highlights" in CSS)) return false;
    for (const k of ["hi", "mid", "cur", "lit"]) {
      if (!HL[k]) { HL[k] = new Highlight(); CSS.highlights.set("jevfind-" + k, HL[k]); }
    }
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = `
        ::highlight(jevfind-hi){background-color:rgba(24,168,178,.42)}
        ::highlight(jevfind-mid){background-color:rgba(24,168,178,.16)}
        ::highlight(jevfind-cur){background-color:rgba(24,168,178,.92);color:#fff}
        ::highlight(jevfind-lit){text-decoration:underline dotted;text-decoration-color:rgba(24,168,178,.9);text-decoration-thickness:2px}
        @media (prefers-color-scheme:dark){
          ::highlight(jevfind-hi){background-color:rgba(64,205,214,.38)}
          ::highlight(jevfind-mid){background-color:rgba(64,205,214,.15)}
          ::highlight(jevfind-cur){background-color:rgba(64,205,214,.95);color:#0b1516}
        }`;
      document.head.appendChild(st);
    }
    return true;
  }

  function paint() {
    if (!ensureHighlights()) { setStatus("Needs Chrome 105+ (CSS Custom Highlight API)."); return; }
    for (const k in HL) HL[k].clear();
    if (!state.query) { updateCount(); return; }
    state.sentences.forEach((s, i) => {
      const r = rangeFor(s); if (!r) return;
      if (state.literal.has(i)) HL.lit.add(r);
      if (s.p === undefined || s.p < state.threshold) return;
      if (i === state.matches[state.current]) HL.cur.add(r);
      else HL[s.p >= HI_CUT ? "hi" : "mid"].add(r);
    });
    updateCount();
  }

  function goTo(idx) {
    if (!state.matches.length) return;
    state.current = (idx + state.matches.length) % state.matches.length;
    const s = state.sentences[state.matches[state.current]];
    const r = rangeFor(s);
    if (r) {
      const rect = r.getBoundingClientRect();
      const y = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }
    paint();
    ui.prob.textContent = s.p !== undefined ? s.p.toFixed(2) : "";
  }

  // ------------------------------------------------------------------- ui
  const ui = {};
  function buildUI() {
    const host = document.createElement("div");
    host.id = "jevfind-host";
    host.style.cssText = "all:initial;position:fixed;top:12px;right:14px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host{all:initial}
        *{box-sizing:border-box}
        .bar{font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#e9f3f3;
          background:rgba(20,26,28,.94);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
          border:1px solid rgba(255,255,255,.08);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);
          width:420px;max-width:calc(100vw - 28px);padding:8px 10px 8px 12px}
        .row{display:flex;align-items:center;gap:8px}
        input[type=text]{flex:1;min-width:0;font:inherit;font-size:14px;color:#fff;background:transparent;border:0;outline:0;padding:4px 0}
        input[type=text]::placeholder{color:rgba(233,243,243,.45)}
        .count{color:rgba(233,243,243,.6);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:44px;text-align:right}
        .prob{color:#40cdd6;font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
        button{font:inherit;color:#e9f3f3;background:transparent;border:0;border-radius:7px;width:26px;height:26px;cursor:pointer;
          display:inline-flex;align-items:center;justify-content:center;padding:0}
        button:hover{background:rgba(255,255,255,.1)}
        button:focus-visible{outline:2px solid #40cdd6;outline-offset:1px}
        .sep{width:1px;height:18px;background:rgba(255,255,255,.12)}
        .status{display:flex;align-items:center;gap:8px;margin-top:6px;color:rgba(233,243,243,.62);font-size:12px;min-height:16px}
        .status a{color:#40cdd6;text-decoration:none;cursor:pointer}
        .status a:hover{text-decoration:underline}
        .thr{display:flex;align-items:center;gap:6px;margin-left:auto;color:rgba(233,243,243,.62)}
        input[type=range]{width:74px;accent-color:#40cdd6;height:14px}
        .label{font-size:12px;width:auto;padding:0 6px;color:rgba(233,243,243,.75)}
        .label.on{color:#40cdd6}
        svg{display:block}
      </style>
      <div class="bar" role="search" aria-label="Jev Find">
        <div class="row">
          <input type="text" placeholder="Find by meaning…" spellcheck="false" autocomplete="off" aria-label="Find by meaning">
          <span class="prob" title="Jev's probability for the current match"></span>
          <span class="count" aria-live="polite"></span>
          <button class="prev" title="Previous (Shift+Enter)" aria-label="Previous match">${chev(true)}</button>
          <button class="next" title="Next (Enter)" aria-label="Next match">${chev(false)}</button>
          <span class="sep"></span>
          <button class="close" title="Close (Esc)" aria-label="Close">${x()}</button>
        </div>
        <div class="row status">
          <span class="msg"></span>
          <span class="thr"><button class="label yes" title="This match is right (saves a label)">yes</button><button class="label no" title="This match is wrong (saves a label)">no</button>
            <input type="range" min="0.2" max="0.9" step="0.05" title="Threshold: how sure Jev must be before a sentence is highlighted"></span>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    ui.host = host; ui.root = root;
    ui.input = root.querySelector("input[type=text]");
    ui.count = root.querySelector(".count"); ui.prob = root.querySelector(".prob"); ui.msg = root.querySelector(".msg");
    ui.range = root.querySelector("input[type=range]"); ui.range.value = state.threshold;
    ui.yes = root.querySelector(".yes"); ui.no = root.querySelector(".no");

    ui.input.addEventListener("input", () => { ui.prob.textContent = ""; scheduleSearch(); });
    ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (ui.input.value.trim() !== state.query) { clearTimeout(debounceTimer); runSearch(); }
        else goTo(state.current + (e.shiftKey ? -1 : 1));
      } else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    root.querySelector(".prev").onclick = () => goTo(state.current - 1);
    root.querySelector(".next").onclick = () => goTo(state.current + 1);
    root.querySelector(".close").onclick = close;
    ui.range.addEventListener("input", () => {
      state.threshold = parseFloat(ui.range.value);
      ui.range.title = `Threshold ${state.threshold.toFixed(2)}`;
      collect(); paint(); if (!state.pending && state.query) summarize();
    });
    ui.yes.onclick = () => label(true);
    ui.no.onclick = () => label(false);
  }
  const chev = (up) => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${up ? "M3 9l4-4 4 4" : "M3 5l4 4 4-4"}"/></svg>`;
  const x = () => `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>`;

  function updateCount() {
    const n = state.matches.length;
    ui.count.textContent = !state.query ? "" : n ? `${state.current + 1}/${n}` : (state.pending ? "…" : "0");
    ui.yes.disabled = ui.no.disabled = !n;
  }
  function setStatus(text, action) {
    ui.msg.innerHTML = "";
    ui.msg.append(text);
    if (action === "settings") {
      const a = document.createElement("a"); a.textContent = "Add one in settings";
      a.onclick = () => send({ type: "openOptions" });
      ui.msg.append(" ", a);
    }
  }

  // Every yes/no on a match is a label: (query, sentence, p, verdict). The
  // decision loop is the asset; this is where its ground truth comes from.
  async function label(correct) {
    if (state.current < 0) return;
    const s = state.sentences[state.matches[state.current]];
    await send({ type: "label", label: { ts: Date.now(), url: location.href, query: state.query, text: s.text, p: s.p, correct } });
    (correct ? ui.yes : ui.no).classList.add("on");
    setTimeout(() => (correct ? ui.yes : ui.no).classList.remove("on"), 700);
    goTo(state.current + 1);
  }

  function open() {
    if (!ui.host) buildUI();
    ui.host.style.display = "";
    state.open = true;
    state.sentences = []; // re-extract each open; pages change
    const sel = String(getSelection() || "").trim();
    if (sel && sel.length < 120 && !ui.input.value) ui.input.value = sel;
    ui.input.focus(); ui.input.select();
    if (ui.input.value.trim()) scheduleSearch();
  }
  function close() {
    state.open = false; state.generation++;
    if (ui.host) ui.host.style.display = "none";
    for (const k in HL) HL[k].clear();
  }
  function toggle() { state.open ? close() : open(); }

  const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(res || { error: chrome.runtime.lastError?.message || "no response" })));
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

  chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "toggle") toggle(); });
  window.__jevfind = { toggle, open, close };
})();
