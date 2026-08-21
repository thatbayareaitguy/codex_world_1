export default function ReleasesLoading() {
  return (
    <div className="loading-page page-shell" aria-live="polite" aria-label="Loading releases">
      <div className="loading-line loading-title" />
      <div className="loading-grid">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="loading-card" key={index} />
        ))}
      </div>
    </div>
  );
}
