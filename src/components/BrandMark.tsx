// 品牌徽记：自包含内联 SVG，无外部图片 / CDN 依赖。
// 造型 = 野外笔记的方形印章 + 三趾兽爪印。
type Props = { className?: string };

export default function BrandMark({ className = "h-14 w-14" }: Props) {
  return (
    <svg
      viewBox="0 0 96 96"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="5" width="86" height="86" fill="none" stroke="var(--accent)" strokeWidth="2" />
      <rect x="11" y="11" width="74" height="74" fill="none" stroke="var(--stroke2)" strokeWidth="2" />
      <rect x="44" y="17" width="8" height="4" fill="var(--accent)" opacity="0.55" />
      <circle cx="30" cy="43" r="6" fill="var(--accent)" />
      <circle cx="48" cy="35" r="6.5" fill="var(--accent)" />
      <circle cx="66" cy="43" r="6" fill="var(--accent)" />
      <path
        d="M48 55c-7.5 0-13 5.5-13 12 0 5 5 9 13 9s13-4 13-9c0-6.5-5.5-12-13-12z"
        fill="var(--accent)"
      />
      <rect x="24" y="84" width="48" height="2" fill="var(--accent)" opacity="0.4" />
    </svg>
  );
}
