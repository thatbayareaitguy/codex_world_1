import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Featured Playlists",
  description: "Explore featured electronic music playlists curated by Showcase.",
};

const featuredPlaylists = [
  {
    number: "01",
    title: "Showcase New Release Radar",
    description:
      "Melodic, progressive, and late-night records for the hours after the room goes dark.",
    genres: "Progressive house · Melodic techno",
    artworkClass: "playlist-artwork-pink",
    artworkImage: "/showcase-new-release-radar.png",
    spotifyUrl: "https://open.spotify.com/playlist/4l6LaMPL6duulmFe3hRR4Y?si=ebd8c808bcff40f9",
  },
  {
    number: "02",
    title: "What we're listening to",
    description: "Fast-moving bass selections built around jungle breaks and drum & bass momentum.",
    genres: "Drum & bass · Jungle",
    artworkClass: "playlist-artwork-blue",
    artworkImage: null,
    spotifyUrl: null,
  },
  {
    number: "03",
    title: "Low Light / High Energy",
    description:
      "Club-focused cuts that move between garage swing, breaks, and bass-heavy pressure.",
    genres: "UK garage · Breaks · Bass",
    artworkClass: "playlist-artwork-orange",
    artworkImage: null,
    spotifyUrl: null,
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
        {featuredPlaylists.map((playlist) => {
          const artwork = (
            <div
              className={`playlist-artwork ${playlist.artworkClass} ${playlist.artworkImage ? "playlist-artwork-image-backed" : ""}`}
              aria-hidden="true"
            >
              {playlist.artworkImage ? (
                <Image
                  className="playlist-artwork-image"
                  src={playlist.artworkImage}
                  alt=""
                  fill
                  sizes="(max-width: 560px) calc(100vw - 32px), (max-width: 820px) calc((100vw - 70px) / 2), 390px"
                />
              ) : (
                <>
                  <span>{playlist.number}</span>
                  <i />
                  <b>SHOWCASE</b>
                </>
              )}
            </div>
          );

          return (
            <article className="playlist-card" key={playlist.title}>
              {playlist.spotifyUrl ? (
                <a
                  className="playlist-artwork-link"
                  href={playlist.spotifyUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${playlist.title} on Spotify`}
                >
                  {artwork}
                </a>
              ) : (
                artwork
              )}
              <p className="meta">FEATURED PLAYLIST {playlist.number}</p>
              <h2>{playlist.title}</h2>
              <p>{playlist.description}</p>
              <p className="playlist-genres">{playlist.genres}</p>
            </article>
          );
        })}
      </section>
    </div>
  );
}
