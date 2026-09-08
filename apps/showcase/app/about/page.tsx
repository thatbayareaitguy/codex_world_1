import type { Metadata } from "next";
import { ProviderLinks } from "../../components/provider-links";

export const metadata: Metadata = {
  title: "About Us",
  description: "Learn about Showcase and its approach to electronic music discovery.",
};

const aboutSections = [
  {
    number: "01",
    title: "Our mission",
    body: '"Showcase" new music, artists, playlists, and happenings in the EDM world.',
  },
  {
    number: "02",
    title: "How we select",
    body: "Curated playlists, songs, and feeds, based on what we think is cool.",
  },
  {
    number: "03",
    title: "Who we are",
    body: "Just some wonky weird EDM fanatics. Whether you're like us, just trying to find some new music for your AI company's next All Hands, or are new to the EDM world, we're glad you're here.",
  },
] as const;

export default function AboutPage() {
  return (
    <div className="listing-page page-shell editorial-page">
      <header className="listing-hero editorial-hero about-hero">
        <h1>
          Built around
          <br />
          <em>discovery.</em>
        </h1>
        <p>A little more about what we do, how we choose it, and the EDM fans behind Showcase.</p>
      </header>

      <section className="about-placeholder-grid" aria-label="About Showcase sections">
        {aboutSections.map((section) => (
          <article key={section.title}>
            <span>{section.number}</span>
            <h2>{section.title}</h2>
            <p>{section.body}</p>
          </article>
        ))}
      </section>

      <section className="founder-note" aria-labelledby="founder-note-title">
        <div className="founder-note-heading">
          <p className="meta">FROM THE FOUNDER</p>
          <h2 id="founder-note-title">Note from the founder</h2>
        </div>
        <div className="founder-note-copy">
          <h3>K!LLAHURTS</h3>
          <p>
            I&apos;m the founder of Showcase, and my goal is to create a space where fans, artists,
            and EDM community members can find new music, discover artists, and keep up with what is
            happening across the EDM world.
          </p>
          <ProviderLinks
            links={{
              appleMusic: "https://music.apple.com/us/artist/k-llahurts/1662425607",
              spotify: "https://open.spotify.com/artist/6wktzPZcAX9ukJEliEwWqT",
            }}
          />
        </div>
      </section>
    </div>
  );
}
