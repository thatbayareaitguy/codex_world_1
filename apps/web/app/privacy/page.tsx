export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <a href="/#settings">Back to settings</a>
      <h1>Privacy</h1>
      <p>TS New Music Radar is a personal, single-user application.</p>
      <h2>Stored data</h2>
      <p>
        The local database stores the canonical watchlist, source evidence, scan history, provider
        mappings, feed decisions, playlist export records, and encrypted Spotify tokens.
      </p>
      <h2>Provider boundaries</h2>
      <p>
        Spotify credentials remain on the server. MusicBrainz requests contain the configured
        contact email in the user agent. Manual SoundCloud links are disabled by default and never
        cause a SoundCloud page or API request.
      </p>
      <h2>Deletion</h2>
      <p>
        Disconnecting Spotify deletes stored tokens. Deleting local application data requires an
        explicit database reset because this milestone has no hosted account service.
      </p>
    </main>
  );
}
