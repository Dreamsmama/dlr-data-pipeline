import type { ReactNode } from "react";
import "./styles.css";

export const metadata = { title: "DLR 数据采集后台" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
