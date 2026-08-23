"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Box, Check, Copy, Download, ExternalLink, FileJson, Image as ImageIcon, Maximize2, PackageOpen, ShieldAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { API_BASE, formatBytes, formatNumber, type ProductDetail } from "../../lib/api";

type Tab = "overview" | "details" | "sku" | "attributes" | "files";

interface SkuPreview {
  imageUrl: string;
  specName: string;
  downloadUrl: string | null;
  isFallback: boolean;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "--";
}

function imageUrlKey(value: unknown): string {
  return typeof value === "string" ? value.replace(/^https?:/, "").split("?", 1)[0] : "";
}

function imageDownloadUrl(itemId: string, sha256: string): string {
  return `${API_BASE}/api/ecommerce/products/${encodeURIComponent(itemId)}/images/${sha256}/download`;
}

export default function ProductDetailPage() {
  const params = useParams<{ itemId: string }>();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [activeImage, setActiveImage] = useState(0);
  const [copied, setCopied] = useState("");
  const [skuPreview, setSkuPreview] = useState<SkuPreview | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/ecommerce/products/${encodeURIComponent(params.itemId)}`)
      .then(async (response) => {
        const body = await response.json() as ProductDetail & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "商品读取失败");
        setProduct(body);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [params.itemId]);

  useEffect(() => {
    if (!skuPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSkuPreview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [skuPreview]);

  const payload = product?.payload ?? {};
  const market = objectValue(payload.market);
  const shop = objectValue(payload.shop);
  const attributes = objectValue(payload.attributes);
  const sku = objectValue(payload.sku);
  const combinations = Array.isArray(sku.combinations) ? sku.combinations.map(objectValue) : [];
  const inventory = objectValue(sku.inventory_and_prices);
  const images = product?.images ?? [];
  const mainImages = useMemo(() => images.filter((image) => image.imageType === "main"), [images]);
  const skuImages = useMemo(() => images.filter((image) => image.imageType === "sku"), [images]);
  const detailImages = useMemo(() => images.filter((image) => image.imageType === "detail"), [images]);
  const skuValueById = new Map<string, Record<string, unknown>>();
  for (const property of Array.isArray(sku.properties) ? sku.properties.map(objectValue) : []) {
    for (const value of Array.isArray(property.values) ? property.values.map(objectValue) : []) {
      const valueId = textValue(value.vid);
      if (valueId !== "--") skuValueById.set(valueId, value);
    }
  }
  const skuImageByUrl = new Map(skuImages.map((image) => [imageUrlKey(image.sourceUrl), image]));
  const gallery = mainImages.length ? mainImages : images.slice(0, 8);
  const skuFallbackImage = gallery[0] ?? null;
  const heroImage = gallery[Math.min(activeImage, Math.max(0, gallery.length - 1))];

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(value);
    window.setTimeout(() => setCopied(""), 1200);
  };

  if (error) return <div className="empty-state page-error"><PackageOpen size={28} /><h1>商品无法打开</h1><p>{error}</p><Link className="button secondary-button" href="/ecommerce"><ArrowLeft size={16} /> 返回商品列表</Link></div>;
  if (!product) return <div className="detail-loading"><div className="skeleton hero-skeleton" /><div><span className="skeleton line" /><span className="skeleton line short" /><span className="skeleton block" /></div></div>;

  return (
    <div className="page-stack detail-page">
      <header className="detail-topbar">
        <Link className="back-link" href="/ecommerce"><ArrowLeft size={17} /> 商品列表</Link>
        <div className="detail-actions"><span className={`status-pill ${product.needsReview ? "warning" : "success"}`}>{product.needsReview ? "待图片复核" : "已复核"}</span><a className="icon-button" href={product.sourceUrl} target="_blank" rel="noreferrer" aria-label="打开商品源页" title="打开商品源页"><ExternalLink size={18} /></a></div>
      </header>

      <section className="product-hero">
        <div className="gallery">
          <div className="hero-image">{heroImage ? <><img src={heroImage.sourceUrl} alt={product.title} /><a className="icon-button image-download-button" href={imageDownloadUrl(product.itemId, heroImage.sha256)} aria-label="下载当前商品主图" title="下载当前主图"><Download size={17} /></a></> : <ImageIcon size={34} />}</div>
          {gallery.length > 1 && <div className="thumbnail-strip">{gallery.slice(0, 6).map((image, index) => <button className={activeImage === index ? "active" : ""} onClick={() => setActiveImage(index)} key={image.sha256} aria-label={`查看第 ${index + 1} 张主图`}><img src={image.sourceUrl} alt="" /></button>)}</div>}
        </div>
        <div className="product-summary">
          <div className="product-source"><span>{product.platform.toUpperCase()}</span><span>{product.sourceDataset ?? "未知来源"}</span></div>
          <h1>{product.title}</h1>
          <div className="detail-classification"><span>{product.brand ?? "品牌未分类"}</span><span>{product.category ?? "商品未分类"}</span></div>
          <p className="product-code">ITEM ID · {product.itemId}</p>
          <div className="summary-metrics">
            <div><span>采集价格</span><strong>{product.price === null ? "--" : `¥${formatNumber(product.price)}`}</strong></div>
            <div><span>公开销量</span><strong>{formatNumber(product.sales)}</strong></div>
            <div><span>图片资产</span><strong>{product.imageCount}</strong></div>
          </div>
          <dl className="summary-list">
            <div><dt>店铺</dt><dd>{textValue(shop.name)}</dd></div>
            <div><dt>评分</dt><dd>{textValue(market.rating_observed)}</dd></div>
            <div><dt>最近采集</dt><dd>{new Date(product.latestCollectedAt).toLocaleString("zh-CN")}</dd></div>
          </dl>
        </div>
      </section>

      <div className="tabs" role="tablist">
        {([['overview', '商品概览'], ['details', `详情图 ${detailImages.length}`], ['sku', 'SKU'], ['attributes', '商品参数'], ['files', `文件资产 ${product.rawFiles.length + product.images.length}`]] as const).map(([value, label]) => <button role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)} key={value}>{label}</button>)}
      </div>

      {tab === "overview" && <section className="detail-section overview-grid">
        <div><p className="section-kicker">DESCRIPTION</p><h2>采集文案</h2><p className="long-copy">{textValue(payload.detail_text || payload.description || payload.sku_text)}</p></div>
        <div><p className="section-kicker">PROVENANCE</p><h2>来源追踪</h2><dl className="detail-list"><div><dt>数据集</dt><dd>{product.sourceDataset ?? "--"}</dd></div><div><dt>采集范围</dt><dd>{textValue(objectValue(payload.provenance).collection_scope)}</dd></div><div><dt>HTTP 状态</dt><dd>{textValue(objectValue(payload.provenance).response_status)}</dd></div></dl></div>
      </section>}

      {tab === "details" && <section className="detail-section"><div className="section-heading"><div><p className="section-kicker">PRODUCT DETAILS</p><h2>商品详情图</h2></div><span className="muted-count">{detailImages.length} 张</span></div>{detailImages.length ? <div className="detail-image-feed">{detailImages.map((image, index) => <figure key={image.sha256}><img src={image.sourceUrl} alt={`${product.title}详情图 ${index + 1}`} width={image.width ?? 790} height={image.height ?? 790} loading="lazy" /><a className="icon-button image-download-button" href={imageDownloadUrl(product.itemId, image.sha256)} aria-label={`下载第 ${index + 1} 张商品详情图`} title="下载详情图"><Download size={17} /></a></figure>)}</div> : <div className="compact-empty"><ImageIcon size={22} /><strong>现有采集记录未包含详情图</strong><p>重新执行完整采集后会显示在这里。</p></div>}</section>}

      {tab === "sku" && <section className="detail-section"><div className="section-heading"><div><p className="section-kicker">VARIANTS</p><h2>SKU 组合</h2></div><span className="muted-count">{combinations.length} 个 · {skuImages.length ? `${skuImages.length} 张独立图` : skuFallbackImage ? "0 张独立图 · 主图兜底" : "0 张图"}</span></div>{combinations.length ? <>
        {!skuImages.length && skuFallbackImage && <div className="inline-callout"><ImageIcon size={18} /><span>源商品未提供独立 SKU 图片，以下使用商品主图作为预览。</span></div>}
        <div className="data-table sku-table"><div className="table-row table-head sku-table-row"><span>图片</span><span>SKU ID</span><span>规格</span><span>库存</span><span>价格</span><span>操作</span></div>{combinations.map((combination, index) => {
        const skuId = textValue(combination.skuId);
        const propPath = typeof combination.propPath === "string" ? combination.propPath : "";
        const propertyValues = propPath.split(";").map((segment) => {
          const parts = segment.split(":");
          return skuValueById.get(parts[parts.length - 1]);
        }).filter((value): value is Record<string, unknown> => Boolean(value));
        const specName = propertyValues.map((value) => textValue(value.name)).join(" / ") || propPath || "--";
        const valueImageUrl = propertyValues.map((value) => value.image).find((value) => typeof value === "string");
        const importedImage = skuImageByUrl.get(imageUrlKey(valueImageUrl)) ?? skuImages.find((image) => image.alt === specName);
        const hasSourceImage = Boolean(importedImage || typeof valueImageUrl === "string");
        const imageUrl = importedImage?.sourceUrl ?? (typeof valueImageUrl === "string" ? valueImageUrl : skuFallbackImage?.sourceUrl ?? "");
        const downloadUrl = importedImage
          ? imageDownloadUrl(product.itemId, importedImage.sha256)
          : !hasSourceImage && skuFallbackImage
            ? imageDownloadUrl(product.itemId, skuFallbackImage.sha256)
            : null;
        const preview = imageUrl ? { imageUrl, specName, downloadUrl, isFallback: !hasSourceImage } : null;
        const stock = objectValue(inventory[skuId]);
        const price = objectValue(stock.subPrice || stock.price);
        return <div className="table-row sku-table-row" key={`${skuId}-${index}`}><span className="sku-image-cell">{preview ? <button type="button" className={preview.isFallback ? "sku-image-fallback" : ""} onClick={() => setSkuPreview(preview)} aria-label={`预览 ${specName}${preview.isFallback ? "（主图兜底）" : ""} 的 SKU 图片`} title={preview.isFallback ? "商品未提供独立 SKU 图，当前显示主图" : "预览 SKU 图片"}><img src={imageUrl} alt={specName} loading="lazy" />{preview.isFallback && <small>主图</small>}</button> : <span className="sku-image-placeholder"><ImageIcon size={17} /></span>}</span><strong>{skuId}</strong><span className="sku-spec-cell"><strong>{specName}</strong><small>{propPath || "--"}</small></span><span>{textValue(stock.quantity)}</span><span>{price.priceText ? `¥${textValue(price.priceText)}` : "--"}</span><span className="sku-row-actions">{preview ? <button type="button" className="icon-button compact-icon-button" onClick={() => setSkuPreview(preview)} aria-label={`预览 ${specName}${preview.isFallback ? "（主图兜底）" : ""} 图片`} title={preview.isFallback ? "预览主图兜底" : "预览图片"}><Maximize2 size={15} /></button> : null}{downloadUrl ? <a className="icon-button compact-icon-button" href={downloadUrl} aria-label={`下载 ${specName} 图片`} title={preview?.isFallback ? "下载主图兜底" : "下载图片"}><Download size={15} /></a> : null}</span></div>;
      })}</div></> : <div className="compact-empty"><Box size={22} /><strong>未采集到 SKU 组合</strong></div>}</section>}

      {tab === "attributes" && <section className="detail-section"><div className="section-heading"><div><p className="section-kicker">ATTRIBUTES</p><h2>商品参数</h2></div><span className="muted-count">{Object.keys(attributes).length} 项</span></div>{Object.keys(attributes).length ? <dl className="attribute-grid">{Object.entries(attributes).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{textValue(value)}</dd></div>)}</dl> : <div className="compact-empty"><Box size={22} /><strong>现有采集记录未包含商品参数</strong><p>该商品目前只有轻量采集数据。</p></div>}</section>}

      {tab === "files" && <section className="detail-section file-section"><div className="section-heading"><div><p className="section-kicker">OBJECT STORAGE</p><h2>文件与 OSS 路径</h2></div><Link className="text-link" href={`/files?q=${product.itemId}`}>在文件库查看 <ExternalLink size={15} /></Link></div>
        <div className="file-groups"><div><h3><ImageIcon size={17} /> 图片资产 <span>{product.images.length}</span></h3><div className="asset-list">{product.images.slice(0, 12).map((image) => <div className="asset-row" key={image.sha256}><img src={image.sourceUrl} alt="" /><div><strong>{image.imageType}</strong><code>{image.objectKey}</code></div><span className="asset-row-actions"><a className="icon-button" href={imageDownloadUrl(product.itemId, image.sha256)} aria-label={`下载 ${image.imageType} 图片`} title="下载图片"><Download size={17} /></a><button className="icon-button" onClick={() => copy(image.objectKey)} aria-label="复制 OSS 路径" title="复制 OSS 路径">{copied === image.objectKey ? <Check size={17} /> : <Copy size={17} />}</button></span></div>)}</div></div>
        <div><h3><FileJson size={17} /> 原始文件 <span>{product.rawFiles.length}</span></h3><div className="asset-list">{product.rawFiles.map((file) => <div className="asset-row raw-row" key={`${file.sourceDataset}-${file.kind}-${file.relativePath}-${file.sha256}`}><div className="file-type-icon"><FileJson size={19} /></div><div><strong>{file.kind}</strong><code>{file.objectKey}</code><small>{formatBytes(file.byteSize)} · {file.sourceDataset}</small></div><button className="icon-button" onClick={() => copy(file.objectKey)} aria-label="复制 OSS 路径" title="复制 OSS 路径">{copied === file.objectKey ? <Check size={17} /> : <Copy size={17} />}</button></div>)}</div></div></div>
        {product.needsReview && <div className="inline-callout"><ShieldAlert size={18} /><span>该商品包含需要人工复核的图片资产。</span></div>}
      </section>}

      {skuPreview && <><button type="button" className="sku-preview-backdrop" onClick={() => setSkuPreview(null)} aria-label="关闭 SKU 图片预览" /><section className="sku-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="sku-preview-title"><header><div><p className="section-kicker">SKU IMAGE</p><h2 id="sku-preview-title">SKU 图片预览</h2></div><button type="button" className="icon-button" onClick={() => setSkuPreview(null)} aria-label="关闭预览" title="关闭"><X size={18} /></button></header><div className="sku-preview-canvas"><img src={skuPreview.imageUrl} alt={skuPreview.specName} /></div><footer><strong>{skuPreview.specName}</strong>{skuPreview.isFallback && <span className="muted-count">主图兜底</span>}{skuPreview.downloadUrl && <a className="button primary-button" href={skuPreview.downloadUrl}><Download size={16} /> 下载图片</a>}</footer></section></>}
    </div>
  );
}
