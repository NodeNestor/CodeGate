import React, { useState, useEffect } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import {
  Users,
  SlidersHorizontal,
  UsersRound,
  Shield,
  FileText,
  Wrench,
  Settings,
  Zap,
} from "lucide-react";

import Accounts from "./pages/Accounts";
import Configs from "./pages/Configs";
import Tenants from "./pages/Tenants";
import Guardrails from "./pages/Guardrails";
import Logs from "./pages/Logs";
import Setup from "./pages/Setup";
import SettingsPage from "./pages/Settings";

const NAV_ITEMS = [
  {
    to: "/",
    label: "Accounts",
    end: true,
    icon: <Users className="h-5 w-5" />,
  },
  {
    to: "/configs",
    label: "Configs",
    icon: <SlidersHorizontal className="h-5 w-5" />,
  },
  {
    to: "/tenants",
    label: "Tenants",
    icon: <UsersRound className="h-5 w-5" />,
  },
  {
    to: "/privacy",
    label: "Guardrails",
    icon: <Shield className="h-5 w-5" />,
  },
  {
    to: "/logs",
    label: "Logs",
    icon: <FileText className="h-5 w-5" />,
  },
  {
    to: "/setup",
    label: "Setup",
    icon: <Wrench className="h-5 w-5" />,
  },
  {
    to: "/settings",
    label: "Settings",
    icon: <Settings className="h-5 w-5" />,
  },
];

export default function App() {
  const [multiTenancy, setMultiTenancy] = useState(false);
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setMultiTenancy(s.multi_tenancy === "true"))
      .catch(() => {});
  }, []);

  const visibleNav = multiTenancy
    ? NAV_ITEMS
    : NAV_ITEMS.filter((item) => item.to !== "/tenants");

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-800">
          <div className="p-1.5 rounded-lg bg-brand-600/20">
            <Zap className="h-5 w-5 text-brand-400" />
          </div>
          <span className="text-lg font-bold text-gray-100">CodeGate</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-3 space-y-1">
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-gray-800 text-brand-400 border-l-2 border-brand-500 -ml-px pl-[11px]"
                    : "text-gray-400 hover:bg-gray-800/50 hover:text-gray-200"
                }`
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800">
          <p className="text-xs text-gray-600">CodeGate v1.0.0</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-8">
        <div className="max-w-7xl mx-auto">
          <Routes>
            <Route path="/" element={<Accounts />} />
            <Route path="/configs" element={<Configs />} />
            {multiTenancy && <Route path="/tenants" element={<Tenants />} />}
            <Route path="/privacy" element={<Guardrails />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
