import React from "react";
import { cn } from "../utils.js";

export interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export interface SidebarProps {
  groups: NavGroup[];
  currentPath: string;
  onNavigate: (path: string) => void;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function Sidebar({ groups, currentPath, onNavigate, collapsed = false, onToggle }: SidebarProps) {
  return (
    <aside
      className={cn(
        "flex flex-col h-full backdrop-blur-xl",
        "border-r border-white/[0.08]",
        "transition-all duration-300",
        collapsed ? "w-16" : "w-60",
      )}
      style={{
        background: "linear-gradient(180deg, rgba(5,10,14,0.97) 0%, rgba(9,15,21,0.97) 100%)",
        backgroundImage: "radial-gradient(rgba(0, 255, 136, 0.05) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    >
      {/* Top glowing accent line */}
      <div
        className="h-[2px] w-full flex-shrink-0"
        style={{
          background: "linear-gradient(90deg, transparent 0%, #00ff88 30%, #00d4ff 70%, transparent 100%)",
          boxShadow: "0 0 12px rgba(0, 255, 136, 0.6), 0 0 24px rgba(0, 212, 255, 0.3)",
        }}
      />

      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/[0.08]">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{
            background: "linear-gradient(135deg, rgba(0, 255, 136, 0.15) 0%, rgba(0, 212, 255, 0.1) 100%)",
            border: "1px solid rgba(0, 255, 136, 0.3)",
            boxShadow: "0 0 12px rgba(0, 255, 136, 0.2), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}
        >
          <span
            className="font-bold text-sm"
            style={{
              fontFamily: "var(--font-display, 'Space Grotesk', sans-serif)",
              color: "#00ff88",
              textShadow: "0 0 8px rgba(0, 255, 136, 0.8)",
            }}
          >
            P
          </span>
        </div>
        {!collapsed && (
          <div className="flex flex-col overflow-hidden">
            <span
              className="text-sm font-semibold leading-tight"
              style={{
                fontFamily: "var(--font-display, 'Space Grotesk', sans-serif)",
                color: "rgba(240,244,240,0.95)",
                letterSpacing: "0.03em",
              }}
            >
              PCCP
            </span>
            <span
              className="text-[10px] font-mono uppercase tracking-wider"
              style={{ color: "rgba(0, 255, 136, 0.55)" }}
            >
              Physical Capability Cloud
            </span>
          </div>
        )}
        {onToggle && (
          <button
            onClick={onToggle}
            className="ml-auto transition-colors"
            style={{ color: "rgba(255,255,255,0.25)" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgba(0, 255, 136, 0.7)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.25)"; }}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d={collapsed ? "M6 4l4 4-4 4" : "M10 4l-4 4 4 4"}
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-6">
        {groups.map((group) => (
          <div key={group.title}>
            {!collapsed && (
              <div
                className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-widest"
                style={{ color: "rgba(255,255,255,0.2)" }}
              >
                {group.title}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = currentPath === item.path || currentPath.startsWith(item.path + "/");
                return (
                  <button
                    key={item.path}
                    onClick={() => onNavigate(item.path)}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-150",
                      collapsed && "justify-center px-0",
                    )}
                    style={
                      isActive
                        ? {
                            background: "linear-gradient(90deg, rgba(0, 255, 136, 0.12) 0%, rgba(0, 212, 255, 0.04) 100%)",
                            color: "#00ff88",
                            boxShadow: "0 0 16px rgba(0, 255, 136, 0.12), inset 1px 0 0 rgba(0, 255, 136, 0.4)",
                            border: "1px solid rgba(0, 255, 136, 0.15)",
                            textShadow: "0 0 8px rgba(0, 255, 136, 0.4)",
                          }
                        : {
                            color: "rgba(255,255,255,0.45)",
                            border: "1px solid transparent",
                          }
                    }
                    onMouseEnter={(e) => {
                      if (!isActive) {
                        const el = e.currentTarget as HTMLButtonElement;
                        el.style.color = "rgba(255,255,255,0.8)";
                        el.style.background = "rgba(255,255,255,0.04)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) {
                        const el = e.currentTarget as HTMLButtonElement;
                        el.style.color = "rgba(255,255,255,0.45)";
                        el.style.background = "transparent";
                      }
                    }}
                    title={collapsed ? item.label : undefined}
                  >
                    <span className="flex-shrink-0 w-5 h-5">{item.icon}</span>
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Version */}
      {!collapsed && (
        <div className="px-4 py-3 border-t border-white/[0.08]">
          <span
            className="text-[10px] font-mono"
            style={{ color: "rgba(255,255,255,0.15)" }}
          >
            PCCP v0.1.0
          </span>
        </div>
      )}
    </aside>
  );
}
