import type { ArtworkTone } from "../lib/public-catalog";

interface ArtworkProps {
  readonly label: string;
  readonly tone: ArtworkTone;
  readonly size?: "card" | "detail" | "artist";
}

export function Artwork({ label, tone, size = "card" }: ArtworkProps) {
  return (
    <div
      className={`artwork artwork-${tone} artwork-${size}`}
      role="img"
      aria-label={`Placeholder artwork for ${label}`}
    >
      <span>{label.slice(0, 2).toUpperCase()}</span>
      <i aria-hidden="true" />
    </div>
  );
}
