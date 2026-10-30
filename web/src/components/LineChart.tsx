import { useEffect, useRef, useState } from 'react';

export interface Series {
  key: string;
  label: string;
  color: string; // a CSS color, normally var(--series-n)
}

// Multi-series line chart with a snapping crosshair and one tooltip listing every series.
export function LineChart({ data, series, xKey, height = 240, formatX }: { data: Record<string, any>[]; series: Series[]; xKey: string; height?: number; formatX?: (v: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(720);
  const fx = formatX ?? ((v: string) => v);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(280, el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { top: 8, right: 12, bottom: 24, left: 34 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const max = Math.max(4, ...data.flatMap((d) => series.map((s) => Number(d[s.key] ?? 0))));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const x = (i: number) => pad.left + (data.length <= 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v: number) => pad.top + h - (v / top) * h;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.ceil(data.length / 8);

  const onMove = (e: React.PointerEvent) => {
    const box = ref.current!.getBoundingClientRect();
    const rel = ((e.clientX - box.left) * (width / box.width) - pad.left) / w;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(rel * (data.length - 1)))));
  };

  return (
    <div>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key}>
              <span className="legend-key" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div
        className="chart"
        ref={ref}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={`Daily ${series.map((s) => s.label.toLowerCase()).join(', ')}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'baseline' : 'gridline'} x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={pad.left - 8} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % labelEvery === 0 ? (
              <text key={i} className="tick" x={x(i)} y={height - 6} textAnchor="middle">
                {fx(d[xKey])}
              </text>
            ) : null,
          )}
          {series.map((s) => (
            <polyline
              key={s.key}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={data.map((d, i) => `${x(i)},${y(Number(d[s.key] ?? 0))}`).join(' ')}
            />
          ))}
          {hover != null && (
            <g>
              <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + h} />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(Number(data[hover][s.key] ?? 0))} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hover != null && (
          <div
            className="tooltip"
            style={{
              left: `${(x(hover) / width) * 100}%`,
              top: 0,
              transform: x(hover) > width * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
            }}
          >
            <div className="muted" style={{ marginBottom: 4 }}>
              {fx(data[hover][xKey])}
            </div>
            {series.map((s) => (
              <div className="tooltip-row" key={s.key}>
                <span className="legend-key" style={{ background: s.color, marginRight: 0 }} />
                <strong>{Number(data[hover][s.key] ?? 0)}</strong>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function niceStep(raw: number) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// Horizontal funnel: one hue, each stage's bar length is its share of the first stage.
export function Funnel({ stages }: { stages: { label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div>
      {stages.map((s) => (
        <div className="funnel-row" key={s.label} title={`${s.label}: ${s.value}`}>
          <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>{s.label}</span>
          <div className="funnel-bar">
            <span style={{ width: `${(s.value / max) * 100}%` }} />
          </div>
          <span className="num" style={{ textAlign: 'right' }}>
            <strong>{s.value}</strong>
            {s.note && <span className="muted"> · {s.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
