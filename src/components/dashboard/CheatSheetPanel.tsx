"use client";

const RuleCard = ({ bg, border, title, emoji, children }: { bg: string; border: string; title: string; emoji: string; children: React.ReactNode }) => (
  <div className="rounded-lg p-3" style={{ backgroundColor: bg, border: `2px solid ${border}` }}>
    <div className="flex items-center gap-2 mb-2">
      <span className="text-lg">{emoji}</span>
      <span className="font-bold text-sm text-white">{title}</span>
    </div>
    <div className="text-xs space-y-1 text-gray-300">{children}</div>
  </div>
);

const Check = ({ children, bold, color }: { children: React.ReactNode; bold?: boolean; color?: string }) => (
  <div className="flex items-start gap-1.5">
    <span className="text-green-400 mt-0.5">✓</span>
    <span style={{ fontWeight: bold ? 700 : 400, color: color || "#d1d5db" }}>{children}</span>
  </div>
);

export default function CheatSheetPanel() {
  return (
    <div className="space-y-4 text-sm">
      {/* Title */}
      <div className="text-center">
        <div className="text-xl font-bold text-white">DAILY OPTIONS TRADING CHEAT SHEET</div>
        <div className="text-xs text-gray-400 italic">Nifty & Sensex | 1-2 Trades Per Day</div>
      </div>

      {/* ═══ SETUP 1 ═══ */}
      <RuleCard bg="#0c2d48" border="#16213e" title="SETUP 1: CORRELATION BREAKDOWN" emoji="🔗">
        <div className="text-gray-400 mb-1">When Nifty & Sensex stop moving together</div>
        <Check bold>Check: 5-day correlation {"<"} 0.94</Check>
        <Check bold>Check: Return gap {">"} 0.15%</Check>
        <Check bold color="#ef4444">Action: BUY the one BEHIND, SELL the one AHEAD</Check>
        <Check color="#9ca3af">Example: Nifty +1.2%, Sensex +0.5% → Buy Sensex Call</Check>
      </RuleCard>

      {/* ═══ SETUP 2 ═══ */}
      <RuleCard bg="#431407" border="#e67e22" title="SETUP 2: GAP FADE" emoji="📉">
        <div className="text-gray-400 mb-1">When index opens with big gap, bet on reversal</div>
        <Check bold>Check: Gap from prev close {">"} 0.5%</Check>
        <Check bold color="#ef4444">Action: Gap UP → Buy PUT | Gap DOWN → Buy CALL</Check>
        <Check color="#9ca3af">Example: Nifty gaps +0.8% → Buy Nifty Put (ATM)</Check>
      </RuleCard>

      {/* ═══ SETUP 3 ═══ */}
      <RuleCard bg="#052e16" border="#27ae60" title="SETUP 3: EMA20 BOUNCE" emoji="📊">
        <div className="text-gray-400 mb-1">When price touches the 20-day EMA and bounces</div>
        <Check bold>Check: Price within 0.3% of EMA20</Check>
        <Check bold color="#ef4444">Action: Above EMA → Buy PUT | Below EMA → Buy CALL</Check>
        <Check color="#9ca3af">Example: Nifty at 24270, EMA20 at 24250 → Buy Call</Check>
      </RuleCard>

      {/* ═══ STRIKE SELECTION ═══ */}
      <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
        <div className="text-center font-bold text-sm text-white mb-2">HOW TO PICK STRIKE PRICE</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="font-bold text-blue-400 mb-1">NIFTY</div>
            <div className="text-xs space-y-0.5 text-gray-300">
              <div>ATM Strike = Round to nearest 50</div>
              <div>If spot = 24270 → ATM = 24300</div>
              <div>ITM Call = 24250 (safer)</div>
              <div>OTM Call = 24350 (riskier)</div>
            </div>
          </div>
          <div>
            <div className="font-bold text-purple-400 mb-1">SENSEX</div>
            <div className="text-xs space-y-0.5 text-gray-300">
              <div>ATM Strike = Round to nearest 100</div>
              <div>If spot = 77763 → ATM = 77800</div>
              <div>ITM Call = 77700 (safer)</div>
              <div>OTM Call = 77900 (riskier)</div>
            </div>
          </div>
        </div>
        <div className="text-center text-xs text-gray-400 mt-2 italic">💡 RULE: Beginners use ATM. Experts use slightly ITM.</div>
      </div>

      {/* ═══ SL & TP ═══ */}
      <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
        <div className="text-center font-bold text-sm text-white mb-3">STOP LOSS & TAKE PROFIT</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-red-900/40 border border-red-600 rounded-lg p-3 text-center">
            <div className="font-bold text-red-400 mb-1">🛑 STOP LOSS</div>
            <div className="text-xs text-gray-300">SL Premium = Entry × 0.65</div>
            <div className="text-xs text-gray-500">(Lose 35% of premium)</div>
            <div className="text-xs text-gray-300 mt-1">Buy @ ₹100 → SL @ ₹65</div>
            <div className="text-xs text-gray-500">Max loss per lot = ₹35 × 25 = ₹875</div>
          </div>
          <div className="bg-green-900/40 border border-green-600 rounded-lg p-3 text-center">
            <div className="font-bold text-green-400 mb-1">🎯 TAKE PROFIT</div>
            <div className="text-xs text-gray-300">TP = Entry + (Risk × 2)</div>
            <div className="text-xs text-gray-500">(Minimum 1:2 Risk:Reward)</div>
            <div className="text-xs text-gray-300 mt-1">Buy @ ₹100, Risk ₹35 → TP = ₹170</div>
            <div className="text-xs text-gray-500">Profit per lot = ₹70 × 25 = ₹1,750</div>
          </div>
        </div>
      </div>

      {/* ═══ POSITION SIZE ═══ */}
      <div className="bg-gray-800 border border-gray-600 rounded-lg p-3">
        <div className="text-center font-bold text-sm text-white mb-2">POSITION SIZE CALCULATOR</div>
        <div className="text-center text-xs text-gray-300 mb-2">Lots = (Capital × 2%) ÷ (Risk per lot)</div>
        <div className="text-center text-xs text-gray-500 space-y-0.5">
          <div>Capital ₹1,00,000 | Premium ₹100 | SL ₹65 | Lot size 25</div>
          <div>Risk per lot = (100 - 65) × 25 = ₹875</div>
          <div>Max risk = ₹1,00,000 × 2% = ₹2,000</div>
        </div>
        <div className="text-center text-sm font-bold text-green-400 mt-1">Lots = ₹2,000 ÷ ₹875 = 2 lots</div>
      </div>

      {/* ═══ DAILY RULES ═══ */}
      <div className="bg-yellow-900/20 border border-yellow-600 rounded-lg p-3">
        <div className="text-center font-bold text-sm text-yellow-400 mb-2">⚠️ DAILY RULES (DO NOT BREAK)</div>
        <div className="space-y-1.5 text-xs text-gray-300">
          {[
            "MAX 2 trades per day. No exceptions.",
            "Risk only 2% of capital per trade.",
            "Set SL and TP BEFORE entering. Use GTT orders.",
            "If SL hits on Trade #1, NO Trade #2 today.",
            "Close all positions by 3:15 PM (avoid expiry chaos).",
            "If no setup matches, DO NOT FORCE a trade.",
            "Keep a journal. Review every weekend.",
          ].map((rule, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-yellow-500 font-bold">{i + 1}.</span>
              <span>{rule}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
