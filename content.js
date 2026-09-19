// Jev Find — content script.
// Find scores sentences. Digest selects and annotates a short reading path
// through paragraph-sized passages. Jev only points to the author's words.

(() => {
  if (window.__jevfind) return;

  const HI_CUT = 0.72;
  const MIN_SENTENCE_LEN = 12;
  const MAX_SENTENCE_LEN = 480;
  const MIN_CHUNK_LEN = 40;
  const MAX_CHUNK_LEN = 960;
  const MIN_DIGEST_ITEMS = 3;
  const MAX_DIGEST_ITEMS = 7;
  const STYLE_ID = "jevfind-style";
  const ROLE_LABELS = {
    direct_answer: "Direct answer",
    background: "Background",
    reasoning: "Explanation",
    evidence: "Evidence",
    qualification: "Important exception",
    counterpoint: "Counterpoint",
    irrelevant: "Not needed",
  };
  const ROLE_ORDER = ["direct_answer", "background", "reasoning", "evidence", "qualification", "counterpoint"];

  const BLOCK_TAGS = new Set(["P", "DIV", "LI", "TD", "TH", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE",
    "ARTICLE", "SECTION", "DD", "DT", "FIGCAPTION", "SUMMARY", "CAPTION", "LABEL", "MAIN", "ASIDE", "HEADER", "FOOTER",
    "NAV", "UL", "OL", "TABLE", "TR", "BODY", "DETAILS", "FIELDSET", "FORM"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "CANVAS",
    "IFRAME", "CODE", "KBD", "TEMPLATE", "HEAD", "TITLE", "BUTTON"]);

  const state = {
    open: false, mode: "find", query: "", sentences: [], chunks: [], matches: [], current: -1, threshold: 0.45,
    generation: 0, literal: new Set(), cache: new Map(), settings: null, pending: 0, total: 0, usage: 0,
    digestCompact: false, pathOpen: false,
  };

  // ------------------------------------------------------------ extraction
  const blockCache = new WeakMap();
  function isBlock(el) {
    if (blockCache.has(el)) return blockCache.get(el);
    let block = BLOCK_TAGS.has(el.tagName);
    if (!block) {
      const display = getComputedStyle(el).display;
      block = display !== "inline" && display !== "inline-block" && display !== "contents" && display !== "inline-flex" && display !== "inline-grid";
    }
    blockCache.set(el, block);
    return block;
  }
  function nearestBlock(node) {
    let el = node.parentElement;
    while (el && el !== document.body && !isBlock(el)) el = el.parentElement;
    return el || document.body;
  }
  function skippable(el) {
    for (let e = el; e; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName) || (e.id && e.id.startsWith("jevfind-"))) return true;
      if (e.getAttribute && e.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
  }
  function extractBlocks() {
    const grouped = new Map();
    const order = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (skippable(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const block = nearestBlock(node);
      if (!grouped.has(block)) { grouped.set(block, []); order.push(block); }
      const nodes = grouped.get(block);
      const start = nodes.length ? nodes[nodes.length - 1].end : 0;
      nodes.push({ node, start, end: start + node.nodeValue.length });
    }
    return order.filter((block) => block.getClientRects().length > 0).map((block) => {
      const nodes = grouped.get(block);
      return { block, nodes, text: nodes.map((x) => x.node.nodeValue).join("") };
    });
  }
  function extractSentences() {
    const out = [];
    for (const item of extractBlocks()) {
      for (const [s, e] of splitSentences(item.text)) {
        const text = cleanText(item.text.slice(s, e));
        if (text.length >= MIN_SENTENCE_LEN) out.push({ text, nodes: item.nodes, s, e, block: item.block });
      }
    }
    return out;
  }
  function extractChunks() {
    const out = [];
    let heading = "";
    for (const item of extractBlocks()) {
      const text = cleanText(item.text);
      if (/^H[1-6]$/.test(item.block.tagName)) { heading = text; continue; }
      if (text.length < MIN_CHUNK_LEN) continue;
      const spans = splitSentences(item.text);
      let group = [], length = 0;
      const flush = () => {
        if (!group.length) return;
        const s = group[0][0], e = group[group.length - 1][1];
        const chunkText = cleanText(item.text.slice(s, e));
        if (chunkText.length >= MIN_CHUNK_LEN) out.push({ text: chunkText, heading, nodes: item.nodes, s, e, block: item.block });
        group = []; length = 0;
      };
      for (const span of spans) {
        const spanLength = span[1] - span[0];
        if (group.length && length + spanLength > MAX_CHUNK_LEN) flush();
        group.push(span); length += spanLength;
      }
      flush();
    }
    return out;
  }
  function cleanText(text) { return text.replace(/\s+/g, " ").trim(); }
  function splitSentences(text) {
    const spans = [];
    let start = 0;
    const boundary = /[.!?…]+["'”’)\]]*\s+(?=[A-Z0-9"'“‘(\[¿¡•—-])/g;
    const abbreviation = /(?:^|\s|\()(?:e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|Prof|St|No|Fig|Inc|Ltd|Co|Jr|Sr|U\.S|U\.K|a\.m|p\.m|[A-Z])$/;
    let match;
    while ((match = boundary.exec(text))) {
      if (abbreviation.test(text.slice(Math.max(0, match.index - 8), match.index))) continue;
      spans.push([start, match.index + match[0].length]);
      start = match.index + match[0].length;
    }
    spans.push([start, text.length]);
    const out = [];
    for (let [s, e] of spans) {
      while (e - s > MAX_SENTENCE_LEN) {
        let cut = text.lastIndexOf(" ", s + MAX_SENTENCE_LEN);
        if (cut <= s + MAX_SENTENCE_LEN / 2) cut = s + MAX_SENTENCE_LEN;
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
  function rangeFor(item) {
    const locate = (offset, preferEnd) => {
      for (const part of item.nodes) {
        if (offset < part.end || (preferEnd && offset === part.end)) return [part.node, Math.max(0, offset - part.start)];
      }
      const last = item.nodes[item.nodes.length - 1];
      return [last.node, last.node.nodeValue.length];
    };
    try {
      const range = new Range();
      const [sn, so] = locate(item.s, false), [en, eo] = locate(item.e, true);
      range.setStart(sn, so); range.setEnd(en, eo); return range;
    } catch { return null; }
  }

  // ------------------------------------------------------------- questions
  const findId = (i) => "S" + String(i + 1).padStart(2, "0");
  const chunkId = (i) => "P" + String(i + 1).padStart(2, "0");
  function buildFindRequest(query, lines) {
    const passage = lines.map((text, i) => `${findId(i)}| ${text}`).join("\n");
    const questions = {};
    lines.forEach((_, i) => {
      const id = findId(i);
      questions[id] = {
        type: "noul",
        instructions: {
          question: `Does line ${id} of \`passage\` contain, state, or clearly express what \`query\` is looking for?`,
          focus: `Match meaning and intent, not exact words. A paraphrase counts; a line that merely shares vocabulary with the query does not. Other lines are context only: judge ${id} by itself.`,
        },
        criteria: { true: `Line ${id} directly expresses what the query seeks.`, false: `Line ${id} is about something else or merely shares wording.` },
      };
    });
    return { state: { query, passage }, questions };
  }
  function buildDigestRequest(question, chunks) {
    const passages = chunks.map((chunk, i) => `${chunkId(i)}|${chunk.heading ? ` [under heading: ${chunk.heading}]` : ""} ${chunk.text}`).join("\n");
    const questions = {};
    chunks.forEach((_, i) => {
      const id = chunkId(i);
      questions[`${id}_needed`] = {
        type: "noul",
        instructions: {
          question: `Does passage ${id} contain information a reader needs to understand or accurately answer \`question\`?`,
          focus: `Judge ${id} itself. Include direct answers, necessary background, reasoning, evidence, important qualifications, and genuine counterpoints. Mere topic overlap is not enough.`,
        },
        criteria: {
          true: `Omitting ${id} could leave the reader with an incomplete, misleading, or poorly supported understanding.`,
          false: `${id} is irrelevant, redundant, or unnecessary for understanding the answer.`,
        },
      };
      questions[`${id}_role`] = {
        type: "choice",
        instructions: `What is passage ${id}'s most useful role in helping a reader understand or answer \`question\`? Judge ${id} itself.`,
        criteria: {
          direct_answer: "States or directly implies the answer.",
          background: "Defines or establishes context required to understand the answer.",
          reasoning: "Explains why or how the answer works.",
          evidence: "Provides support, data, a concrete example, or an illustrative case.",
          qualification: "Adds an important condition, exception, limitation, or caveat.",
          counterpoint: "Presents a conflicting view, tension, or alternative conclusion.",
          irrelevant: "Does not materially help the reader understand or answer the question.",
        },
      };
    });
    return { state: { question, passages }, questions };
  }

  // --------------------------------------------------------------- search
  let debounceTimer = null;
  function scheduleSearch() {
    clearTimeout(debounceTimer);
    if (state.mode === "find") debounceTimer = setTimeout(runSearch, 650);
    else setStatus("Press Enter to build a reading path.");
  }
  async function runSearch() {
    const query = ui.input.value.trim();
    state.query = query;
    const mode = state.mode, generation = ++state.generation;
    state.matches = []; state.current = -1; state.literal = new Set();
    if (query.length < 2) { paint(); setStatus(""); return; }
    state.settings = await send({ type: "settings" });
    if (!state.settings.apiKey) { paint(); setStatus("No API key yet.", "settings"); return; }
    if (mode === "digest") setDigestCompact(false);
    if (mode === "digest") await runDigest(query, generation);
    else await runFind(query, generation);
  }
  async function runFind(query, generation) {
    if (!state.sentences.length) state.sentences = extractSentences();
    const items = state.sentences, queryLower = query.toLowerCase();
    items.forEach((item, i) => { if (item.text.toLowerCase().includes(queryLower)) state.literal.add(i); });
    const size = Math.max(5, Math.min(60, state.settings.windowSize || 25));
    const windows = makeWindows(items, size);
    prepareRun(items, windows, `Judging ${items.length} sentences in ${windows.length} passes…`);
    const failed = await runWindows(windows, generation, (window) => {
      const lines = window.items.map((item) => item.text);
      return { cacheKey: `find\0${state.query}\0${lines.join("\1")}`, request: buildFindRequest(state.query, lines) };
    }, (window, answers) => window.items.forEach((item, i) => {
      const answer = answers[findId(i)]; item.p = answer && typeof answer.noul === "number" ? answer.noul : 0;
    }));
    finishRun(generation, failed);
  }
  async function runDigest(question, generation) {
    if (!state.chunks.length) state.chunks = extractChunks();
    const items = state.chunks;
    const size = Math.max(4, Math.min(16, Math.floor((state.settings.windowSize || 25) / 2)));
    const windows = makeWindows(items, size);
    prepareRun(items, windows, `Reading ${items.length} passages in ${windows.length} passes…`);
    const failed = await runWindows(windows, generation, (window) => {
      const signature = window.items.map((item) => `${item.heading}\0${item.text}`).join("\1");
      return { cacheKey: `digest\0${state.query}\0${signature}`, request: buildDigestRequest(state.query, window.items) };
    }, (window, answers) => window.items.forEach((item, i) => {
      const id = chunkId(i), needed = answers[`${id}_needed`], role = answers[`${id}_role`];
      item.p = needed && typeof needed.noul === "number" ? needed.noul : 0;
      item.role = role && ROLE_LABELS[role.choice] ? role.choice : "irrelevant";
      item.roleP = role?.probabilities && typeof role.probabilities[item.role] === "number" ? role.probabilities[item.role] : 0;
      item.roleConfidence = role && typeof role.confidence === "number" ? role.confidence : 0;
    }));
    finishRun(generation, failed);
  }
  function makeWindows(items, size) {
    const windows = [];
    for (let i = 0; i < items.length; i += size) windows.push({ from: i, items: items.slice(i, i + size) });
    return windows;
  }
  function prepareRun(items, windows, message) {
    state.total = windows.length; state.pending = windows.length; state.usage = 0;
    for (const item of items) { item.p = undefined; delete item.role; delete item.roleP; delete item.roleConfidence; }
    setStatus(message); paint();
  }
  async function runWindows(windows, generation, describe, applyAnswers) {
    const concurrency = Math.max(1, Math.min(8, state.settings.concurrency || 4));
    let cursor = 0, failed = null;
    const worker = async () => {
      while (cursor < windows.length && generation === state.generation) {
        const window = windows[cursor++];
        const { cacheKey, request } = describe(window), key = hash(cacheKey);
        let answers = state.cache.get(key);
        if (!answers) {
          const response = await send({ type: "judge", ...request });
          if (generation !== state.generation) return;
          if (response.error) { failed = response.error; state.pending--; continue; }
          answers = response.answers; state.cache.set(key, answers); state.usage += response.usage?.input_tokens || 0;
        }
        applyAnswers(window, answers); state.pending--; collect(); paint();
        setStatus(state.pending ? `${state.mode === "digest" ? "Reading" : "Judging"}… ${state.total - state.pending}/${state.total}` : "");
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return failed;
  }
  function finishRun(generation, failed) {
    if (generation !== state.generation) return;
    if (failed) {
      const message = failed === "bad_key" ? "API key rejected." : failed === "no_key" ? "No API key yet." : `Jev error: ${failed}`;
      setStatus(message, failed === "bad_key" || failed === "no_key" ? "settings" : null); return;
    }
    collect();
    if (state.mode === "digest" && state.matches.length) setDigestCompact(false);
    paint(); if (state.matches.length && state.current < 0) goTo(0); summarize();
  }
  function collect() {
    if (state.mode === "digest") collectDigest();
    else { state.matches = []; state.sentences.forEach((item, i) => { if (item.p !== undefined && item.p >= state.threshold) state.matches.push(i); }); }
    if (state.current >= state.matches.length) state.current = state.matches.length ? 0 : -1;
  }
  function collectDigest() {
    const available = state.chunks.map((item, index) => ({ item, index, score: digestScore(item) }))
      .filter(({ item }) => item.p !== undefined && item.p >= state.threshold && item.role !== "irrelevant")
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = [], picked = new Set();
    const add = (candidate) => {
      if (!candidate || picked.has(candidate.index) || selected.length >= MAX_DIGEST_ITEMS) return;
      picked.add(candidate.index); selected.push(candidate);
    };
    for (const role of ROLE_ORDER) add(available.find(({ item }) => item.role === role));
    for (const candidate of available) {
      if (selected.length >= MIN_DIGEST_ITEMS && candidate.item.p < Math.max(0.62, state.threshold)) break;
      add(candidate);
    }
    state.matches = selected.sort((a, b) => a.index - b.index).map(({ index }) => index);
  }
  function digestScore(item) {
    const weight = item.role === "direct_answer" ? 1 : item.role === "qualification" || item.role === "counterpoint" ? 0.96 : 0.9;
    return (item.p || 0) * weight * (0.8 + 0.2 * (item.roleP || 0));
  }
  function summarize() {
    const count = state.matches.length;
    if (state.mode === "digest") {
      if (!count) { setStatus("No clear reading path found on this page."); return; }
      const roles = [...new Set(state.matches.map((i) => ROLE_LABELS[state.chunks[i].role]))];
      setStatus(`${count} passage${count === 1 ? "" : "s"} · ${roles.join(" · ")}`); return;
    }
    const literal = state.literal.size, onlyJev = state.matches.filter((i) => !state.literal.has(i)).length;
    let message = count === 0 ? "Nothing on this page reads as a match." : `${count} match${count === 1 ? "" : "es"}`;
    if (count) message += literal ? ` · ctrl-F would find ${literal}` : " · ctrl-F would find none";
    if (count && onlyJev && literal) message += ` · ${onlyJev} only here`;
    setStatus(message);
  }

  // -------------------------------------------------------------- painting
  const HL = {};
  function ensureHighlights() {
    if (!("highlights" in CSS)) return false;
    for (const key of ["hi", "mid", "cur", "digestcur", "lit", "answer", "context", "evidence", "caveat"]) {
      if (!HL[key]) { HL[key] = new Highlight(); CSS.highlights.set("jevfind-" + key, HL[key]); }
    }
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style"); style.id = STYLE_ID;
      style.textContent = `
        ::highlight(jevfind-hi){background-color:rgba(24,168,178,.42)} ::highlight(jevfind-mid){background-color:rgba(24,168,178,.16)}
        ::highlight(jevfind-cur){background-color:rgba(24,168,178,.92);color:#fff} ::highlight(jevfind-lit){text-decoration:underline dotted;text-decoration-color:rgba(24,168,178,.9);text-decoration-thickness:2px}
        ::highlight(jevfind-digestcur){background-color:rgba(24,168,178,.28);text-decoration:underline;text-decoration-color:rgba(24,168,178,.95);text-decoration-thickness:3px}
        ::highlight(jevfind-answer){background-color:rgba(24,168,178,.38)} ::highlight(jevfind-context){background-color:rgba(104,126,255,.24)}
        ::highlight(jevfind-evidence){background-color:rgba(86,180,110,.25)} ::highlight(jevfind-caveat){background-color:rgba(242,166,54,.30)}
        @media (prefers-color-scheme:dark){::highlight(jevfind-hi){background-color:rgba(64,205,214,.38)} ::highlight(jevfind-mid){background-color:rgba(64,205,214,.15)} ::highlight(jevfind-cur){background-color:rgba(64,205,214,.95);color:#0b1516}}`;
      document.head.appendChild(style);
    }
    return true;
  }
  function paint() {
    if (!ensureHighlights()) { setStatus("Needs Chrome 105+ (CSS Custom Highlight API)."); return; }
    for (const key in HL) HL[key].clear();
    clearMarkers();
    if (!state.query) { updateCount(); renderDigestPath(); return; }
    if (state.mode === "digest") paintDigest(); else paintFind();
    updateCount(); renderDigestPath();
  }
  function paintFind() {
    state.sentences.forEach((item, i) => {
      const range = rangeFor(item); if (!range) return;
      if (state.literal.has(i)) HL.lit.add(range);
      if (item.p === undefined || item.p < state.threshold) return;
      if (i === state.matches[state.current]) HL.cur.add(range); else HL[item.p >= HI_CUT ? "hi" : "mid"].add(range);
    });
  }
  function paintDigest() {
    state.matches.forEach((itemIndex, pathIndex) => {
      const item = state.chunks[itemIndex], range = rangeFor(item); if (!range) return;
      if (itemIndex === state.matches[state.current]) HL.digestcur.add(range); else HL[highlightForRole(item.role)].add(range);
      addMarker(range, pathIndex + 1, ROLE_LABELS[item.role] || "Read");
    });
  }
  function highlightForRole(role) {
    if (role === "direct_answer") return "answer";
    if (role === "qualification" || role === "counterpoint") return "caveat";
    if (role === "evidence") return "evidence";
    return "context";
  }
  let markerHost = null;
  function clearMarkers() { if (markerHost) { markerHost.remove(); markerHost = null; } }
  function addMarker(range, number, label) {
    if (!markerHost) {
      markerHost = document.createElement("div"); markerHost.id = "jevfind-markers";
      markerHost.style.cssText = "all:initial;position:absolute;inset:0;z-index:2147483645;pointer-events:none;";
      markerHost.attachShadow({ mode: "open" }).innerHTML = `<style>.marker{position:absolute;display:flex;align-items:center;gap:5px;font:600 11px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:#182326;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:3px 7px 3px 4px;box-shadow:0 2px 9px rgba(0,0,0,.28);white-space:nowrap}.n{display:grid;place-items:center;width:17px;height:17px;border-radius:50%;background:#18a8b2;font-variant-numeric:tabular-nums}</style>`;
      document.documentElement.appendChild(markerHost);
    }
    const rect = range.getBoundingClientRect(), marker = document.createElement("div"); marker.className = "marker";
    marker.style.left = `${Math.max(6, window.scrollX + rect.left - 26)}px`; marker.style.top = `${Math.max(0, window.scrollY + rect.top - 23)}px`;
    const n = document.createElement("span"); n.className = "n"; n.textContent = number;
    const text = document.createElement("span"); text.textContent = label;
    marker.append(n, text); markerHost.shadowRoot.appendChild(marker);
  }
  function goTo(index) {
    if (!state.matches.length) return;
    state.current = (index + state.matches.length) % state.matches.length;
    const item = activeItems()[state.matches[state.current]], range = rangeFor(item);
    if (range) {
      const rect = range.getBoundingClientRect(), y = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }
    paint(); ui.prob.textContent = item.p !== undefined ? item.p.toFixed(2) : "";
  }
  function activeItems() { return state.mode === "digest" ? state.chunks : state.sentences; }

  // ------------------------------------------------------------------- UI
  const ui = {};
  function buildUI() {
    const host = document.createElement("div"); host.id = "jevfind-host";
    host.style.cssText = "all:initial;position:fixed;top:12px;right:14px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{all:initial} *{box-sizing:border-box}.bar{font:13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#e9f3f3;background:rgba(20,26,28,.96);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.08);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);width:480px;max-width:calc(100vw - 28px);padding:8px 10px}.row{display:flex;align-items:center;gap:8px}.modes{display:flex;background:rgba(255,255,255,.07);border-radius:7px;padding:2px}button{font:inherit;color:#e9f3f3;background:transparent;border:0;border-radius:6px;width:26px;height:26px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}button:hover{background:rgba(255,255,255,.1)}button:focus-visible{outline:2px solid #40cdd6;outline-offset:1px}.mode{width:auto;height:22px;padding:0 7px;color:rgba(233,243,243,.62);font-size:11px}.mode.active{color:#fff;background:rgba(64,205,214,.22)}input[type=text]{flex:1;min-width:0;font:inherit;font-size:14px;color:#fff;background:transparent;border:0;outline:0;padding:4px 0}input[type=text]::placeholder{color:rgba(233,243,243,.45)}.count{color:rgba(233,243,243,.6);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:38px;text-align:right}.prob{color:#40cdd6;font-variant-numeric:tabular-nums;min-width:34px;text-align:right}.sep{width:1px;height:18px;background:rgba(255,255,255,.12)}.status{display:flex;align-items:center;gap:8px;margin-top:6px;color:rgba(233,243,243,.62);font-size:12px;min-height:16px}.status a{color:#40cdd6;text-decoration:none;cursor:pointer}.thr{display:flex;align-items:center;gap:6px;margin-left:auto}.thr input{width:74px;accent-color:#40cdd6;height:14px}.label{font-size:12px;width:auto;padding:0 6px;color:rgba(233,243,243,.75)}.label.on{color:#40cdd6}.path{display:none;margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.08);max-height:240px;overflow:auto}.bar.digest .path{display:block}.path:empty{display:none}.path-item{display:grid;grid-template-columns:20px 95px 1fr;gap:7px;align-items:start;width:100%;height:auto;padding:6px;text-align:left;border-radius:7px;color:rgba(233,243,243,.78)}.path-item.active{background:rgba(64,205,214,.15);color:#fff}.path-number{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#18a8b2;color:#fff;font-size:11px;font-weight:700}.path-role{color:#40cdd6;font-size:11px;padding-top:2px}.path-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;padding-top:1px}svg{display:block}
      .digest-label,.current-role,.path-toggle,.collapse-toggle{display:none}.drag{cursor:grab;color:rgba(233,243,243,.5)}.drag:active{cursor:grabbing}
      .bar.digest .path{display:none}.bar.digest.path-open .path{display:block}.bar.digest.compact{width:360px;padding:6px 8px}.bar.digest.compact.path-open{width:480px}
      .bar.digest.compact .modes,.bar.digest.compact input[type=text],.bar.digest.compact .prob,.bar.digest.compact .status{display:none}
      .bar.digest.compact .digest-label,.bar.digest.compact .current-role,.bar.digest.has-results .path-toggle,.bar.digest.has-results:not(.compact) .collapse-toggle{display:inline-flex}
      .digest-label{width:auto;padding:0 8px;background:rgba(64,205,214,.18);color:#fff}.current-role{flex:1;min-width:0;color:#40cdd6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar.digest.compact .count{min-width:32px}
    </style><div class="bar" role="search" aria-label="Jev Find"><div class="row"><button class="drag" title="Move panel" aria-label="Move panel">${dragIcon()}</button><span class="modes"><button class="mode active" data-mode="find">Find</button><button class="mode" data-mode="digest">Digest</button></span><button class="digest-label" title="Expand digest">Digest</button><span class="current-role"></span><input type="text" placeholder="Find by meaning…" spellcheck="false" autocomplete="off" aria-label="Find by meaning"><span class="prob" title="Jev's probability for the current passage"></span><span class="count" aria-live="polite"></span><button class="prev" title="Previous (Shift+Enter)" aria-label="Previous match">${chevron(true)}</button><button class="next" title="Next (Enter)" aria-label="Next match">${chevron(false)}</button><button class="path-toggle" title="Show reading path" aria-label="Show reading path">${listIcon()}</button><button class="collapse-toggle" title="Collapse digest" aria-label="Collapse digest">${collapseIcon()}</button><span class="sep"></span><button class="close" title="Close (Esc)" aria-label="Close">${closeIcon()}</button></div><div class="row status"><span class="msg"></span><span class="thr"><button class="label yes" title="This result belongs here">yes</button><button class="label no" title="This result does not belong here">no</button><input type="range" min="0.2" max="0.9" step="0.05" title="Minimum probability"></span></div><div class="path" aria-label="Digest reading path"></div></div>`;
    document.documentElement.appendChild(host);
    ui.host = host; ui.root = root; ui.bar = root.querySelector(".bar"); ui.input = root.querySelector("input[type=text]");
    ui.count = root.querySelector(".count"); ui.prob = root.querySelector(".prob"); ui.msg = root.querySelector(".msg"); ui.path = root.querySelector(".path");
    ui.currentRole = root.querySelector(".current-role"); ui.pathToggle = root.querySelector(".path-toggle");
    ui.range = root.querySelector("input[type=range]"); ui.range.value = state.threshold; ui.yes = root.querySelector(".yes"); ui.no = root.querySelector(".no");
    ui.input.addEventListener("input", () => { ui.prob.textContent = ""; scheduleSearch(); });
    ui.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (ui.input.value.trim() !== state.query || (state.mode === "digest" && !state.matches.length)) { clearTimeout(debounceTimer); runSearch(); }
        else goTo(state.current + (event.shiftKey ? -1 : 1));
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (state.pathOpen) { state.pathOpen = false; syncPanelState(); }
        else close();
      }
    });
    root.querySelectorAll(".mode").forEach((button) => { button.onclick = () => setMode(button.dataset.mode); });
    root.querySelector(".prev").onclick = () => goTo(state.current - 1); root.querySelector(".next").onclick = () => goTo(state.current + 1); root.querySelector(".close").onclick = close;
    root.querySelector(".digest-label").onclick = () => { setDigestCompact(false); ui.input.focus(); };
    root.querySelector(".collapse-toggle").onclick = () => setDigestCompact(true);
    ui.pathToggle.onclick = () => { state.pathOpen = !state.pathOpen; syncPanelState(); };
    enableDragging(root.querySelector(".drag"));
    restorePanelPosition();
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.target === ui.input) return;
      event.preventDefault();
      if (state.pathOpen) { state.pathOpen = false; syncPanelState(); }
      else close();
    });
    ui.range.addEventListener("input", () => { state.threshold = parseFloat(ui.range.value); collect(); paint(); if (!state.pending && state.query) summarize(); });
    ui.yes.onclick = () => label(true); ui.no.onclick = () => label(false);
  }
  const chevron = (up) => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${up ? "M3 9l4-4 4 4" : "M3 5l4 4 4-4"}"/></svg>`;
  const listIcon = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 3h6M5 7h6M5 11h6"/><circle cx="2.5" cy="3" r=".6" fill="currentColor" stroke="none"/><circle cx="2.5" cy="7" r=".6" fill="currentColor" stroke="none"/><circle cx="2.5" cy="11" r=".6" fill="currentColor" stroke="none"/></svg>`;
  const collapseIcon = () => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 7h8"/></svg>`;
  const dragIcon = () => `<svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor"><circle cx="4" cy="3" r="1"/><circle cx="9" cy="3" r="1"/><circle cx="4" cy="6.5" r="1"/><circle cx="9" cy="6.5" r="1"/><circle cx="4" cy="10" r="1"/><circle cx="9" cy="10" r="1"/></svg>`;
  const closeIcon = () => `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>`;
  function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode; state.generation++; state.query = ""; state.matches = []; state.current = -1; state.pending = 0;
    state.digestCompact = false; state.pathOpen = false;
    ui.bar.classList.toggle("digest", mode === "digest");
    syncPanelState();
    ui.root.querySelectorAll(".mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    ui.input.placeholder = mode === "digest" ? "What do you want to understand?" : "Find by meaning…"; ui.input.setAttribute("aria-label", ui.input.placeholder);
    ui.prob.textContent = ""; paint(); setStatus(mode === "digest" ? "Ask a question, then press Enter." : ""); ui.input.focus();
  }
  function applyDefaultMode() {
    chrome.storage.local.get({ defaultMode: "find" }, ({ defaultMode }) => {
      if ((defaultMode === "digest" || defaultMode === "find") && defaultMode !== state.mode) setMode(defaultMode);
    });
  }
  function setDigestCompact(compact) {
    state.digestCompact = compact;
    state.pathOpen = !compact && state.matches.length > 0;
    syncPanelState();
  }
  function syncPanelState() {
    if (!ui.bar) return;
    ui.bar.classList.toggle("compact", state.mode === "digest" && state.digestCompact);
    ui.bar.classList.toggle("path-open", state.mode === "digest" && state.pathOpen);
    ui.pathToggle?.setAttribute("aria-label", state.pathOpen ? "Hide reading path" : "Show reading path");
    ui.pathToggle?.setAttribute("title", state.pathOpen ? "Hide reading path" : "Show reading path");
    requestAnimationFrame(clampPanelToViewport);
  }
  function updateCount() {
    const count = state.matches.length;
    ui.count.textContent = !state.query ? "" : count ? `${state.current + 1}/${count}` : (state.pending ? "…" : "0");
    ui.yes.disabled = ui.no.disabled = !count;
    ui.bar.classList.toggle("has-results", state.mode === "digest" && count > 0);
    const current = count && state.current >= 0 ? state.chunks[state.matches[state.current]] : null;
    ui.currentRole.textContent = current ? ROLE_LABELS[current.role] || "Read" : "Reading path";
  }
  function renderDigestPath() {
    if (!ui.path) return;
    ui.path.replaceChildren();
    if (state.mode !== "digest") return;
    state.matches.forEach((itemIndex, pathIndex) => {
      const item = state.chunks[itemIndex], button = document.createElement("button");
      button.className = "path-item" + (pathIndex === state.current ? " active" : ""); button.title = item.text;
      const number = document.createElement("span"); number.className = "path-number"; number.textContent = pathIndex + 1;
      const role = document.createElement("span"); role.className = "path-role"; role.textContent = ROLE_LABELS[item.role] || "Read";
      const text = document.createElement("span"); text.className = "path-text"; text.textContent = item.text;
      button.append(number, role, text); button.onclick = () => goTo(pathIndex); ui.path.appendChild(button);
    });
  }
  function enableDragging(handle) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const rect = ui.host.getBoundingClientRect();
      const startX = event.clientX, startY = event.clientY, startLeft = rect.left, startTop = rect.top;
      ui.host.style.right = "auto"; ui.host.style.left = `${startLeft}px`; ui.host.style.top = `${startTop}px`;
      const move = (moveEvent) => {
        const width = ui.host.offsetWidth, height = ui.host.offsetHeight;
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, startLeft + moveEvent.clientX - startX));
        const top = Math.max(8, Math.min(window.innerHeight - height - 8, startTop + moveEvent.clientY - startY));
        ui.host.style.left = `${left}px`; ui.host.style.top = `${top}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
        const finalRect = ui.host.getBoundingClientRect();
        const maxX = Math.max(1, window.innerWidth - finalRect.width), maxY = Math.max(1, window.innerHeight - finalRect.height);
        chrome.storage.local.set({ panelPosition: { x: finalRect.left / maxX, y: finalRect.top / maxY } });
      };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
    });
  }
  function restorePanelPosition() {
    chrome.storage.local.get({ panelPosition: null }, ({ panelPosition }) => {
      if (!panelPosition || !Number.isFinite(panelPosition.x) || !Number.isFinite(panelPosition.y)) return;
      requestAnimationFrame(() => {
        const left = Math.max(8, Math.min(window.innerWidth - ui.host.offsetWidth - 8, panelPosition.x * (window.innerWidth - ui.host.offsetWidth)));
        const top = Math.max(8, Math.min(window.innerHeight - ui.host.offsetHeight - 8, panelPosition.y * (window.innerHeight - ui.host.offsetHeight)));
        ui.host.style.right = "auto"; ui.host.style.left = `${left}px`; ui.host.style.top = `${top}px`;
      });
    });
  }
  function clampPanelToViewport() {
    if (!ui.host || ui.host.style.right !== "auto") return;
    const rect = ui.host.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left));
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top));
    ui.host.style.left = `${left}px`; ui.host.style.top = `${top}px`;
  }
  function setStatus(text, action) {
    ui.msg.innerHTML = ""; ui.msg.append(text);
    if (action === "settings") { const link = document.createElement("a"); link.textContent = "Add one in settings"; link.onclick = () => send({ type: "openOptions" }); ui.msg.append(" ", link); }
  }
  async function label(correct) {
    if (state.current < 0) return;
    const item = activeItems()[state.matches[state.current]];
    await send({ type: "label", label: { ts: Date.now(), url: location.href, mode: state.mode, query: state.query, text: item.text, p: item.p, role: item.role || null, roleP: item.roleP ?? null, correct } });
    (correct ? ui.yes : ui.no).classList.add("on"); setTimeout(() => (correct ? ui.yes : ui.no).classList.remove("on"), 700); goTo(state.current + 1);
  }
  function open() {
    if (!ui.host) { buildUI(); applyDefaultMode(); }
    ui.host.style.display = ""; state.open = true; state.sentences = []; state.chunks = [];
    const selection = String(getSelection() || "").trim();
    if (selection && selection.length < 120 && !ui.input.value) ui.input.value = selection;
    ui.input.focus(); ui.input.select(); if (ui.input.value.trim() && state.mode === "find") scheduleSearch();
  }
  function close() {
    state.open = false; state.generation++; state.pathOpen = false; if (ui.host) ui.host.style.display = "none";
    for (const key in HL) HL[key].clear(); clearMarkers();
  }
  function toggle() { state.open ? close() : open(); }
  const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || { error: chrome.runtime.lastError?.message || "no response" })));
  function hash(text) { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

  window.addEventListener("resize", () => { clampPanelToViewport(); if (state.open && state.mode === "digest" && state.matches.length) paint(); });
  chrome.runtime.onMessage.addListener((message) => { if (message.type === "toggle") toggle(); });
  window.__jevfind = { toggle, open, close };
})();
