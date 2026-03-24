// Shared chart styling utilities for stats tabs
import type { CSSProperties } from 'react';

/** Shared Recharts tooltip contentStyle matching our brand. */
export const chartTooltipStyle: CSSProperties = {
  background: 'var(--color-surface-alt)',
  border: '1px solid var(--color-edge)',
  borderRadius: 8,
  fontSize: 12,
  fontFamily: 'inherit',
};

/** Compact pie-chart label — positioned outside the slice, small monospace font. */
export function PieLabel({ cx, cy, midAngle, outerRadius, name, percent }: {
  cx: number; cy: number; midAngle: number; outerRadius: number; name: string; percent: number;
}) {
  const RADIAN = Math.PI / 180;
  const radius = outerRadius + 14;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text
      x={x} y={y}
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      fontSize={10}
      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      fill="var(--color-content)"
      opacity={0.7}
    >
      {name} {(percent * 100).toFixed(0)}%
    </text>
  );
}
