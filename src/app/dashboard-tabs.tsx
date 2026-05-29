"use client";

import { useState, type ReactNode } from "react";

type DashboardTabsProps = {
  overview: ReactNode;
  autopilot: ReactNode;
  tripleGuide: ReactNode;
  performance: ReactNode;
  positions: ReactNode;
  transactions: ReactNode;
};

const TABS = [
  { id: "autopilot", label: "Autopilot" },
  { id: "performance", label: "Growth" },
  { id: "positions", label: "Positions" },
  { id: "transactions", label: "Transactions" }
] as const;

type TabId = (typeof TABS)[number]["id"];

export function DashboardTabs({ overview, autopilot, tripleGuide, performance, positions, transactions }: DashboardTabsProps) {
  const [activeTab, setActiveTab] = useState<TabId>("autopilot");
  const panels = { overview, autopilot, tripleGuide, performance, positions, transactions };

  return (
    <>
      <nav className="tabs" aria-label="Dashboard sections">
        {TABS.map((tab) => (
          <button
            aria-controls={`tab-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            className="tab-button"
            id={`tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {TABS.map((tab) => (
        <div
          aria-labelledby={`tab-${tab.id}`}
          hidden={activeTab !== tab.id}
          id={`tab-panel-${tab.id}`}
          key={tab.id}
          role="tabpanel"
        >
          {panels[tab.id]}
        </div>
      ))}
    </>
  );
}
