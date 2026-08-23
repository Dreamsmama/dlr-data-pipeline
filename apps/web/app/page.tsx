import Link from "next/link";

const sections = [
  { title: "数据总览", description: "查看采集数量与处理状态" },
  {
    title: "内部数据",
    description: "按飞书群组和单聊查看已入库的历史消息和附件",
    href: "/internal-data",
    action: "进入内部数据",
  },
  {
    title: "聊天记录",
    description: "查看已收集的原始聊天文件",
    href: "/collectors/feishu",
    action: "进入飞书历史采集",
  },
  { title: "电商商品", description: "小李：平台商品、SKU、图片和文案" },
  { title: "文件详情", description: "预览文件、来源信息与 OSS 路径" },
];

export default function Home() {
  return (
    <main className="dashboard-home">
      <header className="dashboard-hero">
        <p className="eyebrow">DLR DATA PIPELINE</p>
        <h1>数据采集后台</h1>
        <p className="lead">第一阶段：让采集结果可见、可追溯、可验收。</p>
      </header>
      <section className="dashboard-grid" aria-label="采集功能">
        {sections.map((section) => (
          <article className={`dashboard-card ${section.href ? "dashboard-card-active" : ""}`} key={section.title}>
            <div>
              <h2>{section.title}</h2>
              <p>{section.description}</p>
            </div>
            {section.href ? (
              <Link className="dashboard-action" href={section.href}>{section.action}<span aria-hidden="true">→</span></Link>
            ) : (
              <span className="dashboard-status">功能开发中</span>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
