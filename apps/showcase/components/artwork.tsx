import type { ArtworkTone, PublicArtwork } from "../lib/public-catalog";

interface ArtworkProps {
  readonly appleMusicUrl?: string;
  readonly artwork?: PublicArtwork | undefined;
  readonly label: string;
  readonly tone: ArtworkTone;
  readonly size?: "card" | "detail" | "artist";
}

export function Artwork({ appleMusicUrl, artwork, label, tone, size = "card" }: ArtworkProps) {
  if (artwork !== undefined && appleMusicUrl !== undefined) {
    return (
      <figure className={`apple-artwork apple-artwork-${size}`}>
        <a
          className="apple-artwork-image-link"
          href={appleMusicUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${label} on Apple Music`}
        >
          <img
            className="apple-artwork-image"
            src={artwork.url}
            width={artwork.width}
            height={artwork.height}
            alt={`${label} release artwork`}
            loading="lazy"
            decoding="async"
          />
        </a>
        <figcaption>
          <a href={appleMusicUrl} target="_blank" rel="noreferrer">
            Artwork via Apple Music
          </a>
        </figcaption>
      </figure>
    );
  }
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
