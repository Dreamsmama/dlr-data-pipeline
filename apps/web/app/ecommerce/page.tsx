"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Database, ImageOff, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { API_BASE, formatNumber, type ProductListItem } from "../lib/api";

interface ProductResponse {
  items: ProductListItem[];
  total: number;
  brands: string[];
  categories: string[];
  error?: string;
}

export default function EcommercePage() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [review, setReview] = useState<"all" | "pending">("all");
  const [brand, setBrand] = useState("all");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ProductResponse>({ items: [], total: 0, brands: [], categories: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setSearch(query.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ q: search, review, brand, category, page: String(page), pageSize: "24" });
    fetch(`${API_BASE}/api/ecommerce/products?${params}`, { signal: controller.signal })
      .then((response) => response.json() as Promise<ProductResponse>)
      .then(setData)
      .catch((error) => { if (error.name !== "AbortError") setData({ items: [], total: 0, brands: [], categories: [], error: "无法连接 API 服务" }); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [brand, category, page, review, search]);

  const pages = Math.max(1, Math.ceil(data.total / 24));

  return (
    <div className="page-stack">
      <Link className="page-back" href="/"><ArrowLeft size={16} /> 返回首页</Link>
      <header className="page-header split-header">
        <div><p className="eyebrow">ECOMMERCE CATALOG</p><h1>电商商品</h1><p className="page-description">Tmall 商品、SKU、图片与采集快照</p></div>
        <Link className="button primary-button" href="/imports"><Database size={17} /> 导入数据</Link>
      </header>

      <div className="toolbar">
        <label className="search-box">
          <Search size={18} />
          <span className="sr-only">搜索商品</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品名称或 Item ID" />
        </label>
        <div className="catalog-filters">
          <label className="catalog-filter"><span>品牌</span><select value={brand} onChange={(event) => { setBrand(event.target.value); setPage(1); }}><option value="all">全部品牌</option>{data.brands.map((value) => <option value={value} key={value}>{value}</option>)}<option value="__uncategorized__">未分类</option></select></label>
          <label className="catalog-filter"><span>商品分类</span><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="all">全部分类</option>{data.categories.map((value) => <option value={value} key={value}>{value}</option>)}<option value="__uncategorized__">未分类</option></select></label>
        </div>
        <div className="segmented-control" aria-label="复核状态">
          <SlidersHorizontal size={16} aria-hidden="true" />
          <button className={review === "all" ? "active" : ""} onClick={() => { setReview("all"); setPage(1); }}>全部</button>
          <button className={review === "pending" ? "active" : ""} onClick={() => { setReview("pending"); setPage(1); }}>待复核</button>
        </div>
        <span className="result-count">{loading ? "读取中" : `${data.total.toLocaleString("zh-CN")} 件商品`}</span>
      </div>

      {data.error && <div className="notice warning-notice"><span className="notice-dot" /><div><strong>数据暂不可用</strong><p>{data.error}</p></div><Link href="/imports">检查导入 <ArrowRight size={16} /></Link></div>}

      {!loading && data.items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><ImageOff size={25} /></div>
          <h2>{search ? "没有匹配的商品" : "还没有商品数据"}</h2>
          <p>{search ? "调整关键词或筛选条件。" : "从已扫描的数据源执行导入。"}</p>
          {!search && <Link className="button secondary-button" href="/imports">前往导入 <ArrowRight size={16} /></Link>}
        </div>
      ) : (
        <section className="product-grid" aria-busy={loading}>
          {loading && Array.from({ length: 8 }, (_, index) => <div className="product-card skeleton-card" key={index}><div /><span /><span /></div>)}
          {!loading && data.items.map((product) => (
            <Link className="product-card" href={`/ecommerce/${product.itemId}`} key={`${product.platform}-${product.itemId}`}>
              <div className="product-image">
                {product.thumbnailUrl ? <img src={product.thumbnailUrl} alt="" loading="lazy" /> : <ImageOff size={26} />}
                {product.needsReview && <span className="review-flag">待复核</span>}
              </div>
              <div className="product-card-body">
                <div className="product-meta"><span>{product.platform.toUpperCase()}</span><span>{product.imageCount} 张图</span></div>
                <div className="product-classification"><span>{product.brand ?? "品牌未分类"}</span><span>{product.category ?? "商品未分类"}</span></div>
                <h2>{product.title}</h2>
                <p className="item-id">ID {product.itemId}</p>
                <div className="product-metrics"><strong>{product.price === null ? "价格待采集" : `¥${formatNumber(product.price)}`}</strong><span>销量 {formatNumber(product.sales)}</span></div>
              </div>
            </Link>
          ))}
        </section>
      )}

      {data.total > 24 && (
        <nav className="pagination" aria-label="商品分页">
          <button aria-label="上一页" disabled={page === 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button>
          <span>{page} / {pages}</span>
          <button aria-label="下一页" disabled={page === pages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button>
        </nav>
      )}
    </div>
  );
}
