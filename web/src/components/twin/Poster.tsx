"use client";

/** Static rig silhouette shown while the 3D chunk loads (and as a no-WebGL fallback). Fills its parent. */
export function TwinPoster({ accent = "#22d3ee", bg = "#0a1224" }: { accent?: string; bg?: string }) {
  const z = [50, 100, 150];
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ background: bg }}>
      <svg viewBox="0 0 520 200" className="w-[min(90%,900px)] opacity-60" aria-hidden="true">
        <g fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round">
          {/* tank */}
          <rect x="20" y="40" width="60" height="120" rx="8" />
          <rect x="26" y="90" width="48" height="64" rx="4" fill={accent} fillOpacity="0.18" stroke="none" />
          {/* main line: tank -> pump -> master -> manifold */}
          <line x1="80" y1="100" x2="200" y2="100" />
          <rect x="105" y="86" width="28" height="28" rx="4" />
          <circle cx="165" cy="100" r="10" />
          <rect x="200" y="42" width="14" height="116" rx="4" />
          {/* branches */}
          {z.map((y) => (
            <g key={y}>
              <line x1="214" y1={y} x2="440" y2={y} />
              <rect x="232" y={y - 9} width="18" height="18" rx="3" />
              <circle cx="285" cy={y} r="8" />
              <line x1="320" y1={y} x2="350" y2={y} strokeWidth="4" strokeOpacity="0.5" />
              <circle cx="385" cy={y} r="8" />
            </g>
          ))}
          <rect x="440" y="42" width="14" height="116" rx="4" />
          {/* return */}
          <polyline points="454,150 490,150 490,182 50,182 50,160" strokeDasharray="6 8" strokeOpacity="0.6" />
        </g>
      </svg>
      <div className="absolute bottom-8 text-[11px] uppercase tracking-[0.3em]" style={{ color: accent, opacity: 0.7 }}>
        loading 3d twin
      </div>
    </div>
  );
}

export default TwinPoster;
