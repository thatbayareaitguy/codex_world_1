import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About Us",
  description: "Learn about Showcase and its approach to electronic music discovery.",
};

const aboutSections = [
  { number: "01", title: "Our mission" },
  { number: "02", title: "How we select" },
  { number: "03", title: "Who we are" },
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
        <p>
          This page is reserved for the Showcase story, editorial approach, and team. The full About
          Us content will be added later.
        </p>
      </header>

      <section className="about-placeholder-grid" aria-label="About Showcase sections">
        {aboutSections.map((section) => (
          <article key={section.title}>
            <span>{section.number}</span>
            <h2>{section.title}</h2>
            <p>Details coming soon.</p>
          </article>
        ))}
      </section>
    </div>
  );
}
