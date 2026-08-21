import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Featured Playlists",
  description: "Explore featured electronic music playlists curated by Showcase.",
};

const featuredPlaylists = [
  {
    number: "01",
    title: "Afterhours Signal",
    description:
      "Melodic, progressive, and late-night records for the hours after the room goes dark.",
    genres: "Progressive house · Melodic techno",
    artworkClass: "playlist-artwork-pink",
  },
  {
    number: "02",
    title: "Pressure System",
    description: "Fast-moving bass selections built around jungle breaks and drum & bass momentum.",
    genres: "Drum & bass · Jungle",
    artworkClass: "playlist-artwork-blue",
  },
  {
    number: "03",
    title: "Low Light / High Energy",
    description:
      "Club-focused cuts that move between garage swing, breaks, and bass-heavy pressure.",
    genres: "UK garage · Breaks · Bass",
    artworkClass: "playlist-artwork-orange",
  },
] as const;

export default function FeaturedPlaylistsPage() {
  return (
    <div className="listing-page page-shell editorial-page">
      <header className="listing-hero editorial-hero">
        <p className="kicker">
          <span /> CURATED LISTENING
        </p>
        <h1>
          Featured playlists
          <br />
          <em>for every frequency.</em>
        </h1>
        <p>
          Hand-picked lanes through EDM, from late-night bass to high-energy club records. Playlist
          links and full track selections will be added as each edition goes live.
        </p>
      </header>

      <section className="playlist-grid" aria-label="Featured playlists">
        {featuredPlaylists.map((playlist) => (
          <article className="playlist-card" key={playlist.title}>
            <div className={`playlist-artwork ${playlist.artworkClass}`} aria-hidden="true">
              <span>{playlist.number}</span>
              <i />
              <b>SHOWCASE</b>
            </div>
            <p className="meta">FEATURED PLAYLIST {playlist.number}</p>
            <h2>{playlist.title}</h2>
            <p>{playlist.description}</p>
            <p className="playlist-genres">{playlist.genres}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
