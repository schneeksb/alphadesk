import { useId } from "react";

// Thrive Invest lighthouse badge — the circular scene from the brand lockup,
// reusable at any size (header, login). Gradient ids are made unique per instance
// via useId so multiple badges on one page don't collide.
export default function BrandMark({ size = 32, style }) {
  const raw = useId().replace(/[:]/g, "");
  const id = (n) => `${n}${raw}`;
  return (
    <svg viewBox="24 24 192 192" width={size} height={size} style={style} aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={id("sky")} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a9def8"/><stop offset="100%" stopColor="#6cc0ec"/></linearGradient>
        <linearGradient id={id("water")} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2f8fc4"/><stop offset="100%" stopColor="#1c6aa0"/></linearGradient>
        <linearGradient id={id("ring")} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8fd4f2"/><stop offset="100%" stopColor="#2f7fb8"/></linearGradient>
        <linearGradient id={id("tb")} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3f92cf"/><stop offset="100%" stopColor="#265f96"/></linearGradient>
        <radialGradient id={id("lamp")} cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#fff" stopOpacity="1"/><stop offset="100%" stopColor="#eaf7ff" stopOpacity="0"/></radialGradient>
        <clipPath id={id("disc")}><circle cx="120" cy="120" r="88"/></clipPath>
      </defs>
      <circle cx="120" cy="120" r="94" fill="#0a2038"/>
      <circle cx="120" cy="120" r="94" fill="none" stroke={`url(#${id("ring")})`} strokeWidth="4"/>
      <g clipPath={`url(#${id("disc")})`}>
        <rect x="32" y="32" width="176" height="176" fill={`url(#${id("sky")})`}/>
        <circle cx="80" cy="80" r="36" fill="#fff" opacity="0.28"/>
        <g stroke="#fff" strokeWidth="2.6" strokeLinecap="round" opacity="0.8"><line x1="108" y1="96" x2="95" y2="87"/><line x1="132" y1="96" x2="145" y2="87"/><line x1="120" y1="90" x2="120" y2="78"/></g>
        <circle cx="120" cy="100" r="16" fill={`url(#${id("lamp")})`}/>
        <path d="M95 170 q13 -15 50 0 Z" fill="#4a5b66"/>
        <path d="M110.5 170 L114.5 104 H125.5 L129.5 170 Z" fill="#f4fbff"/>
        <path d="M112.2 150 h15.6 l1 10 h-17.6 Z" fill={`url(#${id("tb")})`}/>
        <path d="M113.5 126 h13 l0.9 9 h-14.8 Z" fill={`url(#${id("tb")})`}/>
        <rect x="111" y="99" width="18" height="6" rx="1.5" fill="#22415c"/>
        <rect x="114" y="88" width="12" height="12" rx="1.5" fill="#22415c"/>
        <rect x="116.5" y="90" width="7" height="8" rx="1" fill="#fff6cf"/>
        <path d="M112 88 L120 79 L128 88 Z" fill={`url(#${id("tb")})`}/>
        <rect x="32" y="170" width="176" height="38" fill={`url(#${id("water")})`}/>
        <path d="M32 170 H208" stroke="#dff2fb" strokeWidth="2"/>
        <g stroke="#cfeefb" strokeWidth="2.4" strokeLinecap="round" opacity="0.85"><path d="M56 182 h16"/><path d="M96 192 h14"/><path d="M140 184 h16"/><path d="M172 194 h14"/></g>
      </g>
    </svg>
  );
}
