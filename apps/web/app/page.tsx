import Link from "next/link";
import { ArrowRight, Boxes, Database, FileArchive, FolderOpen, MessagesSquare } from "lucide-react";

const sections = [
  { title: "数据总览", description: "查看采集数量与处理状态" },
  { title: "内部数据", description: "按群聊或单聊浏览已持久化的飞书消息", href: "/internal-data", action: "浏览内部数据", icon: FolderOpen },
  { title: "聊天记录", description: "接入飞书并按时间范围采集历史消息", href: "/collectors/feishu", action: "进入飞书历史采集", icon: MessagesSquare },
  { title: "电商商品", description: "小李：平台商品、SKU、图片和文案", href: "/ecommerce", action: "浏览电商商品", icon: Boxes },
  { title: "文件详情", description: "预览文件、来源信息与 OSS 路径", href: "/files", action: "浏览文件资产", icon: FileArchive },
  { title: "数据导入", description: "导入当前爬取的商品和文件数据", href: "/imports", action: "管理数据导入", icon: Database },
];

export default function Home() {
  return (
    <div className="legacy-home">
      <p className="eyebrow">DLR DATA PIPELINE</p>
      <h1>数据采集后台</h1>
      <p className="legacy-lead">第一阶段：让采集结果可见、可追溯、可验收。</p>
      <nav className="legacy-entry-grid" aria-label="功能入口">
        {sections.map(({ title, description, href, action, icon: Icon }) => {
          const content = <>
            <span className="legacy-entry-icon">{Icon ? <Icon size={20} /> : "·"}</span>
            <strong>{title}</strong>
            <span>{description}</span>
            {href && <span className="legacy-entry-action">{action}<ArrowRight size={15} /></span>}
          </>;
          return href
            ? <Link className="legacy-entry-card enabled" href={href} key={title}>{content}</Link>
            : <div className="legacy-entry-card" key={title}>{content}</div>;
        })}
      </nav>
    </div>
  );
}
