import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { saveArtistGenreReviewSchema } from "../../../../lib/genre-editorial-contract";
import {
  getGenreReviewDataset,
  saveArtistGenreReview,
} from "../../../../lib/genre-editorial-store";
import {
  isLocalGenreAdminMutation,
  isLocalGenreAdminRequest,
} from "../../../../lib/local-admin-access";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestHeaders = await headers();
  if (!isLocalGenreAdminRequest(requestHeaders)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(await getGenreReviewDataset(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const requestHeaders = await headers();
  if (!isLocalGenreAdminMutation(requestHeaders)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const result = saveArtistGenreReviewSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid genre assignment" }, { status: 400 });
  }
  try {
    const dataset = await saveArtistGenreReview(result.data);
    return NextResponse.json(dataset, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The genre assignment failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
