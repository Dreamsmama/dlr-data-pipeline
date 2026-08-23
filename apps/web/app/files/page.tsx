"use client";

import Link from "next/link";
import { ArrowLeft, Check, Copy, ExternalLink, FileArchive, FileJson, Image as ImageIcon, Search, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { API_BASE, formatBytes, type FileItem } from "../lib/api";

interface FilesResponse { items: FileItem[]; total: number; error?: string }

const kinds = [
  ["all", "全部"], ["main", "主图"], ["detail", "详情图"], ["product_json", "商品 JSON"], ["raw_json", "原始 JSON"], ["raw_html", "HTML"],
] as const;

function FilesContent() {
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [kind, setKind] = useState("all");
  const [data, setData] = useState<FilesResponse>({ items: [], total: 0 });
  const [selected, setSelected] = useState<FileItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setLoading(true);
    const queryParams = new URLSearchParams({ q: search, kind, pageSize: "60" });
    fetch(`${API_BASE}/api/ecommerce/files?${queryParams}`)
      .then((response) => response.json() as Promise<FilesResponse>)
      .then(setData)
      .catch(() => setData({ items: [], total: 0, error: "无法连接 API 服务" }))
      .finally(() => setLoading(false));
  }, [kind, search]);

  const copyPath = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.objectKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="page-stack">
      <Link className="page-back" href="/"><ArrowLeft size={16} /> 返回首页</Link>
      <header className="page-header"><p className="eyebrow">ASSET LIBRARY</p><h1>文件资产</h1><p className="page-description">图片、原始响应与 OSS 对象索引</p></header>
      <div className="toolbar files-toolbar">
        <label className="search-box"><Search size={18} /><span className="sr-only">搜索文件</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品、Item ID 或 OSS 路径" /></label>
        <div className="filter-menu"><label htmlFor="kind-filter">文件类型</label><select id="kind-filter" value={kind} onChange={(event) => setKind(event.target.value)}>{kinds.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
        <span className="result-count">{loading ? "读取中" : `${data.total.toLocaleString("zh-CN")} 个文件`}</span>
      </div>

      {data.error && <div className="notice warning-notice"><span className="notice-dot" /><div><strong>文件数据暂不可用</strong><p>{data.error}</p></div></div>}
      {!loading && !data.items.length ? <div className="empty-state"><div className="empty-icon"><FileArchive size={25} /></div><h2>{search ? "没有匹配的文件" : "还没有文件资产"}</h2><p>{search ? "调整关键词或文件类型。" : "导入商品后，图片和原始文件会在这里建立索引。"}</p></div> :
      <div className="asset-table" aria-busy={loading}>
        <div className="asset-table-row asset-table-head"><span>文件</span><span>关联商品</span><span>来源</span><span>大小</span><span>状态</span></div>
        {loading && Array.from({ length: 8 }, (_, index) => <div className="asset-table-row table-skeleton" key={index}><span /><span /><span /><span /><span /></div>)}
        {!loading && data.items.map((file, index) => <button className="asset-table-row" onClick={() => setSelected(file)} key={`${file.sha256}-${file.itemId}-${index}`}>
          <span className="file-cell">{file.contentType.startsWith("image/") && file.sourceUrl ? <img src={file.sourceUrl} alt="" /> : <span className="file-type-icon"><FileJson size={18} /></span>}<span><strong>{file.kind}</strong><code>{file.objectKey.split("/").at(-1)}</code></span></span>
          <span><strong className="table-product-title">{file.productTitle}</strong><small>{file.itemId}</small></span>
          <span>{file.sourceDataset ?? "聚合资产"}</span><span>{formatBytes(file.byteSize)}</span><span><span className={`status-pill ${file.needsReview ? "warning" : "success"}`}>{file.needsReview ? "待复核" : "正常"}</span></span>
        </button>)}
      </div>}

      {selected && <><button className="drawer-backdrop" aria-label="关闭文件详情" onClick={() => setSelected(null)} /><aside className="file-drawer" aria-label="文件详情">
        <header><div><p className="section-kicker">FILE DETAIL</p><h2>文件详情</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="关闭"><X size={19} /></button></header>
        {selected.contentType.startsWith("image/") && selected.sourceUrl ? <div className="file-preview"><img src={selected.sourceUrl} alt={selected.productTitle} /></div> : <div className="file-preview document-preview"><FileJson size={36} /><span>{selected.kind}</span></div>}
        <div className="drawer-section"><span className={`status-pill ${selected.needsReview ? "warning" : "success"}`}>{selected.needsReview ? "待复核" : "正常"}</span><h3>{selected.productTitle}</h3><Link className="text-link" href={`/ecommerce/${selected.itemId}`}>查看商品 <ExternalLink size={15} /></Link></div>
        <dl className="drawer-details"><div><dt>文件类型</dt><dd>{selected.contentType}</dd></div><div><dt>资产类型</dt><dd>{selected.kind}</dd></div><div><dt>文件大小</dt><dd>{formatBytes(selected.byteSize)}</dd></div><div><dt>来源数据集</dt><dd>{selected.sourceDataset ?? "聚合资产"}</dd></div><div><dt>SHA256</dt><dd><code>{selected.sha256}</code></dd></div><div><dt>OSS 路径</dt><dd><code>{selected.objectKey}</code><button className="icon-button" onClick={copyPath} aria-label="复制 OSS 路径" title="复制 OSS 路径">{copied ? <Check size={17} /> : <Copy size={17} />}</button></dd></div></dl>
      </aside></>}
    </div>
  );
}

export default function FilesPage() {
  return <Suspense fallback={<div className="detail-loading"><div className="skeleton block" /></div>}><FilesContent /></Suspense>;
}
