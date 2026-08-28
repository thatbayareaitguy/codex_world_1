import type { Metadata } from "next";

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
        <p className="kicker">
          <span /> OUR STORY
        </p>
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
    </div>
  );
}
