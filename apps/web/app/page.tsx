import Link from "next/link";
import { ArrowRight, Boxes, Database, FileArchive } from "lucide-react";

const sections = [
  { title: "数据总览", description: "查看采集数量与处理状态" },
  { title: "内部资料", description: "小蔡：历史项目、需求、反馈和素材" },
  { title: "聊天记录", description: "查看已收集的原始聊天文件" },
  { title: "电商商品", description: "小李：平台商品、SKU、图片和文案", href: "/ecommerce", icon: Boxes },
  { title: "文件详情", description: "预览文件、来源信息与 OSS 路径", href: "/files", icon: FileArchive },
  { title: "数据导入", description: "导入当前爬取的商品和文件数据", href: "/imports", icon: Database },
];

export default function Home() {
  return (
    <div className="legacy-home">
      <p className="eyebrow">DLR DATA PIPELINE</p>
      <h1>数据采集后台</h1>
      <p className="legacy-lead">第一阶段：让采集结果可见、可追溯、可验收。</p>
      <nav className="legacy-entry-grid" aria-label="功能入口">
        {sections.map(({ title, description, href, icon: Icon }) => {
          const content = <>
            <div className="legacy-card-heading">{Icon && <Icon size={19} />}<h2>{title}</h2></div>
            <p>{description}</p>
            <span>{href ? <>进入功能 <ArrowRight size={15} /></> : "功能开发中"}</span>
          </>;
          return href
            ? <Link className="legacy-entry-card enabled" href={href} key={title}>{content}</Link>
            : <div className="legacy-entry-card" key={title}>{content}</div>;
        })}
      </nav>
    </div>
  );
}
