import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CalendarDays, Headphones, Radio } from "lucide-react";
import { ArtistCard } from "../components/artist-card";
import { ReleaseCard } from "../components/release-card";
import { publicCatalog } from "../lib/public-catalog";

export default function HomePage() {
  const weekCutoff = new Date(publicCatalog.generatedAt);
  weekCutoff.setUTCDate(weekCutoff.getUTCDate() - 7);
  const newReleasesThisWeek = publicCatalog.releases.filter(
    (release) =>
      release.status === "released" &&
      release.firstDiscoveredDate >= weekCutoff.toISOString().slice(0, 10),
  );
  const newReleases = newReleasesThisWeek.slice(0, 3);
  const upcomingReleases = publicCatalog.releases
    .filter((release) => release.status === "upcoming")
    .slice(0, 2);
  const featuredArtists = publicCatalog.artists.slice(0, 3);

  return (
    <>
      <section className="hero page-shell">
        <div className="hero-copy">
          <h1>
            Find your next
            <br />
            <em>favorite sound.</em>
          </h1>
          <p className="hero-intro">
            New electronic music, rising artists, and the releases worth knowing, selected in one
            place.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/releases">
              Explore new releases <ArrowRight size={16} />
            </Link>
            <Link className="text-link" href="/artists">
              Browse artists
            </Link>
          </div>
        </div>
        <div className="hero-visual brand-hero">
          <Image
            className="hero-logo-image"
            src="/showcase-logo-v1.png"
            alt="Showcase headphones logo glowing in orange, pink, violet, and blue"
            width={1536}
            height={1024}
            priority
          />
          <div className="release-stamp">
            <span>NEW THIS WEEK</span>
            <strong>{newReleasesThisWeek.length}</strong>
            <small>RELEASES</small>
          </div>
        </div>
      </section>

      <section className="discovery-strip">
        <div>
          <Radio size={17} />
          <span>
            <strong>CURATED DISCOVERY</strong>Fresh electronic releases, without the noise.
          </span>
        </div>
        <div>
          <CalendarDays size={17} />
          <span>
            <strong>LOOK AHEAD</strong>Know what is landing next.
          </span>
        </div>
        <div>
          <Headphones size={17} />
          <span>
            <strong>GO TO THE SOURCE</strong>Listen on your preferred service.
          </span>
        </div>
      </section>

      <section className="section page-shell">
        <div className="section-heading">
          <div>
            <p className="kicker">JUST LANDED</p>
            <h2>New this week</h2>
          </div>
          <Link className="text-link" href="/releases">
            View all releases <ArrowRight size={15} />
          </Link>
        </div>
        <div className="release-grid">
          {newReleases.map((release) => (
            <ReleaseCard key={release.publicId} release={release} />
          ))}
        </div>
      </section>

      <section className="upcoming-home">
        <div className="page-shell upcoming-home-grid">
          <div className="upcoming-home-copy">
            <p className="kicker">ON THE HORIZON</p>
            <h2>
              Hear what is
              <br />
              <em>coming next.</em>
            </h2>
            <p>
              Upcoming releases are organized alongside the current catalog, so the next date on
              your listening calendar is easy to find.
            </p>
            <Link className="button button-primary" href="/releases#catalog">
              See upcoming releases <ArrowRight size={16} />
            </Link>
          </div>
          <div className="upcoming-stack">
            {upcomingReleases.map((release) => (
              <ReleaseCard key={release.publicId} release={release} />
            ))}
          </div>
        </div>
      </section>

      <section className="section page-shell">
        <div className="section-heading">
          <div>
            <p className="kicker">ARTIST INDEX</p>
            <h2>
              Meet the names
              <br />
              moving the scene.
            </h2>
          </div>
          <Link className="text-link" href="/artists">
            Explore all artists <ArrowRight size={15} />
          </Link>
        </div>
        <div className="artist-grid home-artist-grid">
          {featuredArtists.map((artist) => (
            <ArtistCard artist={artist} key={artist.publicId} />
          ))}
        </div>
      </section>
    </>
  );
}
