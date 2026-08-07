# AI Handoff

Updated: 2026-08-06 19:39 PDT (UTC-07:00)

Canonical implementation and operational snapshot. Credentials, tokens, private keys, personal
provider data, authorization headers, and raw provider payloads are excluded.

## Repository State

- Branch: `codex/release-radar-hardening`, tracking the matching GitHub branch.
- Starting commit for this milestone: `936a90c84447a00957e9096c7a21d01f02bd4a6d`.
- Current milestone commit: the commit containing this document.
- Worktree contains this handoff update and the intentionally untracked `outputs/` directory. The
  generated CSV output is excluded from the documentation commit. Ignored `.env`, runtime logs, and
  test artifacts are excluded.
- Milestone: compliant manual Apple artist identity resolution from exact user-supplied URLs.

## Architecture And Database

- TypeScript pnpm monorepo: Next.js web/API, Node scanner CLIs, provider-neutral core,
  Drizzle/PostgreSQL, Zod, Vitest, and Playwright.
- PostgreSQL remains authoritative for canonical records, provider identities, review decisions,
  catalog snapshots, rankings, request gates, cooldowns, OAuth data, and export ledgers.
- Twenty-two forward migrations are applied. Migration 0021 adds
  `apple_identity_candidate_catalogs` and `apple_identity_candidate_rankings`.
- Current Apple identity state: 506 confirmed mappings, consisting of 320 automatic and 186 manual;
  87 identity statuses remain unresolved. Pending review contains 446 candidates across 86 of
  those artists; one unresolved artist currently has no pending candidate row.
- Persisted Apple ranking state: 297 catalog snapshots. Of 505 total ranking rows, 222 rows across 40
  artists still belong to unresolved identities.

## Verified

- The historical iTunes seed artifact has canonical SHA-256
  `0243f3d28d6cb51ec0474da7486f8d73c66fd13398d17601d021c876ee0f8660` but is not sanctioned as
  production identity evidence because its title-overlap ground truth came from Spotify. It is
  retained only as untrusted candidate inventory and never contributes to scores or confirmation.
- Candidate enrichment uses numeric Apple artist IDs only. The live fallback queried Apple's iTunes
  lookup API without names, Spotify IDs, Spotify URLs, ISRCs, UPCs, or Spotify catalog metadata.
- MusicBrainz direct Apple URLs and MusicBrainz-linked Wikidata P2850 values are treated as exact
  independent evidence only after validating the Apple resource. Multiple exact IDs and already
  claimed IDs remain conflicts instead of being forced.
- Apple-only activity, genre, label, release, and confirmed Apple co-credit signals rank candidates
  but cannot automatically confirm them. Soft scores are capped below the exact-evidence threshold.
- Rejection is reversible. Split-profile confirmation requires at least two validated Apple IDs.
- The grouped review UI displays rank, advisory score, artwork, Apple URL, genres, labels, activity,
  collaborators, releases, explanations, and Confirm, Reject/Restore, Split Profile, Not on Apple,
  and Defer actions. Spotify identity evidence is excluded from the Apple review payload.
- Fresh production-build browser QA against PostgreSQL verified enriched and unenriched candidate
  states, accessible actions, reversible rejected candidates, and MusicBrainz-only confirmed
  evidence.

## Live Validation

- Bounded pass: 100 unresolved artists, 150 Apple-family requests, 150 catalogs fetched, zero
  request failures, zero cooldown, and zero Spotify requests.
- Calibration truth set: 25 reconstructable groups and 97 unique candidates. Top-1 accuracy was
  25/25 and top-3 accuracy was 25/25. False confirmations and true-candidate eliminations were both
  zero. This is a small calibration sample, not universal proof.
- Exact-link results: zero unique direct MusicBrainz confirmations, zero Wikidata confirmations, one
  exact-link split-profile conflict, and one Wikidata request.
- Automatic results: zero title-overlap resolutions, zero collaboration-only resolutions, zero
  candidate eliminations, and zero automatic confirmations. The pass reduced review effort through
  ranking and enrichment, not by weakening confirmation safety.
- User-supplied exact URLs for Amplify `254880393`, Anki `1437953776`, Anto `1846210772`, and Arya
  `1563427828` were verified through four gated numeric Apple lookups with zero failures and applied
  transactionally. All four names agreed after normalization and their pending reviews were closed.
- User-supplied exact URLs for Avance `41527586`, BAGG `1552540536`, and BLUPRNT `1524891295`
  were verified through three gated numeric Apple lookups with zero failures and applied
  transactionally. All three names agreed after normalization and their pending reviews were closed.
- User-supplied exact URLs for BLVD. `1464139239`, BRANDON `1493109644`, BRONSON `1506713189`,
  BVRNOUT `1087920245`, Blaize `411174046`, Blossom `147379525`, and Bossfight `1370818923` were
  verified through six gated numeric Apple lookups plus one catalog cache hit, with zero failures,
  and applied transactionally. Their pending reviews were closed.
- User-supplied exact URLs for Brooks `1101797127`, Buku `455303856`, Chime `25272873`, Circadian
  `575770726`, and Code: Pandorum `865392478` were verified through four gated numeric Apple lookups
  plus one catalog cache hit, with zero failures, and applied transactionally. Exact normalized names
  agreed and their pending reviews were closed.
- The user-supplied exact URL for Control Freak `53615786` was verified through one gated numeric
  Apple lookup with zero failures and applied transactionally. The exact normalized name agreed and
  its pending reviews were closed.
- User-supplied exact URLs for Convex `542698006`, Cyclops `198189262`, DJ Snake `125742557`, Dabin
  `489858182`, Daily Bread `1516625785`, Danny Olson `1197861060`, Disciple `1395522107`, Disclosure
  `520848228`, and Doctor P `337725870` were verified through nine gated numeric Apple lookups with
  zero failures and applied transactionally. Exact normalized names agreed and their pending reviews
  were closed. The supplied DJ Snake HTTP URL was normalized to HTTPS before persistence.
- User-supplied exact URLs for Dom Dolla `555348065`, Dropgun `63194057`, Edison Cole `1335080924`,
  FETISH `1528146813`, FREAKY `1642995405`, Fairlane `332465235`, Famous Spear `1048638889`, Far Out
  `1473958133`, and Farrah `44214442` were verified through eight gated numeric Apple lookups plus one
  catalog cache hit, with zero failures, and applied transactionally. Exact normalized names agreed
  and their pending reviews were closed.
- User-supplied exact URLs for Fitch `4274951`, Friction `744244447`, G Jones `526152`, GRiZ
  `980722716`, and Gareth Emery `78422058` were verified through five gated numeric Apple lookups with
  zero failures and applied transactionally. Exact normalized names agreed and their pending reviews
  were closed.
- User-supplied exact URLs for Getter `419185194`, Ghastly `701313804`, God's Warrior `496903551`,
  Gorillowz `1312660633`, Grafix `133390150`, Grey `324853`, Gryffin `953311187`, and HATO
  `1756770269` were verified through eight gated numeric Apple lookups with zero failures and applied
  transactionally. Exact normalized names agreed and their pending reviews were closed.
- User-supplied exact URLs for Heyz `1281037215`, Hubstcy `1275435634`, Hukae `1356608700`, Hybrid
  Minds `493781098`, ILLENIUM `645420096`, INF1N1TE `664871696`, INFEKT `329193923`, INZO
  `1316205596`, IVORY `1277948731`, Ironheart `1578656505`, JOYRYDE `408931289`, Jalaya
  `1331014845`, Jason Ross `129061595`, Jinco `373547544`, and Jon Casey `477268278` were verified
  through 15 gated numeric Apple lookups with zero failures and applied transactionally. Exact
  normalized names agreed and their pending reviews were closed.
- User-supplied exact URLs for Just A Gent `676417641`, K Motionz `581160699`, K-NINE `30837827`,
  KANJI `1705037926`, KLOUD `1351315768`, KRANE `887378519`, and KRAYT `1311012711` were verified
  through seven gated numeric Apple lookups with zero failures and applied transactionally. Exact
  normalized names agreed and their pending reviews were closed.
- User-supplied exact URLs for [BORDERS] `1632668957`, borne `1614258187`, ellis `1171048408`,
  goddard. `1668134503`, graves `1127647270`, hayve `1512447146`, Honey & Badger `605390519`, k?d
  `1141553506`, Kaivon `871892490`, Kanine `1401909308`, Kayzo `661615351`, and Khamsin `374261357`
  were verified through 12 gated numeric Apple lookups with zero failures and applied transactionally.
  Exact normalized names agreed and their pending reviews were closed.
- User-supplied exact URLs for Know Good `1507153145`, Kompany `550429222`, Kotori `1033204051`,
  Krewella `492328395`, Krimer `675724063`, KTRL `527790626`, KULTIVATE `1484383444`, Kumarion
  `1460766817`, Kyle Watson `316000386`, Kyral X Banko `1241731177`, LAXX `487839237`, Levity
  `1505353688`, LICK `1307334531`, LIU KANG `1740540253`, and Lizdek `1208632523` were verified
  through 14 gated numeric Apple lookups plus one catalog cache hit, with zero failures, and applied
  transactionally. Exact normalized names agreed and their pending reviews were closed.
- User-supplied exact URLs for Lookas `851005361`, LYNY `1299141955`, Mako `76061125`, Malaa
  `1358486460`, Malixe `598962257`, Man Cub `1438900835`, MATT DOE `1354242210`, MEDZ
  `1490490040`, Megalodon `1373229367`, MEMBA `1108289318`, Michael Sparks `375669303`, Minnesota
  `25198137`, MitiS `476609914`, Morgan Page `6955705`, MPH `465495678`, and Mport `1244831715`
  were verified through 16 gated numeric Apple lookups with zero failures and applied transactionally.
  Exact normalized names agreed and their pending reviews were closed.
- User-supplied exact URLs for msft `1445042019`, MUERTE `864118080`, MUZZ `1471063703`, MVRDA
  `1434939342`, Nasko `1176983327`, NERVO `315216021`, Nico Falla `1489838428`, NITTI `266758200`,
  and Noisia `103804740` were verified through nine gated numeric Apple lookups with zero failures
  and applied transactionally. Exact normalized names agreed and their pending reviews were closed.
- User-supplied exact URLs for Of The Trees `587967131`, Oliverse `1040447357`, Original Sin
  `203545625`, Oski `256872311`, Paper Skies `1186943430`, Party Favor `646638705`, PEEKABOO
  `1254616353`, and PhaseOne `293699062` were verified through eight gated numeric Apple lookups with
  zero failures and applied transactionally. Exact normalized names agreed and their pending reviews
  were closed.
- User-supplied exact URLs for PIERCE `1403516802`, Pixel Terror `1159114651`, Prismo `718727168`,
  QUIX `944465851`, R!PT!DE `1661526208`, RageMode `1086722189`, RANKZ `1131004051`, REAPER
  `1296993709`, Rebel Scum `1337564511`, Rendah `1667504377`, RetroVision `531288445`, Rezz
  `1046759940`, RIOT `437755921`, Rival `60376564`, Rova `1601680475`, rSUN `1437328848`, Rueben
  `1592550904`, and Runnit `1314608577` were verified through 18 gated numeric Apple lookups with
  zero failures and applied transactionally. Exact normalized names agreed and their pending reviews
  were closed.

## Automated Validation

- Formatting: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across six workspaces.
- Unit tests: 388 passed in 52 files.
- PostgreSQL integration tests: 102 passed in 20 files, including a clean 22-migration test database.
- Production build: passed with 27 generated routes/pages.
- Playwright: 29 passed.
- `pnpm db:migrate`: passed and idempotent with 22 applied migrations.
- `pnpm doctor`: READY; no stale operation lock and no provider cooldown.
- `git diff --check`: passed.

## Implemented But Not Live-Verified

- Rich Apple Music API artist-view enrichment is implemented and mock-tested. Live validation used
  numeric iTunes lookup because Apple developer-token configuration is disabled locally.
- Unique direct MusicBrainz/Wikidata automatic confirmation is unit and integration tested, but the
  live sample produced no unique exact winner.

## Provider, Security, And Policy State

- Spotify remains connected but was not called. No Spotify mapping or playlist was read or changed.
- Spotify-derived data is excluded from Apple external requests, identity scores, persisted ranking
  evidence, and the Apple review API response.
- Apple Music developer-token configuration is disabled. No Apple cooldown or request lease exists.
- MusicBrainz is configured. Reddit remains approval-gated. SoundCloud automation remains excluded.

## Known Risks

- 87 Apple identities remain unresolved. Most have only ambiguous Apple-family catalog evidence.
- 40 unresolved review groups currently have persisted rankings; remaining groups need bounded
  catalog enrichment or exact user decisions.
- Apple/iTunes search agreement is not independent identity proof because both are Apple catalogs.
- Split-profile conflicts are preserved for review but multi-profile scanning remains unsupported.

## Immediate Next Step

Review the ranked Apple candidates already persisted, then configure Apple developer-token settings
for a bounded live canary of the richer Apple Music relationship views. After that evidence is
validated, enrich the remaining unresolved candidates in additional bounded passes. Any proposal to
auto-confirm from Apple-only soft signals requires a separate policy decision and a larger zero-false
calibration sample.

## Deferred

- Soft-signal-only automatic confirmation, split-profile scanning, Music User Tokens, Apple personal
  library access, Spotify-derived Apple matching, scheduler activation, additional providers, mixed
  playback, and playlist reordering.
