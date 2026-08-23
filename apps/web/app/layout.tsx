import type { ReactNode } from "react";
import { AppShell } from "./components/app-shell";
import "./styles.css";

export const metadata = {
  title: { default: "DLR 数据采集后台", template: "%s | DLR" },
  description: "DLR 电商数据采集与资产管理后台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body><AppShell>{children}</AppShell></body></html>;
}
