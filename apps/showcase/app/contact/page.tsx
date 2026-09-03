import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Contact Showcase about music, artist information, playlists, or general questions.",
};

export default function ContactPage() {
  return (
    <div className="listing-page page-shell editorial-page">
      <header className="listing-hero editorial-hero contact-hero">
        <h1>
          Send us
          <br />
          <em>a signal.</em>
        </h1>
        <p>
          Reach out about music submissions, artist information, playlist questions, corrections,
          partnerships, or anything else related to Showcase.
          <a className="contact-email-link" href="mailto:showcasedmhq@gmail.com">
            showcasedmhq@gmail.com
          </a>
        </p>
      </header>
    </div>
  );
}
