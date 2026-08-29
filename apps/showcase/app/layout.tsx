import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Menu, Search } from "lucide-react";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "127.0.0.1:3200";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("127.0.0.1") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description =
    "Discover new electronic music releases and the artists shaping what comes next.";

  return {
    metadataBase: new URL(origin),
    title: { default: "Showcase | Electronic music, selected", template: "%s | Showcase" },
    description,
    openGraph: {
      title: "Showcase | Electronic music, selected",
      description,
      images: [`${origin}/showcase-logo-v1.png`],
    },
    twitter: {
      card: "summary_large_image",
      title: "Showcase | Electronic music, selected",
      description,
      images: [`${origin}/showcase-logo-v1.png`],
    },
  };
}

const navigation = [
  { href: "/releases", label: "Releases" },
  { href: "/artists", label: "Artists" },
  { href: "/playlists", label: "Featured Playlists" },
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact Us" },
];

function BrandLockup({ compact = false }: Readonly<{ compact?: boolean }>) {
  return (
    <span className={compact ? "brand-lockup brand-lockup-compact" : "brand-lockup"}>
      <span className="brand-icon-crop" aria-hidden="true">
        <Image src="/showcase-logo-v1.png" alt="" width={1536} height={1024} />
      </span>
      <span className="brand-word">SHOWCASE</span>
    </span>
  );
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <header className="site-header">
          <Link className="wordmark" href="/" aria-label="Showcase home">
            <BrandLockup />
          </Link>
          <nav className="desktop-nav" aria-label="Main navigation">
            {navigation.map((item) => (
              <Link href={item.href} key={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
          <Link
            className="icon-button search-button"
            href="/releases#catalog"
            aria-label="Browse and filter releases"
          >
            <Search aria-hidden="true" size={18} />
          </Link>
          <details className="mobile-menu">
            <summary aria-label="Open navigation">
              <Menu aria-hidden="true" size={20} />
            </summary>
            <nav aria-label="Mobile navigation">
              {navigation.map((item) => (
                <Link href={item.href} key={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </details>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <Link className="wordmark wordmark-small" href="/" aria-label="Showcase home">
            <BrandLockup compact />
          </Link>
          <p>Electronic music, selected.</p>
          <p className="footer-note">
            Independent discovery. Provider links open on their services.
          </p>
        </footer>
      </body>
    </html>
  );
}
