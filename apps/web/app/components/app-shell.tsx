"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, Database, FileArchive, House, PanelLeftClose } from "lucide-react";

const navigation = [
  { href: "/", label: "返回首页", icon: House },
  { href: "/ecommerce", label: "电商商品", icon: Boxes },
  { href: "/files", label: "文件资产", icon: FileArchive },
  { href: "/imports", label: "导入中心", icon: Database },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isEntryPage = pathname === "/";
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className={`app-shell ${isEntryPage ? "entry-shell" : ""}`}>
      {!isEntryPage && <aside className="sidebar">
        <div className="brand"><span>DLR</span><div><strong>DATA ROOM</strong><small>COMMERCE OPS</small></div></div>
        <nav aria-label="主导航">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link className={active(href) ? "active" : ""} href={href} key={href}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer"><PanelLeftClose size={17} /><span>DLR Pipeline v0.1</span></div>
      </aside>}
      <main className="content">{children}</main>
      {!isEntryPage && <nav className="mobile-nav" aria-label="移动端主导航">
        {navigation.map(({ href, label, icon: Icon }) => (
          <Link className={active(href) ? "active" : ""} href={href} key={href}>
            <Icon size={20} /><span>{label}</span>
          </Link>
        ))}
      </nav>}
    </div>
  );
}
