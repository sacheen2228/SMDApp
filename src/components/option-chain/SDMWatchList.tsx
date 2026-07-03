// SDM Watch List Component
// Displays items the bot is watching when no active signal

import type { WatchListItem } from "@/types/sdm";

interface SDMWatchListProps {
  items: WatchListItem[];
}

export function SDMWatchList({ items }: SDMWatchListProps) {
  if (items.length === 0) return null;

  const formatOI = (oi: number) => {
    if (oi >= 100000) return `${(oi / 100000).toFixed(1)}L`;
    if (oi >= 1000) return `${(oi / 1000).toFixed(0)}K`;
    return oi.toString();
  };

  const getTypeIcon = (type: WatchListItem["type"]) => {
    switch (type) {
      case "CE_SELLER_TRAP":
      case "PE_SELLER_TRAP":
        return "🪤";
      case "OI_SUPPORT":
        return "🛡️";
      case "OI_RESISTANCE":
        return "🧱";
    }
  };

  const getDistanceColor = (distance: number) => {
    if (distance < 0.5) return "text-red-400";
    if (distance < 1) return "text-amber-400";
    return "text-gray-400";
  };

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">
        👀 WATCHING
      </div>
      {items.slice(0, 8).map((item, i) => (
        <div
          key={i}
          className="flex items-center gap-2 text-[10px] text-gray-300"
        >
          <span>{getTypeIcon(item.type)}</span>
          <span className="flex-1 truncate">{item.description}</span>
          <span className={getDistanceColor(item.distance)}>
            {item.distance.toFixed(1)}%
          </span>
        </div>
      ))}
      <div className="text-[9px] text-gray-500 italic pt-1">
        Waiting for spot to approach seller SL zone
      </div>
    </div>
  );
}
