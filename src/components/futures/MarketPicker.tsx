'use client';

import { useMemo, useState, useEffect } from 'react';
import { Search, Star, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Majors pinned at the top of the picker for quick access.
const MAJORS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT'];

// Coins marked as favorites (persisted in localStorage).
function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem('nexus-favs');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

interface Props {
  marketList: string[];
  selected: string;
  onSelect: (m: string) => void;
}

export function MarketPicker({ marketList, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites());

  useEffect(() => {
    try {
      localStorage.setItem('nexus-favs', JSON.stringify([...favorites]));
    } catch {}
  }, [favorites]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const favs = [...favorites].filter(f => marketList.includes(f));
    const base = q ? [] : [...new Set([...MAJORS.filter(m => marketList.includes(m)), ...favs])];
    const matches = q
      ? marketList.filter(m => m.includes(q))
      : marketList.filter(m => !base.includes(m));
    const ranked = [...base, ...matches].slice(0, 60);
    return { base: q ? [] : [...base], matches: q ? matches.slice(0, 60) : matches.slice(0, 50) };
  }, [marketList, query, favorites]);

  const toggleFav = (m: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  };

  const baseLabel = selected?.replace(/USDT$/, '').replace(/INR$/, '').replace(/BTC$/, '') || '';

  const Row = ({ m, isFav }: { m: string; isFav: boolean }) => (
    <button
      key={m}
      onClick={() => { onSelect(m); setOpen(false); setQuery(''); }}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-mono text-left cursor-pointer transition-colors',
        m === selected ? 'bg-[#1e3a5f] text-[#d1d4dc]' : 'hover:bg-[#1e222d] text-[#d1d4dc]'
      )}
    >
      <span className="flex-1 truncate">{m}</span>
      <span
        role="button"
        onClick={(e) => toggleFav(m, e as any)}
        className="cursor-pointer p-0.5"
        title={isFav ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Star className={cn('h-3 w-3', isFav ? 'text-[#ffeb3b] fill-[#ffeb3b]' : 'text-[#5d6070]')} />
      </span>
      {m === selected && <Check className="h-3 w-3 text-[#26a69a]" />}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1.5 bg-[#0a0e17] border border-[#1e222d] rounded px-2 py-1 text-[11px] font-mono cursor-pointer hover:border-[#2157f3] transition-colors"
          style={{ color: '#d1d4dc' }}
        >
          <span className="font-bold">{baseLabel || '—'}</span>
          <span className="text-[8px] text-[#5d6070] uppercase tracking-wider">▼</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" sideOffset={6}>
        <div className="flex flex-col" style={{ background: '#0d1321', border: '1px solid #1e222d' }}>
          {/* Search box */}
          <div className="flex items-center gap-2 px-2.5 py-2" style={{ borderBottom: '1px solid #1e222d' }}>
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: '#5d6070' }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search market… (e.g. BTC, ETH, SOL)"
              className="flex-1 bg-transparent text-[11px] font-mono outline-none placeholder:text-[#5d6070]"
              style={{ color: '#d1d4dc' }}
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-[10px] text-[#5d6070] cursor-pointer hover:text-[#d1d4dc]">
                ✕
              </button>
            )}
          </div>
          <div className="text-[8px] uppercase tracking-wider px-2.5 pt-1.5 pb-1" style={{ color: '#5d6070' }}>
            {query ? `Matches (${filtered.matches.length})` : `Favorites & Majors (${filtered.base.length})`}
          </div>
          {/* Results */}
          <div className="max-h-64 overflow-y-auto">
            {filtered.base.map(m => <Row key={m} m={m} isFav={favorites.has(m)} />)}
            {filtered.matches.map(m => <Row key={m} m={m} isFav={favorites.has(m)} />)}
            {filtered.base.length === 0 && filtered.matches.length === 0 && (
              <div className="px-3 py-6 text-center text-[10px]" style={{ color: '#5d6070' }}>
                No markets match "{query}"
              </div>
            )}
          </div>
          <div className="px-2.5 py-1.5 text-[8px]" style={{ color: '#3d4050', borderTop: '1px solid #1e222d' }}>
            {marketList.length} markets · ★ to favorite · type to search
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}