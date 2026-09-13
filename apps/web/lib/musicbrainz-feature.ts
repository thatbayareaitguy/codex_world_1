import { loadProviderConfiguration } from "@radar/providers";
import { NextResponse } from "next/server";

export const musicBrainzDisabledMessage =
  "MusicBrainz is disabled. Set MUSICBRAINZ_ENABLED=true only for separately validated advanced use.";

export function musicBrainzDisabledResponse(): NextResponse | null {
  return loadProviderConfiguration().musicbrainz.enabled
    ? null
    : NextResponse.json({ error: musicBrainzDisabledMessage }, { status: 403 });
}
