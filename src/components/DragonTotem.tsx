// 黑白水墨龙图腾：本地透明 PNG（public/dragon-ink.png），无外部 CDN 依赖。
// 图源基于用户提供的参考图做图生图，去边框、转黑白水墨、去水印、抠透明底。
// 纯装饰：调用方通过 opacity / className 控制呈现，组件本身不占布局。
type Props = { className?: string };

export default function DragonTotem({ className = "h-16 w-16" }: Props) {
  return (
    <img
      src="/dragon-ink.png"
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
