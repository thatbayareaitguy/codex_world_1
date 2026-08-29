import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Contact Showcase about music, artist information, playlists, or general questions.",
};

export default function ContactPage() {
  return (
    <div className="listing-page page-shell editorial-page">
      <header className="listing-hero editorial-hero contact-hero">
        <p className="kicker">
          <span /> OPEN CHANNEL
        </p>
        <h1>
          Send us
          <br />
          <em>a signal.</em>
        </h1>
        <p>
          Reach out about music submissions, artist information, playlist questions, corrections,
          partnerships, or anything else related to Showcase.
        </p>
      </header>

      <section className="contact-grid" aria-label="How to contact Showcase">
        <article className="contact-address-card">
          <span>01</span>
          <p className="kicker">EMAIL SHOWCASE</p>
          <h2>Contact email coming soon.</h2>
          <p>
            A monitored public email address will appear here before launch. Please use the format
            shown alongside it when getting in touch.
          </p>
        </article>

        <article className="contact-template-card">
          <span>02</span>
          <p className="kicker">EMAIL FORMAT</p>
          <h2>Help us route your message.</h2>
          <div className="email-template" aria-label="Suggested email template">
            <p>
              <strong>Subject:</strong> Showcase inquiry: [topic]
            </p>
            <p>Hi Showcase,</p>
            <p>
              <strong>Name or artist name:</strong> [name]
              <br />
              <strong>Reason for reaching out:</strong> [submission, correction, playlist,
              partnership, or general question]
              <br />
              <strong>Relevant links:</strong> [links]
              <br />
              <strong>Message:</strong> [details]
            </p>
            <p>
              Thanks,
              <br />
              [your name]
            </p>
          </div>
        </article>
      </section>
    </div>
  );
}
