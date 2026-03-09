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
        "flex flex-col h-full bg-forest-900/80 border-r border-white/[0.06] backdrop-blur-xl",
        "transition-all duration-300",
        collapsed ? "w-16" : "w-60",
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/[0.06]">
        <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
          <span className="text-green-400 font-bold text-sm">P</span>
        </div>
        {!collapsed && (
          <div className="flex flex-col overflow-hidden">
            <span className="text-sm font-semibold text-white/90 leading-tight">PCC</span>
            <span className="text-[10px] text-green-400/70 font-mono uppercase tracking-wider">Ground Control</span>
          </div>
        )}
        {onToggle && (
          <button
            onClick={onToggle}
            className="ml-auto text-white/30 hover:text-white/60 transition-colors"
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
              <div className="px-3 mb-2 text-[10px] font-semibold text-white/25 uppercase tracking-widest">
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
                      isActive
                        ? "bg-green-500/15 text-green-400 shadow-[0_0_12px_rgba(124,179,66,0.1)]"
                        : "text-white/50 hover:text-white/80 hover:bg-white/[0.04]",
                      collapsed && "justify-center px-0",
                    )}
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
        <div className="px-4 py-3 border-t border-white/[0.06]">
          <span className="text-[10px] font-mono text-white/20">PCC v0.1.0</span>
        </div>
      )}
    </aside>
  );
}
