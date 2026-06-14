export default function VideoPlayer({
  src,
  label,
}: {
  src: string;
  label?: string;
}) {
  return (
    <span className="ai-video-player my-2 flex w-full max-w-2xl flex-col gap-2 rounded-md border border-border bg-bg-alt p-2">
      <span className="text-xs font-medium text-fg-dim">
        {label || '视频'}
      </span>
      <video
        src={src}
        controls
        preload="metadata"
        className="max-h-[420px] w-full rounded border border-border bg-black"
      />
    </span>
  );
}
