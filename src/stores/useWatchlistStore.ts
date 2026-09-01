import { create } from "zustand";

interface WatchlistItem {
  symbol: string;
  name: string;
  sector: string;
  addedAt: number;
  notes?: string;
}

interface WatchlistStore {
  items: WatchlistItem[];
  isLoading: boolean;
  fetchWatchlist: () => Promise<void>;
  addToWatchlist: (symbol: string, name?: string, sector?: string) => Promise<void>;
  removeFromWatchlist: (symbol: string) => Promise<void>;
  isInWatchlist: (symbol: string) => boolean;
}

export const useWatchlistStore = create<WatchlistStore>((set, get) => ({
  items: [],
  isLoading: false,
  fetchWatchlist: async () => {
    set({ isLoading: true });
    try {
      const res = await fetch("/api/watchlist");
      const data = await res.json();
      set({ items: data.items || [], isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },
  addToWatchlist: async (symbol, name, sector) => {
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, name, sector }),
    });
    await get().fetchWatchlist();
  },
  removeFromWatchlist: async (symbol) => {
    await fetch(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
    await get().fetchWatchlist();
  },
  isInWatchlist: (symbol) => get().items.some((i) => i.symbol === symbol.toUpperCase()),
}));
