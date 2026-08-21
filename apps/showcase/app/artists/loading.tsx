export default function ArtistsLoading() {
  return (
    <div className="loading-page page-shell" aria-live="polite" aria-label="Loading artists">
      <div className="loading-line loading-title" />
      <div className="loading-grid">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="loading-card loading-artist" key={index} />
        ))}
      </div>
    </div>
  );
}
