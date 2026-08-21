const sections = [
  ["数据总览", "查看采集数量与处理状态"],
  ["内部资料", "小蔡：历史项目、需求、反馈和素材"],
  ["聊天记录", "查看已收集的原始聊天文件"],
  ["电商商品", "小李：平台商品、SKU、图片和文案"],
  ["文件详情", "预览文件、来源信息与 OSS 路径"],
];

export default function Home() {
  return (
    <main>
      <p className="eyebrow">DLR DATA PIPELINE</p>
      <h1>数据采集后台</h1>
      <p className="lead">第一阶段：让采集结果可见、可追溯、可验收。</p>
      <section>
        {sections.map(([title, description]) => (
          <article key={title}><h2>{title}</h2><p>{description}</p><span>功能开发中</span></article>
        ))}
      </section>
    </main>
  );
}
