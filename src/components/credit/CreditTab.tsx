"use client";

// ─── Credit Tab ───────────────────────────────────────────────────
// Live auto-suggest panel (default) + the standalone calculator
// iframe behind a toggle. Keeps the original HTML dashboard intact.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import CreditAutoSuggest from "./CreditAutoSuggest";

export default function CreditTab() {
  const [view, setView] = useState<"suggest" | "calc">("suggest");

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center gap-1 p-1.5 border-b">
        <Button
          variant={view === "suggest" ? "default" : "ghost"}
          size="sm"
          className="h-6 text-[9px] px-2 font-bold"
          onClick={() => setView("suggest")}
        >
          Auto-Suggest
        </Button>
        <Button
          variant={view === "calc" ? "default" : "ghost"}
          size="sm"
          className="h-6 text-[9px] px-2 font-bold"
          onClick={() => setView("calc")}
        >
          Calculator
        </Button>
      </div>

      {view === "suggest" ? (
        <CreditAutoSuggest />
      ) : (
        <iframe
          src="/static/credit-spread-dashboard.html"
          style={{
            width: "100%",
            flex: 1,
            border: "none",
            margin: 0,
            padding: 0,
          }}
          sandbox="allow-scripts allow-same-origin allow-modals"
          className="w-full"
        />
      )}
    </div>
  );
}
