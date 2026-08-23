import type { ReactNode } from "react";

export const metadata = {
  title: "飞书历史采集 · DLR",
  description: "使用机器人或官方 Lark CLI 选择群聊、单聊并逐页采集飞书历史消息",
};

export default function FeishuCollectorLayout({ children }: { children: ReactNode }) {
  return children;
}
