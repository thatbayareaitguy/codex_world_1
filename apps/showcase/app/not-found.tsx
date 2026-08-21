import Link from "next/link";

export default function NotFound() {
  return (
    <section className="not-found page-shell">
      <p className="kicker">404 / OFF THE MAP</p>
      <h1>
        This signal
        <br />
        <em>faded out.</em>
      </h1>
      <p>The page you requested is not in the Showcase catalog.</p>
      <div>
        <Link className="button button-primary" href="/">
          Return home
        </Link>
        <Link className="text-link" href="/releases">
          Browse releases
        </Link>
      </div>
    </section>
  );
}
