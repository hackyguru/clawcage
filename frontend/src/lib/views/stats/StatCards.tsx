// StatCards -- grid of summary statistic cards for stats tabs
import type { ReactNode } from 'react';

export interface StatCard {
  label: string;
  value: string | number;
  detail?: string;
  color?: string;
}

interface Props {
  cards: StatCard[];
}

export default function StatCards({ cards }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((card, i) => (
        <div key={i} className="glass border border-edge rounded-lg p-3 shadow-xs">
          <div className="text-[10px] text-content/40 uppercase tracking-widest font-semibold">{card.label}</div>
          <div className="text-xl font-bold mt-1.5 tabular-nums" style={card.color ? { color: card.color } : undefined}>
            {card.value}
          </div>
          {card.detail && (
            <div className="text-xs text-content/40 mt-0.5">{card.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}
