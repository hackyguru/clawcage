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
        <div key={i} className="bg-base-200 rounded-lg p-3">
          <div className="text-xs text-base-content/60 uppercase tracking-wider">{card.label}</div>
          <div className="text-xl font-bold mt-1" style={card.color ? { color: card.color } : undefined}>
            {card.value}
          </div>
          {card.detail && (
            <div className="text-xs text-base-content/50 mt-0.5">{card.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}
