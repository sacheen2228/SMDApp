"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function ExpiryDayOptionSurvivalCalculator({
  initialStrike,
  initialUnderlying,
  initialEntry,
  initialLotSize,
  initialOptionType,
}: {
  initialStrike?: number;
  initialUnderlying?: number;
  initialEntry?: number;
  initialLotSize?: number;
  initialOptionType?: "CE" | "PE";
} = {}) {
  const [strike, setStrike] = useState<number>(initialStrike ?? 25500);
  const [underlying, setUnderlying] = useState<number>(initialUnderlying ?? 25030);
  const [entryPremium, setEntryPremium] = useState<number>(initialEntry ?? 45);
  const [optionType, setOptionType] = useState<"CE" | "PE">(initialOptionType ?? "CE");
  const [lotSize, setLotSize] = useState<number>(initialLotSize ?? 50);
  const [stopPct, setStopPct] = useState<number>(25);

  const calc = useMemo(() => {
    const entry = entryPremium;
    const slPremium = entry * (1 - stopPct/100);
    const tp1Premium = entry * 1.5;
    const tp2Premium = entry * 2.0;
    const tp3Premium = entry * 2.0; // as per request TP 1 2 2
    const riskPerLot = (entry - slPremium) * lotSize;
    const reward1 = (tp1Premium - entry) * lotSize;
    const reward2 = (tp2Premium - entry) * lotSize;
    const reward3 = (tp3Premium - entry) * lotSize;
    const rr1 = riskPerLot > 0 ? reward1 / riskPerLot : 0;
    const rr2 = riskPerLot > 0 ? reward2 / riskPerLot : 0;
    const rr3 = riskPerLot > 0 ? reward3 / riskPerLot : 0;
    return { entry, slPremium, tp1Premium, tp2Premium, tp3Premium, riskPerLot, reward1, reward2, reward3, rr1, rr2, rr3 };
  }, [entryPremium, lotSize, stopPct]);

  const moneyness = optionType === "CE" ? underlying - strike : strike - underlying;

  return (
    <Card className="bg-[#0b0f1a] border-[#1f2330]">
      <CardHeader>
        <CardTitle className="text-sm">Expiry-Day Option Survival / Zero-Hero Calculator</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Underlying</Label>
            <Input type="number" value={underlying} onChange={e=>setUnderlying(Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Strike Price</Label>
            <Input type="number" value={strike} onChange={e=>setStrike(Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Option Type</Label>
            <Select value={optionType} onValueChange={v=>setOptionType(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CE">CE</SelectItem>
                <SelectItem value="PE">PE</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Entry Premium ₹</Label>
            <Input type="number" value={entryPremium} onChange={e=>setEntryPremium(Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Lot Size</Label>
            <Input type="number" value={lotSize} onChange={e=>setLotSize(Number(e.target.value))} />
          </div>
          <div>
            <Label className="text-xs">Stop %</Label>
            <Input type="number" value={stopPct} onChange={e=>setStopPct(Number(e.target.value))} />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="bg-[#121826] rounded p-2">
            <div className="text-zinc-400">Moneyness</div>
            <div className="font-bold">{moneyness.toFixed(2)}</div>
          </div>
          <div className="bg-[#121826] rounded p-2">
            <div className="text-zinc-400">Entry</div>
            <div className="font-bold">₹{calc.entry.toFixed(2)}</div>
          </div>
          <div className="bg-[#121826] rounded p-2">
            <div className="text-zinc-400">SL Premium</div>
            <div className="font-bold text-red-400">₹{calc.slPremium.toFixed(2)}</div>
          </div>
          <div className="bg-[#121826] rounded p-2">
            <div className="text-zinc-400">Risk / Lot</div>
            <div className="font-bold text-red-400">₹{calc.riskPerLot.toFixed(0)}</div>
          </div>
        </div>

        <div className="bg-[#0f1420] border border-[#1f2330] rounded p-3 text-xs">
          <div className="font-bold mb-1">Trade Plan</div>
          <div className="grid grid-cols-2 gap-2">
            <div>Entry: <span className="font-mono">₹{calc.entry.toFixed(2)}</span></div>
            <div>Lots: 1 × Lot {lotSize} · Qty: {lotSize}</div>
            <div>SL: <span className="font-mono text-red-400">₹{calc.slPremium.toFixed(2)}</span></div>
            <div>TP1: <span className="font-mono text-emerald-400">₹{calc.tp1Premium.toFixed(2)}</span></div>
            <div>TP2: <span className="font-mono text-emerald-400">₹{calc.tp2Premium.toFixed(2)}</span></div>
            <div>TP3: <span className="font-mono text-emerald-400">₹{calc.tp3Premium.toFixed(2)}</span></div>
          </div>
          <div className="mt-2 text-[10px] text-zinc-500">
            On expiry day, premiums can gap or fall faster than a stop-loss can execute. Treat SL as indicative. Calculated as {stopPct}% drop from entry.
          </div>
        </div>

        <div className="space-y-2">
          {[
            {label:'TP1', premium:calc.tp1Premium, reward:calc.reward1, rr:calc.rr1},
            {label:'TP2', premium:calc.tp2Premium, reward:calc.reward2, rr:calc.rr2},
            {label:'TP3', premium:calc.tp3Premium, reward:calc.reward3, rr:calc.rr3},
          ].map(t=>(
            <div key={t.label} className="flex items-center justify-between bg-[#121826] rounded p-2">
              <div>
                <Badge className="bg-emerald-600">{t.label}</Badge>
                <span className="ml-2 text-xs text-zinc-300">Premium ₹{t.premium.toFixed(2)} • Reward ₹{t.reward.toFixed(0)}</span>
              </div>
              <div className="text-xs">R:R {t.rr.toFixed(2)}</div>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-zinc-500">
          TP1 = 1.5× entry, TP2 = 2.0× entry, TP3 = 2.0× entry. SL = entry × (1 - stop%). Adjust stop% for expiry-day survival.
        </p>
      </CardContent>
    </Card>
  );
}
