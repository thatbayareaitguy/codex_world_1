import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { expect, it } from "vitest";

const host = process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const adminUrl = host.replace(/\/[^/]+$/, "/postgres");
const migrationDirectory = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));

it("upgrades the eleven-migration schema and repairs a provenance-proven release", async () => {
  const databaseName = `radar_upgrade_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`create database "${databaseName}"`);
  const databaseUrl = host.replace(/\/[^/]+$/, `/${databaseName}`);
  const client = postgres(databaseUrl, { max: 1 });
  try {
    for (let index = 0; index <= 10; index += 1) {
      await applyMigration(client, index);
    }
    await client.unsafe(`
      insert into users (id, email, display_name)
      values (
        '00000000-0000-4000-8000-000000000001',
        'synthetic@example.test',
        'Synthetic owner'
      );
      insert into releases (
        id, title, normalized_title, release_type, release_date, release_date_precision
      ) values (
        '00000000-0000-4000-8000-000000000010',
        'BLOODBATH AND BEYOND',
        'bloodbath and beyond',
        'album',
        '2026-06-01',
        'day'
      );
      insert into tracks (id, release_id, title, normalized_title, disc_number, track_number)
      values (
        '00000000-0000-4000-8000-000000000020',
        '00000000-0000-4000-8000-000000000010',
        'SPEAKERBOX',
        'speakerbox',
        1,
        1
      );
      insert into release_external_ids (
        release_id, provider, external_id, provider_url, provider_fields
      ) values (
        '00000000-0000-4000-8000-000000000010',
        'spotify',
        'spotify-speakerbox-release',
        'https://open.spotify.com/album/spotify-speakerbox-release',
        '{}'
      ), (
        '00000000-0000-4000-8000-000000000010',
        'spotify',
        'spotify-original-album',
        'https://open.spotify.com/album/spotify-original-album',
        '{}'
      ), (
        '00000000-0000-4000-8000-000000000010',
        'spotify',
        'spotify-deluxe-album',
        'https://open.spotify.com/album/spotify-deluxe-album',
        '{}'
      ), (
        '00000000-0000-4000-8000-000000000010',
        'spotify',
        'spotify-compilation',
        'https://open.spotify.com/album/spotify-compilation',
        '{}'
      ), (
        '00000000-0000-4000-8000-000000000010',
        'spotify',
        'spotify-remix-release',
        'https://open.spotify.com/album/spotify-remix-release',
        '{}'
      );
      insert into release_candidates (
        id, provider, provider_release_id, provider_track_id, artist_external_id,
        title, normalized_title, release_date, raw_payload, payload_hash, match_status,
        matched_track_id, match_rule, match_confidence, match_reasons,
        matching_algorithm_version, first_seen_at
      ) values (
        '00000000-0000-4000-8000-000000000030',
        'spotify',
        'spotify-speakerbox-release',
        'spotify-speakerbox-track',
        'spotify-artist',
        'SPEAKERBOX',
        'speakerbox',
        '2026-07-01',
        '{
          "provider":"spotify",
          "externalReleaseId":"spotify-speakerbox-release",
          "externalTrackId":"spotify-speakerbox-track",
          "releaseTitle":"SPEAKERBOX",
          "releaseType":"single",
          "releaseDatePrecision":"day",
          "discNumber":1,
          "trackNumber":1,
          "credits":[{"name":"Synthetic Artist","role":"primary"}]
        }'::jsonb,
        'synthetic-payload-hash',
        'matched',
        '00000000-0000-4000-8000-000000000020',
        'exact_provider_id',
        1,
        array['Provider track identifier is identical'],
        'v2-real-providers',
        '2026-07-21T20:00:00Z'
      ), (
        '00000000-0000-4000-8000-000000000031',
        'spotify',
        'spotify-no-bad-parts-release',
        'spotify-no-bad-parts-track',
        'spotify-artist',
        'NO BAD PARTS',
        'no bad parts',
        '2026-06-26',
        '{
          "provider":"spotify",
          "externalReleaseId":"spotify-no-bad-parts-release",
          "externalTrackId":"spotify-no-bad-parts-track",
          "releaseTitle":"NO BAD PARTS",
          "releaseType":"feature",
          "releaseDatePrecision":"day",
          "discNumber":1,
          "trackNumber":1,
          "credits":[{"name":"Synthetic Artist","role":"primary"}]
        }'::jsonb,
        'synthetic-manual-payload-hash',
        'matched',
        '00000000-0000-4000-8000-000000000020',
        'manual_confirmation',
        1,
        array['Confirmed manually'],
        'manual-v1',
        '2026-07-21T20:02:00Z'
      ), (
        '00000000-0000-4000-8000-000000000032',
        'spotify', 'spotify-original-album', 'spotify-original-track', 'spotify-artist',
        'SPEAKERBOX', 'speakerbox', '2026-06-01',
        '{"provider":"spotify","releaseTitle":"BLOODBATH AND BEYOND","releaseType":"album","releaseDatePrecision":"day","discNumber":1,"trackNumber":1,"credits":[]}'::jsonb,
        'synthetic-original-hash', 'matched', '00000000-0000-4000-8000-000000000020',
        'exact_isrc', 1, array['Exact recording provenance'], 'v2-real-providers',
        '2026-07-21T20:03:00Z'
      ), (
        '00000000-0000-4000-8000-000000000033',
        'spotify', 'spotify-deluxe-album', 'spotify-deluxe-track', 'spotify-artist',
        'SPEAKERBOX', 'speakerbox', '2026-06-15',
        '{"provider":"spotify","releaseTitle":"BLOODBATH AND BEYOND (Deluxe Edition)","releaseType":"album","releaseDatePrecision":"day","discNumber":2,"trackNumber":3,"credits":[]}'::jsonb,
        'synthetic-deluxe-hash', 'matched', '00000000-0000-4000-8000-000000000020',
        'exact_isrc', 1, array['Exact recording provenance'], 'v2-real-providers',
        '2026-07-21T20:04:00Z'
      ), (
        '00000000-0000-4000-8000-000000000034',
        'spotify', 'spotify-compilation', 'spotify-compilation-track', 'spotify-artist',
        'SPEAKERBOX', 'speakerbox', '2026-06-20',
        '{"provider":"spotify","releaseTitle":"Synthetic Compilation","releaseType":"compilation","releaseDatePrecision":"day","discNumber":1,"trackNumber":8,"credits":[]}'::jsonb,
        'synthetic-compilation-hash', 'matched', '00000000-0000-4000-8000-000000000020',
        'exact_isrc', 1, array['Exact recording provenance'], 'v2-real-providers',
        '2026-07-21T20:05:00Z'
      ), (
        '00000000-0000-4000-8000-000000000035',
        'spotify', 'spotify-remix-release', 'spotify-remix-track', 'spotify-artist',
        'SPEAKERBOX', 'speakerbox', '2026-06-25',
        '{"provider":"spotify","releaseTitle":"SPEAKERBOX (Remixes)","releaseType":"remix","releaseDatePrecision":"day","discNumber":1,"trackNumber":2,"credits":[]}'::jsonb,
        'synthetic-remix-hash', 'matched', '00000000-0000-4000-8000-000000000020',
        'exact_isrc', 1, array['Exact recording provenance'], 'v2-real-providers',
        '2026-07-21T20:06:00Z'
      );
      insert into source_evidence (
        candidate_id, provider, evidence_type, external_id, source_url, payload_hash
      ) values (
        '00000000-0000-4000-8000-000000000030',
        'spotify',
        'spotify_track',
        'spotify-speakerbox-track',
        'https://open.spotify.com/track/spotify-speakerbox-track',
        'synthetic-payload-hash'
      );
      insert into feed_items (
        id, user_id, candidate_id, release_id, track_id, state, dedupe_key,
        first_seen_at, saved_at
      ) values (
        '00000000-0000-4000-8000-000000000040',
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000030',
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000020',
        'saved',
        'spotify:spotify-speakerbox-release:spotify-speakerbox-track',
        '2026-07-21T20:00:00Z',
        '2026-07-21T20:01:00Z'
      );
    `);

    await applyMigration(client, 11);

    const [mapping] = await client<
      Array<{ release_id: string; title: string }>
    >`select external.release_id, release.title
      from release_external_ids external
      join releases release on release.id = external.release_id
      where external.provider = 'spotify'
        and external.external_id = 'spotify-speakerbox-release'`;
    expect(mapping).toMatchObject({ title: "SPEAKERBOX" });
    expect(mapping?.release_id).not.toBe("00000000-0000-4000-8000-000000000010");
    const [appearance] = await client<
      Array<{ release_id: string; track_id: string }>
    >`select appearance.release_id, appearance.track_id
      from release_track_appearances appearance
      join release_track_appearance_sources source on source.appearance_id = appearance.id
      where source.candidate_id = '00000000-0000-4000-8000-000000000030'`;
    expect(appearance).toEqual({
      release_id: mapping!.release_id,
      track_id: "00000000-0000-4000-8000-000000000020",
    });
    const [feed] = await client<
      Array<{
        appearance_id: string | null;
        release_id: string;
        saved_at: Date | null;
        state: string;
      }>
    >`select appearance_id, release_id, saved_at, state
      from feed_items where id = '00000000-0000-4000-8000-000000000040'`;
    expect(typeof feed?.appearance_id).toBe("string");
    expect(feed?.release_id).toBe(mapping!.release_id);
    expect(feed?.saved_at).toBeInstanceOf(Date);
    expect(feed?.state).toBe("saved");
    expect(
      await client`select id from source_evidence
        where candidate_id = '00000000-0000-4000-8000-000000000030'`,
    ).toHaveLength(1);
    const [manualMapping] = await client<
      Array<{ release_id: string; title: string }>
    >`select external.release_id, release.title
      from release_external_ids external
      join releases release on release.id = external.release_id
      where external.provider = 'spotify'
        and external.external_id = 'spotify-no-bad-parts-release'`;
    expect(manualMapping).toMatchObject({ title: "NO BAD PARTS" });
    expect(
      await client`select source.id
        from release_track_appearance_sources source
        where source.candidate_id = '00000000-0000-4000-8000-000000000031'`,
    ).toHaveLength(1);
    expect(
      await client`select feed.id
        from feed_items feed
        where feed.candidate_id = '00000000-0000-4000-8000-000000000031'
          and feed.release_id = ${manualMapping!.release_id}`,
    ).toHaveLength(1);
    const repairedAppearances = await client<
      Array<{ disc_number: number; release_type: string; title: string; track_number: number }>
    >`select appearance.disc_number, appearance.track_number, release.release_type, release.title
      from release_track_appearances appearance
      join releases release on release.id = appearance.release_id
      where appearance.track_id = '00000000-0000-4000-8000-000000000020'
      order by release.title, appearance.disc_number, appearance.track_number`;
    expect(repairedAppearances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ release_type: "single", title: "SPEAKERBOX" }),
        expect.objectContaining({ release_type: "album", title: "BLOODBATH AND BEYOND" }),
        expect.objectContaining({
          disc_number: 2,
          release_type: "album",
          title: "BLOODBATH AND BEYOND (Deluxe Edition)",
          track_number: 3,
        }),
        expect.objectContaining({
          release_type: "compilation",
          title: "Synthetic Compilation",
        }),
        expect.objectContaining({ release_type: "remix", title: "SPEAKERBOX (Remixes)" }),
      ]),
    );
  } finally {
    await client.end();
    await admin.unsafe(`drop database if exists "${databaseName}"`);
    await admin.end();
  }
});

async function applyMigration(client: postgres.Sql, index: number): Promise<void> {
  const prefix = String(index).padStart(4, "0");
  const files = [
    "0000_vengeful_dreadnoughts.sql",
    "0001_square_storm.sql",
    "0002_soft_tiger_shark.sql",
    "0003_mixed_mephistopheles.sql",
    "0004_hesitant_nitro.sql",
    "0005_safe_gideon.sql",
    "0006_amusing_power_pack.sql",
    "0007_musicbrainz_workflow.sql",
    "0008_groovy_wolfsbane.sql",
    "0009_first_white_queen.sql",
    "0010_chubby_talkback.sql",
    "0011_gigantic_power_man.sql",
  ];
  const file = files.find((name) => name.startsWith(prefix));
  if (!file) throw new Error(`Migration ${prefix} was not found`);
  const sql = await readFile(`${migrationDirectory}${file}`, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await client.unsafe(trimmed);
  }
}
