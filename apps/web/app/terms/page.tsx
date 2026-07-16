export default function TermsPage() {
  return (
    <main className="legal-page">
      <a href="/#settings">Back to settings</a>
      <h1>Terms and provider notice</h1>
      <p>
        This application provides a best-effort discovery feed. It does not guarantee catalog
        completeness, release timing, regional availability, or uninterrupted provider access.
      </p>
      <h2>Spotify</h2>
      <p>
        Spotify is used only after user authorization for followed-artist import, catalog matching,
        and a private Spotify playlist. The application does not play audio or combine Spotify
        content with another streaming service.
      </p>
      <h2>MusicBrainz</h2>
      <p>
        MusicBrainz metadata may be incomplete or community-maintained. Ambiguous identity matches
        require review before they become confirmed mappings.
      </p>
    </main>
  );
}
