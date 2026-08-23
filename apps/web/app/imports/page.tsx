"use client";

import Link from "next/link";
import { AlertCircle, ArrowLeft, CheckCircle2, CircleDashed, Database, FolderCheck, Play, RefreshCw, ScanSearch, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { API_BASE, type ImportJob, type ImportOverview } from "../lib/api";

function statusClass(status: string): string {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  return "running";
}

function statusLabel(status: string): string {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "进行中";
}

export default function ImportsPage() {
  const [overview, setOverview] = useState<ImportOverview | null>(null);
  const [selectedSources, setSelectedSources] = useState<boolean[]>([]);
  const [limit, setLimit] = useState("3");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(() => {
    fetch(`${API_BASE}/api/ecommerce/imports`)
      .then((response) => response.json() as Promise<ImportOverview>)
      .then((value) => {
        setOverview(value);
        setSelectedSources((current) => current.length ? current : value.sources.map((source) => source.available));
      })
      .catch(() => setMessage("无法连接 API 服务"));
  }, []);

  useEffect(() => { load(); }, [load]);
  const running = overview?.jobs.some((job) => job.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(load, 1500);
    return () => window.clearInterval(timer);
  }, [load, running]);

  const start = async (dryRun: boolean) => {
    if (!overview) return;
    const [full, extension] = overview.sources;
    const parsedLimit = Number(limit);
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`${API_BASE}/api/ecommerce/imports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullDir: selectedSources[0] ? full?.path : undefined,
          extensionDir: selectedSources[1] ? extension?.path : undefined,
          limit: Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined,
          dryRun,
        }),
      });
      const body = await response.json() as ImportJob & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "任务启动失败");
      setMessage(dryRun ? "预检任务已启动" : "导入任务已启动");
      load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const latestJob = overview?.jobs[0];

  return (
    <div className="page-stack imports-page">
      <Link className="page-back" href="/"><ArrowLeft size={16} /> 返回首页</Link>
      <header className="page-header"><p className="eyebrow">DATA INGESTION</p><h1>导入中心</h1><p className="page-description">校验本地采集结果并写入 PostgreSQL 与 OSS</p></header>

      <section className="import-layout">
        <div className="import-config">
          <div className="section-heading"><div><p className="section-kicker">SOURCE DATA</p><h2>数据源</h2></div><button className="icon-button" onClick={load} aria-label="重新扫描数据源" title="重新扫描"><RefreshCw size={18} /></button></div>
          <div className="source-list">
            {overview?.sources.map((source, index) => <label className={`source-card ${selectedSources[index] ? "selected" : ""} ${!source.available ? "disabled" : ""}`} key={source.path}>
              <input type="checkbox" checked={selectedSources[index] ?? false} disabled={!source.available || running} onChange={(event) => setSelectedSources((current) => current.map((value, sourceIndex) => sourceIndex === index ? event.target.checked : value))} />
              <span className="source-check">{selectedSources[index] ? <CheckCircle2 size={19} /> : <CircleDashed size={19} />}</span>
              <span className="source-icon"><FolderCheck size={21} /></span>
              <span className="source-content"><strong>{source.name}</strong><code>{source.path}</code></span>
              <span className="source-count">{source.available ? <><strong>{source.products}</strong><small>商品</small></> : <small>未找到</small>}</span>
            </label>)}
            {!overview && <div className="source-card source-skeleton"><span className="skeleton block" /></div>}
          </div>

          <div className="import-options">
            <label><span>导入数量上限</span><input type="number" min="1" max="10000" value={limit} disabled={running} onChange={(event) => setLimit(event.target.value)} /></label>
            <div className="import-actions"><button className="button secondary-button" disabled={submitting || running || !selectedSources.some(Boolean)} onClick={() => start(true)}><ScanSearch size={17} /> 仅预检</button><button className="button primary-button" disabled={submitting || running || !selectedSources.some(Boolean)} onClick={() => start(false)}><Play size={17} /> 开始导入</button></div>
          </div>
          {message && <div className="inline-message" role="status"><AlertCircle size={17} /><span>{message}</span></div>}
        </div>

        <div className="job-console">
          <div className="section-heading"><div><p className="section-kicker">CURRENT JOB</p><h2>任务输出</h2></div>{latestJob && <span className={`status-pill ${statusClass(latestJob.status)}`}>{statusLabel(latestJob.status)}</span>}</div>
          {latestJob ? <>
            <div className="job-meta"><span>{latestJob.dryRun ? "DRY RUN" : "IMPORT"}</span><time>{new Date(latestJob.startedAt).toLocaleString("zh-CN")}</time></div>
            <pre className="console-output" aria-live="polite">{latestJob.output.length ? latestJob.output.join("\n") : "任务已启动，等待输出..."}</pre>
            {latestJob.error && <div className="job-error"><AlertCircle size={17} />{latestJob.error}</div>}
          </> : <div className="compact-empty console-empty"><TerminalSquare size={24} /><strong>暂无本次任务</strong><p>预检或导入输出会显示在这里。</p></div>}
        </div>
      </section>

      <section className="section-block history-block">
        <div className="section-heading"><div><p className="section-kicker">IMPORT HISTORY</p><h2>入库记录</h2></div><span className="muted-count">{overview?.batches.length ?? 0} 批</span></div>
        {overview?.batches.length ? <div className="history-table"><div className="history-row history-head"><span>状态</span><span>数据集</span><span>批次 ID</span><span>开始时间</span><span>结果</span></div>{overview.batches.map((batch) => <div className="history-row" key={batch.batchId}><span><span className={`status-pill ${statusClass(batch.status)}`}>{statusLabel(batch.status)}</span></span><strong>{batch.sourceDatasets.join(" + ")}</strong><code>{batch.batchId.slice(0, 8)}</code><time>{new Date(batch.startedAt).toLocaleString("zh-CN")}</time><span>{batch.error ?? `${batch.counts.products ?? 0} 商品`}</span></div>)}</div> : <div className="compact-empty"><Database size={22} /><strong>暂无入库记录</strong><p>成功连接数据库后显示历史批次。</p></div>}
      </section>
    </div>
  );
}
