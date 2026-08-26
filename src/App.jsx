import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

const NAV = [
  ["chat", "会话", "CHAT"],
  ["evidence", "证据", "EVIDENCE"],
  ["library", "文库", "LIBRARY"],
  ["trace", "轨迹", "TRACE"],
  ["settings", "设置", "SETTINGS"],
];

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function runtimeLabel(status) {
  return {
    ready: "READY",
    starting: "STARTING",
    unconfigured: "CONFIGURE",
    error: "ERROR",
    offline: "OFFLINE",
  }[status] || String(status || "OFFLINE").toUpperCase();
}

function reasoningLabel(value) {
  return { provider: "DEFAULT", none: "OFF", low: "LOW", high: "HIGH", max: "MAX" }[value] || "DEFAULT";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function EvidenceCard({ item, index, compact = false }) {
  const open = (event) => {
    event.preventDefault();
    if (item.citation_url) window.anru.openExternal(item.citation_url);
  };
  return (
    <article className={`evidence-card ${compact ? "compact" : ""}`}>
      <div className="evidence-index">{String(index + 1).padStart(2, "0")}</div>
      <div className="evidence-body">
        <a href={item.citation_url || "#"} onClick={open} className="evidence-title">{item.title}</a>
        <div className="evidence-meta">
          <span>{item.year || "N.D."}</span><span>{item.journal || "UNKNOWN"}</span><span>{item.evidence_level}</span>
        </div>
        {!compact && item.abstract_excerpt && <p>{item.abstract_excerpt}</p>}
        <div className="evidence-id">{item.pmid ? `PMID ${item.pmid}` : "METADATA"}{item.doi ? ` / DOI ${item.doi}` : ""}</div>
      </div>
    </article>
  );
}

function StatusDot({ status }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

function Header({ page, setPage, theme, setTheme, state, openPalette }) {
  return (
    <header className="topbar">
      <nav className="topnav" aria-label="主导航">
        {NAV.map(([id, , en]) => <button key={id} className={page === id ? "active" : ""} onClick={() => setPage(id)}>{en}</button>)}
      </nav>
      <button className="command-trigger" onClick={openPalette}><span>search or run a command</span><kbd>CTRL K</kbd></button>
      <div className="top-status">
        <span className="provider-status"><StatusDot status={state.runtimeStatus} />{state.provider?.model || "THIRD-PARTY"} / {runtimeLabel(state.runtimeStatus)}</span>
        <button className="theme-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="切换明暗主题">{theme === "dark" ? "LIGHT" : "DARK"}</button>
      </div>
    </header>
  );
}

function SideRail({ page, setPage, state, newThread, sessions, activeSessionId, openSession, sending, modalOpen }) {
  return (
    <aside className="side-rail" inert={modalOpen} aria-hidden={modalOpen || undefined}>
      <button className="brand" onClick={() => setPage("chat")}>
        <span className="brand-mark">安</span>
        <span className="brand-name">ANRU <i>安若</i></span>
      </button>
      <div className="archive-heading">
        <span>RESEARCH ARCHIVE</span>
        <strong>Transgender<br />Health Evidence</strong>
        <p>跨性别健康循证工作台</p>
      </div>
      <div className="source-ledger" aria-label="核心期刊来源">
        <div className="ledger-rule"><span>COLLECTION / 03</span><i /></div>
        <button type="button" onClick={() => setPage("library")}><b>TRG</b><span>Transgender Health</span><em>01</em></button>
        <button type="button" onClick={() => setPage("library")}><b>LGB</b><span>LGBT Health</span><em>02</em></button>
        <button type="button" onClick={() => setPage("library")}><b>IJTH</b><span>Int'l Journal of Transgender Health</span><em>03</em></button>
      </div>
      <section className="session-dock">
        <div className="dock-heading"><span>SESSIONS / {sessions.length}</span><button onClick={newThread} disabled={sending}>＋ NEW</button></div>
        <div className="history-list">
          {sessions.map((session, index) => (
            <button key={session.id} disabled={sending} className={`history-item ${session.id === activeSessionId ? "active" : ""}`} onClick={() => openSession(session.id)} title={session.title}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <span><strong>{session.title}</strong><small>{formatHistoryTime(session.updatedAt)} · {session.messageCount}</small></span>
            </button>
          ))}
        </div>
      </section>
      <div className="rail-footer">
        <span>ANRU / {state.version || "0.1.0"}</span>
        <span><StatusDot status={state.evidenceStatus} />LIBRARY {runtimeLabel(state.evidenceStatus)}</span>
      </div>
    </aside>
  );
}

function Markdown({ children }) {
  return <ReactMarkdown components={{ a: ({ href, children: label }) => <a href={href} onClick={(e) => { e.preventDefault(); window.anru.openExternal(href); }}>{label}</a> }}>{children}</ReactMarkdown>;
}

function ChatPage({ state, messages, evidence, stage, sending, send, interrupt, setPage }) {
  const [text, setText] = useState(() => sessionStorage.getItem("anru-draft") || "");
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(true);
  const [showLatest, setShowLatest] = useState(false);
  const scrollRef = useRef(null);
  const followOutputRef = useRef(true);
  const fileInputRef = useRef(null);
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane || !followOutputRef.current) return;
    pane.scrollTop = messages.length ? pane.scrollHeight : 0;
    setShowLatest(false);
  }, [messages, stage]);
  useEffect(() => { if (evidence?.results?.length) setEvidenceOpen(true); }, [evidence]);
  const updateText = (value) => {
    setText(value);
    sessionStorage.setItem("anru-draft", value);
  };
  const submit = (event) => {
    event.preventDefault();
    const value = text.trim() || (attachments.length ? "请分析所附文件，并结合可靠证据回答。" : "");
    if (!value || sending || state.runtimeStatus !== "ready" || attachmentStatus === "正在解析附件…") return;
    updateText("");
    const files = attachments;
    setAttachments([]);
    setAttachmentStatus("");
    followOutputRef.current = true;
    setShowLatest(false);
    send({ text: value, attachments: files });
  };
  const addFiles = async (fileList) => {
    const available = Math.max(0, 5 - attachments.length);
    const files = Array.from(fileList || []).slice(0, available);
    if (!files.length) return;
    setAttachmentStatus("正在解析附件…");
    const parsed = [];
    const failures = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        parsed.push(await window.anru.extractAttachment({ name: file.name, type: file.type, bytes }));
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
    }
    setAttachments((old) => [...old, ...parsed].slice(0, 5));
    setAttachmentStatus(failures.length ? failures.join(" / ") : parsed.length ? `已在本机解析 ${parsed.length} 个文件` : "");
  };
  const parsingAttachments = attachmentStatus === "正在解析附件…";
  const trackScroll = () => {
    const pane = scrollRef.current;
    if (!pane) return;
    const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 88;
    followOutputRef.current = nearBottom;
    setShowLatest(!nearBottom && messages.length > 0);
  };
  const jumpToLatest = () => {
    const pane = scrollRef.current;
    if (!pane) return;
    followOutputRef.current = true;
    pane.scrollTo({ top: pane.scrollHeight, behavior: "smooth" });
    setShowLatest(false);
  };
  const drop = async (event) => {
    event.preventDefault();
    setDragging(false);
    await addFiles(event.dataTransfer.files);
  };
  return (
    <div className={`chat-layout ${evidenceOpen && evidence?.results?.length ? "has-context" : ""}`}>
      <main className="chat-main">
        <div className="page-heading chat-heading">
          <div><div className="breadcrumb">ANRU / RESEARCH DESK / SESSION</div><h1>研究会话</h1><p>跨性别健康文献检索 · Pi Agent</p></div>
          {state.runtimeStatus === "ready" || sending
            ? <span className={`state-badge ${sending ? "active" : ""}`}>{sending ? stage.message || "WORKING" : state.settings?.internetAccess !== false ? "WEB READY" : "OFFLINE READY"}</span>
            : <button type="button" className="state-badge configure-action" onClick={() => setPage("settings")}>{runtimeLabel(state.runtimeStatus)} ↗</button>}
        </div>
        <div className="chat-scroll" ref={scrollRef} onScroll={trackScroll}>
          {!messages.length && (
            <section className="empty-state">
              <div className="empty-copy">
                <span className="eyebrow">DOSSIER 0001 / NEW RESEARCH NOTE</span>
                <h2>建立研究问题</h2>
                <p>先查阅本地证据，再按需要核对公开来源。</p>
                <div className="prompt-seeds">
                  <button type="button" onClick={() => updateText("跨性别者接受性别肯定激素治疗后，心血管风险的现有证据如何？请区分研究设计和证据局限。")}><b>01</b><span>激素治疗与心血管风险</span><i>↗</i></button>
                  <button type="button" onClick={() => updateText("性别肯定医疗对跨性别者抑郁、自杀意念与生活质量的影响有哪些高质量证据？")}><b>02</b><span>心理健康与生活质量结局</span><i>↗</i></button>
                  <button type="button" onClick={() => updateText("跨性别人群的癌症筛查应如何根据现有器官、激素使用与手术史制定？")}><b>03</b><span>个体化癌症筛查</span><i>↗</i></button>
                </div>
              </div>
              <aside className="empty-aside" aria-label="证据工作流">
                <span>WORKFLOW / 01—04</span>
                <ol>
                  <li><b>01</b><p>界定人群与结局</p></li>
                  <li><b>02</b><p>检索本地索引</p></li>
                  <li><b>03</b><p>核对来源与时效</p></li>
                  <li><b>04</b><p>标注不确定性</p></li>
                </ol>
                <small>Respect identity · verify evidence</small>
              </aside>
            </section>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-label">{message.role === "user" ? "YOU" : "ANRU"}<span>{message.time}</span></div>
              <div className="message-content"><Markdown>{message.text || (message.pending ? "_等待响应…_" : "")}</Markdown></div>
            </article>
          ))}
          {sending && <div className="working-line"><span /><span /><span /> {stage.message || "处理中"}</div>}
        </div>
        {showLatest && <button type="button" className="jump-latest" onClick={jumpToLatest}>LATEST ↓</button>}
        <form className={`composer ${dragging ? "dragging" : ""}`} aria-busy={parsingAttachments} onSubmit={submit} onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }} onDrop={drop}>
          {!!attachments.length && <div className="attachment-strip">{attachments.map((file, index) => <div className="attachment-chip" key={`${file.name}-${index}`}><span><b>{file.name}</b><small>{formatBytes(file.size)}{file.truncated ? " / TRUNCATED" : ""}</small></span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments((old) => old.filter((_item, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>}
          {dragging && <div className="drop-hint">DROP FILES / 本机解析</div>}
          <textarea aria-label="跨性别健康研究问题" value={text} onChange={(e) => updateText(e.target.value)} placeholder="输入跨性别健康研究问题…  Enter 发送 / Shift+Enter 换行" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229 && state.runtimeStatus === "ready") { e.preventDefault(); submit(e); } }} />
          <div className="composer-bar">
            <div className="composer-tools"><input ref={fileInputRef} type="file" multiple accept=".txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.pdf,.docx" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} /><button type="button" className="file-button" onClick={() => fileInputRef.current?.click()}>＋ FILE</button><span><b>PI</b> / {state.settings?.internetAccess !== false ? "WEB" : "OFFLINE"} / {state.settings?.medicalAudit !== false ? "AUDIT" : "DIRECT"} / {state.settings?.computerAccess ? "COMPUTER" : "SAFE"} / THINK {reasoningLabel(state.settings?.reasoningEffort)}</span></div>
            {sending
              ? <button type="button" className="stop-button" onClick={interrupt}>STOP</button>
              : state.runtimeStatus === "ready"
                ? <button type="submit" disabled={parsingAttachments || (!text.trim() && !attachments.length)}>RUN ↵</button>
                : <button type="button" onClick={() => setPage("settings")}>SETTINGS</button>}
          </div>
          {attachmentStatus && <div role="status" aria-live="polite" className={`attachment-status ${attachmentStatus.includes(":") ? "error" : ""}`}>{attachmentStatus}</div>}
        </form>
      </main>
      {evidenceOpen && !!evidence?.results?.length && <aside className="evidence-drawer">
        <div className="drawer-header"><div><b>Evidence context</b><span>{evidence.retrieval_mode}</span></div><span className="drawer-actions"><button onClick={() => setPage("evidence")}>EXPAND</button><button aria-label="关闭证据上下文" onClick={() => setEvidenceOpen(false)}>×</button></span></div>
        {evidence.results.map((item, index) => <EvidenceCard compact key={item.work_id || item.pmid || item.doi} item={item} index={index} />)}
      </aside>}
    </div>
  );
}

function EvidencePage({ lastEvidence, onSearch }) {
  const [query, setQuery] = useState(lastEvidence?.query || "");
  const [result, setResult] = useState(lastEvidence);
  const [loading, setLoading] = useState(false);
  const run = async (event) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try { setResult(await onSearch({ query, topK: 10 })); } finally { setLoading(false); }
  };
  return (
    <main className="page-shell">
      <div className="page-heading"><div><div className="breadcrumb">ANRU / ARCHIVE / SEARCH</div><h1>Evidence search</h1><p>直接查询离线 SQLite / FTS5，不需要模型 API。</p></div><span className={`state-badge ${loading ? "active" : ""}`}>{loading ? "RETRIEVING" : result?.retrieval_mode || "OFFLINE"}</span></div>
      <form className="evidence-search" onSubmit={run}><input aria-label="本地证据检索词" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="gender-affirming hormone therapy cardiovascular outcomes…" /><button>SEARCH LOCAL ↵</button></form>
      {result && <div className="result-summary"><span>QUERY / {result.query}</span><span>TOPIC / {result.detected_topic || "CORPUS-WIDE"}</span><span>TIME / {result.elapsedMs || 0} MS</span><span>MODE / {result.retrieval_mode}</span></div>}
      <section className="evidence-list">{result?.results?.map((item, index) => <EvidenceCard key={item.work_id || item.pmid || item.doi} item={item} index={index} />)}</section>
    </main>
  );
}

function LibraryPage({ state }) {
  const stats = state.libraryStats || {};
  const rows = [
    ["INDEXED WORKS", formatNumber(stats.papers), "Crossref + PubMed records"],
    ["ABSTRACTS", formatNumber(stats.abstracts), "Locally searchable text"],
    ["JOURNALS", formatNumber(stats.journals), "Registered source journals"],
    ["PROVENANCE", formatNumber(stats.sourceRecords), "Auditable source records"],
    ["FTS5 INDEX", formatNumber(stats.papers), "Local full-text index"],
    ["DATABASE", `${(Number(stats.databaseBytes || 0) / 1024 / 1024).toFixed(1)} MiB`, "SQLite + FTS5 + relations"],
    ["RUNTIME", "EMBEDDED", "Electron SQLite + Pi Agent"],
  ];
  return (
    <main className="page-shell">
      <div className="page-heading"><div><div className="breadcrumb">ANRU / ARCHIVE / LIBRARY</div><h1>Offline library</h1><p>跨性别健康文献快照与本地索引。</p></div><span className="state-badge active">VERIFIED</span></div>
      <section className="capability-list">
        {rows.map(([name, value, note], index) => <div className="capability-row" key={name}><div className="capability-name"><b>{name}</b><p>{note}</p></div><code>{String(index + 1).padStart(2, "0")} / ANRU</code><strong>{value}</strong><span className="enabled">ENABLED</span></div>)}
      </section>
      <div className="library-note"><b>SNAPSHOT INVARIANT</b><p>日常问答只读取已打包数据库，不会自动下载、更新或创建空库。引文必须来自本地检索结果。</p></div>
    </main>
  );
}

function TracePage({ logs }) {
  return (
    <main className="page-shell trace-page">
      <div className="page-heading"><div><div className="breadcrumb">ANRU / SYSTEM / TRACE</div><h1>Runtime trace</h1><p>Pi 与本地检索状态，不显示或记录第三方 API 密钥。</p></div><span className="state-badge">LOCAL ONLY</span></div>
      <div className="trace-table"><div className="trace-head"><span>TIME</span><span>SOURCE</span><span>EVENT</span></div>{logs.length ? logs.slice().reverse().map((entry, index) => <div className="trace-row" key={`${entry.at}-${index}`}><time>{entry.at.slice(11, 23)}</time><b>{entry.source}</b><pre>{entry.message}</pre></div>) : <div className="trace-empty">NO RUNTIME EVENTS</div>}</div>
    </main>
  );
}

function SettingsPage({ initial, save, test, state }) {
  const [form, setForm] = useState(initial || {});
  const [feedback, setFeedback] = useState(null);
  useEffect(() => setForm(initial || {}), [initial]);
  const update = (key) => (event) => setForm((old) => ({ ...old, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setFeedback({ type: "working", text: "保存并重启运行时…" });
    try { await save(form); setForm((old) => ({ ...old, apiKey: "", keyConfigured: true })); setFeedback({ type: "ok", text: "配置已保存，运行时已重启。" }); }
    catch (error) { setFeedback({ type: "error", text: error.message }); }
  };
  const probe = async () => {
    setFeedback({ type: "working", text: "正在直接测试第三方端点…" });
    try {
      const response = await test(form);
      const adjustment = response.temperatureAdjusted ? ` / temperature ${response.temperature} (AUTO)` : "";
      setFeedback({ type: "ok", text: `连接成功 / ${response.protocol}${adjustment}` });
    }
    catch (error) { setFeedback({ type: "error", text: error.message }); }
  };
  return (
    <main className="page-shell settings-page">
      <div className="page-heading"><div><div className="breadcrumb">ANRU / SYSTEM / SETTINGS</div><h1>Third-party model</h1><p>配置 Pi 使用的 API 地址、模型和密钥。</p></div><span className={`state-badge ${state.runtimeStatus === "ready" ? "active" : ""}`}>{runtimeLabel(state.runtimeStatus)}</span></div>
      <form className="settings-form" onSubmit={submit}>
        <section className="settings-section"><div className="section-number">01</div><div className="section-copy"><h2>PROVIDER</h2><p>支持 Responses API，或常见的 OpenAI-compatible Chat Completions。</p></div><div className="fields">
          <label><span>DISPLAY NAME</span><input value={form.providerName || ""} onChange={update("providerName")} placeholder="Kimi / DeepSeek / SiliconFlow" /></label>
          <label><span>BASE URL</span><input value={form.baseUrl || ""} onChange={update("baseUrl")} placeholder="https://api.example.com/v1" /></label>
          <label><span>MODEL ID</span><input value={form.model || ""} onChange={update("model")} placeholder="moonshot-v1-128k" /></label>
          <label><span>PROTOCOL</span><select value={form.protocol || "chat_completions"} onChange={update("protocol")}><option value="chat_completions">Chat Completions (compatible)</option><option value="responses">Responses API (native)</option></select></label>
          <label className="wide"><span>API KEY {form.keyConfigured ? "/ ENCRYPTED KEY PRESENT" : ""}</span><input type="password" value={form.apiKey || ""} onChange={update("apiKey")} placeholder={form.keyConfigured ? "留空以保留现有密钥" : "sk-…"} autoComplete="new-password" /></label>
        </div></section>
        <section className="settings-section"><div className="section-number">02</div><div className="section-copy"><h2>EVIDENCE</h2><p>语义检索默认在本机完成，模型不会直接读取整个数据库。</p></div><div className="fields">
          <label><span>TOP K / {form.topK || 5}</span><input type="range" min="2" max="10" value={form.topK || 5} onChange={update("topK")} /></label>
          <label><span>TEMPERATURE / {form.temperature ?? 0.2}</span><input type="range" min="0" max="1" step="0.1" value={form.temperature ?? 0.2} onChange={update("temperature")} /></label>
          <label className="wide"><span>THINKING EFFORT</span><select value={form.reasoningEffort || "provider"} onChange={update("reasoningEffort")}><option value="provider">PROVIDER DEFAULT</option><option value="none">OFF</option><option value="low">LOW</option><option value="high">HIGH</option><option value="max">MAX</option></select></label>
          <label className="switch-field wide"><input type="checkbox" checked={form.internetAccess !== false} onChange={update("internetAccess")} /><span>LIVE INTERNET / PI TOOLS</span><small>开放 Pi 的实时搜索与网页读取工具；仅访问公网 HTTP(S)，阻止本机与内网地址。</small></label>
          <label className="switch-field wide"><input type="checkbox" checked={form.multiStepAgent !== false} onChange={update("multiStepAgent")} /><span>MULTI-STEP AGENT</span><small>按本地检索、联网查证、证据审阅、最终回答执行；不展示内部思维链。</small></label>
          <label className="switch-field wide"><input type="checkbox" checked={form.medicalAudit !== false} onChange={update("medicalAudit")} /><span>SECOND-PASS MEDICAL AUDIT</span><small>先生成隐藏草稿，再由同一模型复核监管地区、阈值、数字和引用，只显示修订后的答案。会增加一次模型调用。</small></label>
          <label className="wide"><span>MAX OUTPUT TOKENS / {form.maxOutputTokens || 16384}</span><input type="range" min="4096" max="32768" step="4096" value={form.maxOutputTokens || 16384} onChange={update("maxOutputTokens")} /></label>
        </div></section>
        <section className="settings-section"><div className="section-number">03</div><div className="section-copy"><h2>COMPUTER</h2><p>让 Pi 观察窗口、读取授权目录，并在你逐次批准后操作桌面或更改文件。</p></div><div className="fields">
          <label className="switch-field wide"><input type="checkbox" checked={form.computerAccess === true} onChange={update("computerAccess")} /><span>COMPUTER TOOLS</span><small>读取范围限定在 Windows 用户目录并阻止凭据路径；点击、输入、打开、写入、移动和回收操作都会弹出批准窗口。</small></label>
          <label className="switch-field wide"><input type="checkbox" checked={form.visionInput === true} onChange={update("visionInput")} /><span>VISION / SCREEN CAPTURE</span><small>仅为支持图像输入的第三方模型开启。截图会发送给已配置的模型供应商，请勿在屏幕上保留敏感资料。</small></label>
        </div></section>
        <div className="settings-actions"><button type="button" onClick={probe}>TEST CONNECTION</button><button type="submit" className="primary">SAVE & RESTART</button>{feedback && <span className={`feedback ${feedback.type}`}>{feedback.text}</span>}</div>
      </form>
      <div className="security-note"><b>SECURITY / LOCAL BOUNDARY</b><p>密钥通过 Electron safeStorage 使用 Windows 系统加密后落盘，并仅在主进程交给 Pi。运行日志不会输出真实密钥。</p></div>
    </main>
  );
}

function useModalFocus(open, onEscape) {
  const dialogRef = useRef(null);
  const previousFocus = useRef(null);
  const escapeRef = useRef(onEscape);
  useEffect(() => { escapeRef.current = onEscape; }, [onEscape]);
  useEffect(() => {
    if (!open) return undefined;
    previousFocus.current = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]') || []);
    const timer = window.setTimeout(() => focusable()[0]?.focus(), 0);
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); escapeRef.current?.(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus?.();
    };
  }, [open]);
  return dialogRef;
}

function CommandPalette({ open, close, setPage, newThread, theme, setTheme }) {
  const [query, setQuery] = useState("");
  const dialogRef = useModalFocus(open, close);
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  if (!open) return null;
  const commands = [...NAV.map(([id, zh, en]) => ({ label: `GO / ${en} — ${zh}`, run: () => setPage(id) })), { label: "NEW / 新建会话", run: newThread }, { label: `THEME / ${theme === "dark" ? "LIGHT" : "DARK"}`, run: () => setTheme(theme === "dark" ? "light" : "dark") }].filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  return <div className="palette-backdrop" role="presentation" onMouseDown={close}><div ref={dialogRef} className="palette" role="dialog" aria-modal="true" aria-label="命令面板" onMouseDown={(e) => e.stopPropagation()}><div className="palette-input"><span>›</span><input aria-label="筛选命令" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a command…" /><kbd>ESC</kbd></div><div className="palette-results">{commands.map((item) => <button key={item.label} onClick={() => { item.run(); close(); }}>{item.label}<span>↵</span></button>)}</div></div></div>;
}

function ComputerApproval({ approval, resolve }) {
  const reject = useCallback(() => resolve(false), [resolve]);
  const dialogRef = useModalFocus(Boolean(approval), reject);
  if (!approval) return null;
  return (
    <div className="approval-backdrop" role="presentation">
      <section ref={dialogRef} className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="computer-approval-title">
        <div className="approval-index">COMPUTER / APPROVAL</div>
        <h2 id="computer-approval-title">允许这一次操作？</h2>
        <code>{approval.tool}</code>
        <p>{approval.summary}</p>
        <small>只批准当前这一项。拒绝后，Pi 会收到操作未获授权的结果。</small>
        <div className="approval-actions"><button autoFocus onClick={() => resolve(false)}>DENY</button><button className="primary" onClick={() => resolve(true)}>ALLOW ONCE</button></div>
      </section>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState("chat");
  const [theme, setTheme] = useState(() => localStorage.getItem("anru-theme") || "light");
  const [state, setState] = useState({ runtimeStatus: "starting", evidenceStatus: "starting", provider: {} });
  const [settings, setSettings] = useState({});
  const [messages, setMessages] = useState([]);
  const [evidence, setEvidence] = useState(null);
  const [stage, setStage] = useState({ stage: "idle", message: "" });
  const [sending, setSending] = useState(false);
  const [logs, setLogs] = useState([]);
  const [palette, setPalette] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [computerApproval, setComputerApproval] = useState(null);
  const assistantId = useRef(null);
  const historyReady = useRef(false);
  const sessionHydrated = useRef(true);
  const modalOpen = Boolean(palette || computerApproval);

  const refresh = useCallback(async () => {
    const [nextState, nextSettings, nextLogs] = await Promise.all([window.anru.getState(), window.anru.getSettings(), window.anru.getLogs()]);
    setState((old) => ({ ...old, ...nextState, settings: nextSettings }));
    setSettings(nextSettings);
    setLogs(nextLogs);
  }, []);

  const refreshHistory = useCallback(async () => {
    const list = await window.anru.listHistory();
    setSessions(list);
    return list;
  }, []);

  const loadInitialHistory = useCallback(async () => {
    historyReady.current = false;
    let list = await window.anru.listHistory();
    let session = list.length ? await window.anru.getHistory(list[0].id) : await window.anru.createHistory();
    if (!session) session = await window.anru.createHistory();
    await window.anru.newThread();
    setActiveSessionId(session.id);
    setMessages(session.messages || []);
    setEvidence(session.evidence || null);
    assistantId.current = null;
    sessionHydrated.current = !(session.messages || []).length;
    list = await window.anru.listHistory();
    setSessions(list);
    historyReady.current = true;
  }, []);

  useEffect(() => { refresh(); loadInitialHistory(); }, [refresh, loadInitialHistory]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("anru-theme", theme); }, [theme]);
  useEffect(() => {
    const key = (event) => { if (event.ctrlKey && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette(true); } if (event.key === "Escape") setPalette(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const preventFileNavigation = (event) => event.preventDefault();
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => { window.removeEventListener("dragover", preventFileNavigation); window.removeEventListener("drop", preventFileNavigation); };
  }, []);
  useEffect(() => window.anru.onEvent((event) => {
    if (event.type === "runtime") setState((old) => ({ ...old, runtimeStatus: event.status }));
    if (event.type === "evidence-runtime") setState((old) => ({ ...old, evidenceStatus: event.status, libraryStats: event.stats || old.libraryStats }));
    if (event.type === "log") setLogs((old) => [...old.slice(-399), event.entry]);
    if (event.type === "chat-stage") { setStage(event); setSending(true); }
    if (event.type === "chat-evidence") setEvidence(event.evidence);
    if (event.type === "chat-delta" && event.delta) {
      setMessages((old) => old.map((message) => message.id === assistantId.current ? { ...message, text: message.text + event.delta, pending: false } : message));
    }
    if (event.type === "chat-item" && event.text) {
      setMessages((old) => old.map((message) => message.id === assistantId.current && !message.text ? { ...message, text: event.text, pending: false } : message));
    }
    if (event.type === "chat-complete") { setSending(false); setStage({ stage: "idle", message: "" }); setMessages((old) => old.map((message) => message.id === assistantId.current ? { ...message, pending: false } : message)); }
    if (event.type === "chat-error") { setSending(false); setMessages((old) => old.map((message) => message.id === assistantId.current ? { ...message, text: `运行失败：${event.message}`, pending: false, error: true } : message)); }
    if (event.type === "computer-approval") setComputerApproval(event.approval);
    if (event.type === "computer-approval-clear") setComputerApproval(null);
  }), []);

  const resolveComputerApproval = useCallback(async (approved) => {
    const current = computerApproval;
    if (!current) return;
    setComputerApproval(null);
    await window.anru.resolveComputerApproval({ id: current.id, approved });
  }, [computerApproval]);

  useEffect(() => {
    if (!historyReady.current || !activeSessionId) return undefined;
    const timer = window.setTimeout(async () => {
      try {
        await window.anru.saveHistory({ id: activeSessionId, messages, evidence });
        await refreshHistory();
      } catch (error) {
        console.error("Failed to persist chat history", error);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeSessionId, messages, evidence, refreshHistory]);

  const send = useCallback(async (payload) => {
    const text = String(payload?.text || "").trim();
    if (!text || sending) return;
    const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const attachmentLine = payload.attachments?.length ? `\n\n附件：${payload.attachments.map((item) => item.name).join("、")}` : "";
    const userMessage = { id: crypto.randomUUID(), role: "user", text: `${text}${attachmentLine}`, time: now };
    const agentMessage = { id: crypto.randomUUID(), role: "assistant", text: "", time: now, pending: true };
    assistantId.current = agentMessage.id;
    setMessages((old) => [...old, userMessage, agentMessage]);
    setSending(true);
    setStage({ stage: "retrieving", message: "正在检索离线证据" });
    const history = sessionHydrated.current ? [] : messages.filter((message) => !message.pending);
    sessionHydrated.current = true;
    try { await window.anru.sendMessage({ ...payload, text, history }); }
    catch (error) { setSending(false); setMessages((old) => old.map((message) => message.id === agentMessage.id ? { ...message, text: `运行失败：${error.message}`, pending: false, error: true } : message)); }
  }, [sending, messages]);

  const saveActiveHistory = useCallback(async () => {
    if (!historyReady.current || !activeSessionId) return;
    await window.anru.saveHistory({ id: activeSessionId, messages, evidence });
  }, [activeSessionId, messages, evidence]);

  const newThread = useCallback(async () => {
    if (sending) return;
    await saveActiveHistory();
    historyReady.current = false;
    await window.anru.newThread();
    const session = await window.anru.createHistory();
    setActiveSessionId(session.id);
    setMessages([]);
    setEvidence(null);
    assistantId.current = null;
    sessionHydrated.current = true;
    await refreshHistory();
    historyReady.current = true;
    setPage("chat");
  }, [sending, saveActiveHistory, refreshHistory]);

  const openSession = useCallback(async (id) => {
    if (sending || id === activeSessionId) { setPage("chat"); return; }
    await saveActiveHistory();
    historyReady.current = false;
    const session = await window.anru.getHistory(id);
    if (!session) { historyReady.current = true; return; }
    await window.anru.newThread();
    setActiveSessionId(session.id);
    setMessages(session.messages || []);
    setEvidence(session.evidence || null);
    assistantId.current = null;
    sessionHydrated.current = !(session.messages || []).length;
    historyReady.current = true;
    setPage("chat");
  }, [sending, activeSessionId, saveActiveHistory]);
  const saveSettings = async (value) => { const saved = await window.anru.saveSettings(value); setSettings(saved); await refresh(); return saved; };
  const content = useMemo(() => {
    if (page === "chat") return <ChatPage state={{ ...state, settings }} messages={messages} evidence={evidence} stage={stage} sending={sending} send={send} interrupt={() => window.anru.interrupt()} setPage={setPage} />;
    if (page === "evidence") return <EvidencePage lastEvidence={evidence} onSearch={async (params) => { const result = await window.anru.searchEvidence(params); setEvidence(result); return result; }} />;
    if (page === "library") return <LibraryPage state={state} />;
    if (page === "trace") return <TracePage logs={logs} />;
    return <SettingsPage initial={settings} save={saveSettings} test={(value) => window.anru.testSettings(value)} state={state} />;
  }, [page, state, settings, messages, evidence, stage, sending, send, logs]);

  return (
    <div className="app-frame">
      <SideRail page={page} setPage={setPage} state={state} newThread={newThread} sessions={sessions} activeSessionId={activeSessionId} openSession={openSession} sending={sending} modalOpen={modalOpen} />
      <section className="work-area" inert={modalOpen} aria-hidden={modalOpen || undefined}>
        <Header page={page} setPage={setPage} theme={theme} setTheme={setTheme} state={state} openPalette={() => setPalette(true)} />
        <div className="app-body">{content}</div>
      </section>
      <CommandPalette open={palette} close={() => setPalette(false)} setPage={setPage} newThread={newThread} theme={theme} setTheme={setTheme} />
      <ComputerApproval approval={computerApproval} resolve={resolveComputerApproval} />
    </div>
  );
}
