# Provider Capabilities and Cost Gate

## MusicBrainz workflow verification (2026-07-21)

- Authentication: no OAuth or paid account. A descriptive User-Agent with application name,
  version, and private operator contact is required.
- Discovery: canonical artist mapping, release groups, releases, recordings, ISRCs when present,
  and track-level appearances through the official JSON web service.
- Rate limit: the application uses one database-backed global queue with no more than one request
  start per second and bounded retry for HTTP 503.
- Evidence: MusicBrainz recording links are stored as community metadata evidence. They are not
  represented as official artist announcements.
- Playlist writing and playback: unsupported.
- Completeness: community data may be missing, delayed, partially dated, or inconsistently credited.
  A no-result scan is not proof that no release exists.
- Official documentation: https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting,
  https://musicbrainz.org/doc/MusicBrainz_API, and
  https://musicbrainz.org/doc/MusicBrainz_API/Search (verified 2026-07-21). The official API
  reference confirms `track_artist` release browsing for appearances and supports release media,
  recordings, release groups, artist credits, and ISRC includes.

The general rule permits no paid prerequisite other than the owner's existing Spotify Premium
subscription. The narrow branch-only exception in `AGENTS.md` permits Apple Developer Program
access for the isolated catalog experiment on `codex/apple-music-discovery`. It does not change
policy on any other branch or authorize another paid provider.

## Apple Music API catalog verification (2026-07-30)

- Scope: public catalog reads from exactly `https://api.music.apple.com`. The experimental client
  supports catalog artist search, one or up to 25 artists by ID, six documented artist views,
  albums, the artist albums relationship, album-track relationships, songs by ID, and bounded
  catalog search for album and song results.
- Authentication: server-generated developer tokens use ES256 with a configured Team ID, Key ID,
  and external P-256 private key. Tokens are cached only in process memory and regenerated before
  expiration. Music User Tokens are not implemented.
- Request safety: the provider defaults off. A PostgreSQL-backed Apple-only gate enforces
  concurrency one, at least 1,100 milliseconds between request starts, request and runtime budgets,
  bounded response bodies, timeouts, normalized cache reuse, safe telemetry, and persisted 429
  cooldowns. This interval is an internal conservative control, not a claim of a published Apple
  numeric rate allowance.
- Pagination: only relative allowlisted catalog paths may be followed. Every `next` path is checked,
  repeated pages are rejected, and release sorting is local.
- Recent experiment: the separate recent scanner fetches fresh first pages for two shallow
  primary-release arms and a bidirectional-remix arm. It never follows pagination. Catalog search
  requests albums and songs together and search rank alone never confirms a candidate.
- Exclusions: no user library, playback, playlists, Apple Music Feed, artwork or preview download,
  production scanner integration, or live request is part of this implementation checkpoint.
- Official documentation:
  [Generating Developer Tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens),
  [Get Multiple Catalog Artists](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-artists),
  [Fetch an Artist View](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-4kow5),
  [Fetch an Artist Relationship](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5akdm),
  [Search](https://developer.apple.com/documentation/applemusicapi/search),
  [Fetching Resources by Page](https://developer.apple.com/documentation/applemusicapi/fetching_resources_by_page),
  [Get a Catalog Album](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-album),
  [Get Multiple Catalog Songs](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-songs-by-id),
  and
  [Handling Requests and Responses](https://developer.apple.com/documentation/applemusicapi/handling-requests-and-responses).

## iTunes Search API pilot verification (2026-07-28)

- Scope: the archived, unauthenticated iTunes Search API at only
  `https://itunes.apple.com/search` and `https://itunes.apple.com/lookup`. This is not the
  authenticated Apple Music API at `api.music.apple.com`, MusicKit, or Apple Music Feed.
- Account, payment, and authentication: the archived Search API documentation describes
  fully-qualified public search and ID lookup URLs and does not document an account, developer
  credential, subscription, or payment requirement. Production suitability and continued
  availability remain unproven because the documentation is archived.
- Functionality: music-artist search supports `musicArtist`; lookup supports artist albums and
  recent songs; limits are documented from 1 through 200. Server-side recent sorting is documented
  for song lookup examples, not as a completeness guarantee.
- Rate allowance: approximately 20 calls per minute, subject to change. The isolated pilot uses
  concurrency one, a durable global gate, at least 3.2 seconds between request starts, caching, and
  at most 200 requests. It does not probe for a higher limit.
- Batching: Apple documents multiple AMG artist IDs, but does not establish that ordinary iTunes
  artist IDs are complete or safe when batched. The pilot treats ordinary-ID batching as an
  experiment and never uses it for recall unless it equals individual results.
- Promotional content: Apple's archived terms restrict previews and artwork to promotion of their
  subject with store linkage and other conditions. The pilot does not download, cache, render,
  proxy, transform, or play artwork or previews. It persists only normalized metadata and validated
  Apple store links.
- Policy uncertainty: the archived documentation does not provide a current service-level
  commitment or explicit approval for this release-discovery use. This repository makes no claim
  of Apple approval.
- Official documentation:
  https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/,
  https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html,
  https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html,
  and
  https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/UnderstandingSearchResults.html.

| Provider                                                     | Decision                            | Discovery                                                                           | Account import                                          | Playlist writing                                                                           | Playback | Upcoming                                           | Required account and payment                                                             | Authentication                                        | Limits and policy                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| MockProvider                                                 | Active                              | Synthetic typed releases                                                            | Synthetic only                                          | Synthetic planning                                                                         | None     | Synthetic                                          | None                                                                                     | None                                                  | Fixtures must never be represented as live data                                                                                          |
| Spotify                                                      | Active                              | Confirmed artist albums, album tracks, exact track resolution, credited appearances | Followed artists with preview and explicit confirmation | Disabled by default; prepared for add-only writes to one configured owned private playlist | None     | Catalog dates only                                 | Development Mode app owner must have Premium; no separate developer fee documented       | Server Authorization Code with PKCE and client secret | Playlist authorization is account-scoped; application additionally enforces one target ID; broad cross-service policy remains unresolved |
| MusicBrainz                                                  | Active                              | Artist search, release groups, artist releases, and `track_artist` appearances      | None                                                    | None                                                                                       | None     | Community release dates with precision and history | Public non-commercial reads require no paid account                                      | No key; meaningful contact User-Agent                 | Average one request per second per IP; metadata can be incomplete                                                                        |
| Reddit                                                       | Implemented, approval-gated         | Configured subreddit evidence and local deterministic parsing                       | None                                                    | None                                                                                       | None     | User-posted date claims remain evidence only       | Reddit decides approved free or paid access; this project has no approval recorded       | Approved OAuth app credentials and descriptive UA     | Explicit approval required; eligible free clients are documented at 100 QPM averaged over ten minutes                                    |
| SoundCloud                                                   | Manual feature only, off by default | No automated request                                                                | None                                                    | None                                                                                       | None     | None                                               | No account for outbound links; API registration requires paid Artist Pro and is excluded | None                                                  | User-directed HTTPS links only, no metadata fetch or availability claim                                                                  |
| iTunes Search (`apple_music` family, `itunes_search` source) | Isolated pilot only                 | Artist mapping, album lookup, and recent-song lookup                                | None                                                    | None                                                                                       | None     | Catalog dates only                                 | No account or payment documented for the archived public endpoints                       | None                                                  | Archived API; approximately 20 calls per minute; 200-result cap; no proven paging; restrictive promotional-content terms                 |
| YouTube                                                      | Deferred                            | None                                                                                | None                                                    | None                                                                                       | None     | None                                               | Not evaluated for this milestone                                                         | None                                                  | Spotify coexistence policy unresolved                                                                                                    |
| Apple Music authenticated API                                | Branch-only isolated implementation | Public catalog artist, view, album, and song metadata                               | None                                                    | None                                                                                       | None     | Catalog dates only                                 | Apple Developer Program membership under the explicit branch exception                   | Server developer token                                | Disabled by default; credential-free tested; no live access, production integration, or Music User Token support                         |
| TIDAL                                                        | Deferred                            | None                                                                                | None                                                    | None                                                                                       | None     | None                                               | Free access may exist but compatibility is not established                               | None                                                  | No adapter until a new official review                                                                                                   |

## Spotify Verification

- [February 2026 Development Mode migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide): Premium owner, one Client ID, five Development Mode users, removed New Releases, current playlist paths, smaller search and artist-album limits.
- [February 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026) and [March 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/march-2026): current response-field changes and restored `external_ids`.
- [May 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/may-2026) and [current profile](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile): stable `account_id`.
- [Redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri): 127.0.0.1 loopback is allowed; localhost is not.
- [Authorization Code](https://developer.spotify.com/documentation/web-api/tutorials/code-flow) and [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow): server token exchange and S256 challenge.
- [Followed artists](https://developer.spotify.com/documentation/web-api/reference/get-followed): `user-follow-read`, cursor pagination, maximum 50.
- [Artist albums](https://developer.spotify.com/documentation/web-api/reference/get-an-artists-albums): album, single, appears_on, and compilation groups, current maximum 10.
- [Get Album](https://developer.spotify.com/documentation/web-api/reference/get-an-album): the official album response includes cover-art URLs and dimensions; Spotify documents the images in widest-first order.
- [Get Album Tracks](https://developer.spotify.com/documentation/web-api/reference/get-an-albums-tracks): offset pagination supports an explicit limit from 1 through 50. The production default remains 50; bounded live validation may explicitly use 10 without changing normal behavior.
- [Spotify design guidelines](https://developer.spotify.com/documentation/design): Spotify visual content must remain in its original form and should link back to Spotify. The feed uses the original aspect ratio, no crop, overlay, download, proxy, or transformation, and a direct album link.
- [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits): HTTP 429 responses use integer-second `Retry-After`; the provider-directed wait remains authoritative.
- [API calls and errors](https://developer.spotify.com/documentation/web-api/concepts/api-calls): the structured error object may contain an optional `reason`; the documented quota reason is `QUOTA_EXCEEDED`.
- [July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates): Development Mode quota exhaustion now returns the structured `QUOTA_EXCEEDED` reason.
- [Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes): `playlist-read-private` permits private playlist reads. `playlist-modify-private` grants account-level private-playlist mutation capabilities including creation, additions, removal, replacement, reordering, detail changes, cover upload, follow, and unfollow. Spotify does not offer a playlist-specific write scope.
- [Get playlist](https://developer.spotify.com/documentation/web-api/reference/get-playlist), [read items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items), and [add items](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist): current playlist paths use `/items`; additions accept at most 100 item URIs per request.
- [Playlist concepts](https://developer.spotify.com/documentation/web-api/concepts/playlists): playlist authorization is granted through user scopes, and public/private reflects profile visibility rather than a per-playlist OAuth permission boundary.
- [Spotify Developer Policy](https://developer.spotify.com/policy): broad prohibition on products integrated with streams or content from another service.

Developer credentials require a Spotify developer account but no separate fee is documented. A paid Premium consumer account is required for the Development Mode app owner under the current rules. Initial authorization requests only `user-follow-read` and `playlist-read-private`. Playlist writes default off. Future add-only support requires `playlist-modify-private`, `SPOTIFY_PLAYLIST_WRITES_ENABLED=true`, and one valid `SPOTIFY_ALLOWED_PLAYLIST_ID`. The server and provider client both reject every other target and verify that the configured playlist is owned, private, and non-collaborative. The application never creates, renames, changes visibility, uploads artwork, follows, unfollows, removes, replaces, or reorders. This does not establish conclusive policy approval for the whole product.

Spotify traffic is serialized through one database-backed client-ID gate with one concurrent request
and a production minimum of ten seconds between request starts. A 429 blocks every Spotify path until
the persisted cooldown expires. The response body is read through a 4 KB bounded parser that inspects
only `error.reason`. Exact `QUOTA_EXCEEDED` is stored as `quota_exceeded`; a missing or unusable reason
is `unspecified_429`; a bounded unknown token is `unknown_reason`; and historical events without
stored evidence remain `legacy_unknown`. Raw bodies and arbitrary provider messages are not stored or
logged, and classification does not change retry, pacing, or cooldown behavior. These details and
official sources were verified 2026-07-27.

Daily artist-album scans check page one for speed but retain a partial state and any deeper
reconciliation cursor. Initial and periodic reconciliation resume in bounded page units until
Spotify returns no next cursor. The endpoint documentation does not guarantee newest-first ordering,
so old results never justify abandoning later pages. Provider catalog summaries prevent repeated
detail fetches without creating canonical feed records for out-of-window releases. Completeness
remains limited to the catalog Spotify exposes for the connected user's region. Full album responses
already retrieved for new releases supply optional artwork metadata, so artwork adds no discovery
request. Only validated HTTPS `i.scdn.co/image/...` URLs are retained, and the artwork link must be
the matching `open.spotify.com/album/...` URL. See
[Spotify Development Mode Scanning](spotify-development-mode-scanning.md).

## MusicBrainz Verification

- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API): JSON search, lookup, and browse; release browse by `artist` and `track_artist`; browse limit up to 100 and track-count offset caveat.
- [Search](https://musicbrainz.org/doc/MusicBrainz_API/Search): Lucene artist search fields.
- [Rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting): average one request per second and a meaningful contactable User-Agent.
- [Products](https://musicbrainz.org/doc/Products): free non-commercial Web Service use.

No paid account, developer credential, consumer subscription, or OAuth is required for public reads. This milestone is read-only and submits no edits, ratings, tags, or identifiers.

## Reddit Verification

- [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy): explicit approval is mandatory before Data API access and Reddit determines free or paid eligibility.
- [Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki): approved eligible free clients are limited to 100 queries per minute per OAuth client ID averaged over ten minutes, require OAuth and a descriptive User-Agent, and must remove deleted content within the documented window.
- [Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data): official access routes and application process.
- [Official API reference](https://www.reddit.com/dev/api/): `/r/{subreddit}/new`, `/r/{subreddit}/search`, `/api/info`, listing cursors, and limits.
- [Archived OAuth technical guide](https://github.com/reddit-archive/reddit/wiki/OAuth2): application-only client credentials mechanics, subject to the current approval response.

No consumer subscription is required by the cited documentation, but free access for this use case is not guaranteed. The adapter therefore remains disabled. If Reddit requires payment or incompatible terms, it will not be enabled. This repository does not claim approval.

## Policy Uncertainty

Spotify's phrase about integration with streams or content from another service remains broad. This application has no playback, preview, embed, audio handling, cross-provider artwork, or transfer of Spotify metadata to MusicBrainz. Spotify cover art appears only when Spotify is evidence for the release, remains Spotify-namespaced, and links directly back to that Spotify album. MusicBrainz starts from user-approved canonical artists and confirmed mappings, not raw Spotify responses. Plain outbound SoundCloud links are disabled by default. These controls reduce risk but do not prove Spotify has approved the architecture.
