import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { GenreReviewManager } from "../../../components/genre-review-manager";
import { getGenreReviewDataset } from "../../../lib/genre-editorial-store";
import { isLocalGenreAdminRequest } from "../../../lib/local-admin-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Local genre review",
  robots: { index: false, follow: false },
};

export default async function GenreReviewPage() {
  const requestHeaders = await headers();
  if (!isLocalGenreAdminRequest(requestHeaders)) notFound();
  const dataset = await getGenreReviewDataset();

  return (
    <div className="genre-admin-page">
      <header className="genre-admin-page-header page-shell">
        <h1>Artist genre review</h1>
        <p>
          Review evidence-backed Showcase genre suggestions. Sources remain private, and only strict
          independently corroborated HIGH suggestions are eligible for bulk confirmation.
        </p>
      </header>
      <GenreReviewManager initialDataset={dataset} />
    </div>
  );
}
