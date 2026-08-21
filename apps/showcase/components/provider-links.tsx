import { ExternalLink } from "lucide-react";
import type { PublicProviderLinks } from "../lib/public-catalog";

interface ProviderLinksProps {
  readonly links: PublicProviderLinks;
  readonly compact?: boolean;
}

export function ProviderLinks({ links, compact = false }: ProviderLinksProps) {
  if (links.spotify === undefined && links.appleMusic === undefined) {
    return <p className="provider-empty">Listening links are not available yet.</p>;
  }

  return (
    <div className={compact ? "provider-links provider-links-compact" : "provider-links"}>
      {links.spotify !== undefined ? (
        <a href={links.spotify} target="_blank" rel="noreferrer">
          Spotify <ExternalLink size={13} aria-hidden="true" />
        </a>
      ) : null}
      {links.appleMusic !== undefined ? (
        <a href={links.appleMusic} target="_blank" rel="noreferrer">
          Apple Music <ExternalLink size={13} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}
