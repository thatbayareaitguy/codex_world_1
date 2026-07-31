# Apple Music Recent-Release MVP Evaluation

Date: 2026-07-30

## Current optimization result

The `optimized_four_source` implementation and credential-free verification were committed and
pushed at `5089359cf5a3205af18b41d7366eb7037b326db9` before live execution. The bounded
experiment then used the same exact ten artists and fixed evaluation time as the prior MVP. It
made only the two newly required fresh operations for each artist:

- one minimal first-page `top-songs` request;
- one catalog search for the canonical artist name plus `Remix`, requesting separate album and
  song collections with the documented maximum `limit=25`.

Prior `singles` and `full-albums` pages remained frozen comparison evidence and were not
refetched. All ten persisted mappings were confirmed before the HTTP client and run were
created. No artist lookup, artist search, detail request, pagination request, or other-provider
request occurred.

The exact command was:

```powershell
pnpm apple:recent -- --execute-live --confirm-live APPLE_RECENT_MVP_SAMPLE --snapshot "C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-pilot-2026-07-28T18-00-19.json" --sample --evaluation-as-of "2026-07-29T23:59:59Z" --profile optimized_four_source
```

### Search-limit audit

The prior generic query was `<canonical artist name> Remix` with resource types
`albums,songs`. It omitted `limit`, so Apple applied the documented default of five results for
each requested type. Album and song results were separate collections. Sanitized prior evidence
shows that `LOL OK (Axel Boy Remix)` was absent from both returned collections. It was not
returned and rejected, and it was not lost during deduplication.

The corrected query keeps the same generic term and resource types, sets the documented
per-type maximum `limit=25`, makes one request per artist, and does not paginate. It does not
seed a title, remixer, or catalog identifier.

### Top Songs result

All ten `top-songs` requests returned HTTP 200 with ten resources and a top-level next cursor.
No cursor was followed. Old results were retained only as normalized evidence and rejected as
`date_out_of_scope`.

| Artist         | In-window eligible Top Songs discovery                 |
| -------------- | ------------------------------------------------------ |
| NURKO          | None                                                   |
| G-Space        | `Regenerate (feat. Injustice)`, exact frozen match     |
| BUNT.          | `World Away`, previously observed Apple-only candidate |
| SampliFire     | `Riddim N Dabs` and `Fusion`, exact frozen matches     |
| Vibe Chemistry | None                                                   |
| BARELY ALIVE   | None                                                   |
| Habstrakt      | None                                                   |
| MUST DIE!      | `LOL OK (Axel Boy Remix)`, recovered known release     |
| 1788-L         | None                                                   |
| 3LAU           | None                                                   |

The MUST DIE! result was discovered generically through `top-songs`. The song title contained
the explicit named remixer `Axel Boy`, and the safely confirmed parent-artist relationship bound
it to MUST DIE!. It was correctly classified
`remix_of_watched_artist_by_other`. Popularity was not used as direction evidence.

The persisted comparison marked this candidate Apple-only because the comparison function used
its parent album title, `Never Say Die Legacy`, rather than its song title. The song title is the
exact frozen release title and date. This is one deterministic matcher miss after successful
discovery, not a catalog miss, an Apple-only candidate, or an invalid directional match.

The widened search continued to find `All Cried Out (NURKO Remix)` in both album and song
collections. It did not find the MUST DIE! release and added no newly accepted in-window
candidate compared with the earlier default-size search.

### Strategy comparison

The recall denominator is seven primary releases plus three directional remixes in the frozen
30-day scope.

| Measure                            | A: current five-source | B: without latest | C: optimized four-source |
| ---------------------------------- | ---------------------: | ----------------: | -----------------------: |
| Primary recall                     |          7 / 7, 100.0% |     7 / 7, 100.0% |            7 / 7, 100.0% |
| Remix recall                       |           2 / 3, 66.7% |      2 / 3, 66.7% |            3 / 3, 100.0% |
| Combined discovery recall          |          9 / 10, 90.0% |     9 / 10, 90.0% |          10 / 10, 100.0% |
| Accepted candidates                |                     13 |                13 |                       14 |
| Automated exact frozen matches     |                      9 |                 9 |                        9 |
| Known matcher misses               |                      0 |                 0 |                        1 |
| Unconfirmed Apple-only candidates  |                      4 |                 4 |                        4 |
| False directional matches          |                      0 |                 0 |                        0 |
| Directionally uncertain candidates |                      0 |                 0 |                        0 |
| Requests per mapped artist         |                      5 |                 4 |                        4 |
| Requests for 593 mapped artists    |                  2,965 |             2,372 |                    2,372 |
| Minimum pacing time at 1,100 ms    |         about 54.4 min |    about 43.5 min |           about 43.5 min |

Strategy A uses `latest-release`, `singles`, `full-albums`, `appears-on-albums`, and search.
Strategy B removes `latest-release`. Prior persisted evidence contains zero eligible candidate
found only by `latest-release`, so B preserves all measured matches and accepted candidates.
Strategy C replaces both `latest-release` and `appears-on-albums` with `top-songs`, retaining
`singles`, `full-albums`, and search.

The four Apple-only candidates from the prior run remain unconfirmed. The recovered MUST DIE!
song is reported separately as a matcher miss and does not increase that count.

### Live request and persistence evidence

| Metric                      |    Result |
| --------------------------- | --------: |
| New Apple HTTP starts       |        20 |
| `top-songs` starts          |        10 |
| Widened catalog searches    |        10 |
| HTTP 200                    |        20 |
| Mapping or detail starts    |         0 |
| Pagination starts           |         0 |
| Retries                     |         0 |
| Cache hits                  |         0 |
| Minimum live-start interval |  1,108 ms |
| Maximum concurrency         |         1 |
| Runtime                     | 21,678 ms |
| Request budget remaining    |         5 |
| Historical HTTP starts      | 90 to 110 |

The run wrote ten reused mapping records, 68 normalized album rows, 335 normalized song rows,
403 candidate-evidence rows, and 20 sanitized response-cache rows in the isolated Apple
database. These are evidence-row counts, not accepted-candidate counts. The lease was released,
the queue is empty, no cooldown is active, and persistent `APPLE_MUSIC_ENABLED=false` remains
unchanged. The new cache rows contain no artwork, previews, sharing URLs, authorization data,
credentials, private-key information, or complete URLs.

### Decision and next milestone

Strategy C meets the provisional-selection rule: 7 of 7 primary recall, no invalid directional
match, 10 of 10 combined discovery recall, and four requests per mapped artist. It is selected
as the provisional strategy for a representative pilot, while the production default remains
unchanged.

The next milestone should first correct and credential-free test song-title comparison for
song-level candidates, then run the exact representative 25-artist cohort with fresh first pages
for `singles`, `full-albums`, and `top-songs` plus one widened generic remix search per confirmed
artist. It should use no pagination or detail requests, a base ceiling of 100 starts, a maximum
ceiling of 125 including temporary-5xx headroom, concurrency one, at least 1,100 milliseconds
between starts, and a 15-minute runtime ceiling. That milestone requires separate authorization.

This positive-heavy ten-artist result does not establish representative watchlist performance,
an Apple request allowance, production readiness, or merge readiness.

Official references:

- [Direct artist view](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-4kow5)
- [Artists Top Songs view](https://developer.apple.com/documentation/applemusicapi/artists/views/artiststopsongsview?changes=la_6_5)
- [Relationship-view response](https://developer.apple.com/documentation/applemusicapi/relationshipviewresponse?changes=_2_4)
- [Catalog search](https://developer.apple.com/documentation/applemusicapi/search?changes=_3)

## Prior MVP checkpoint and scope

The source, migration, tests, and pre-live documentation were committed and pushed at
`378c19590bd325b40e09e9536f38cbd6cf0e45de` before live execution. The bounded command then
evaluated exactly NURKO, G-Space, BUNT., SampliFire, Vibe Chemistry, BARELY ALIVE, Habstrakt,
MUST DIE!, 1788-L, and 3LAU against the frozen evaluation time
`2026-07-29T23:59:59Z`.

The run completed `recent_sample_completed`. It used the US storefront, concurrency one, at least
1,100 milliseconds between live request starts, no pagination, no retry, and no provider other
than Apple public catalog. Persistent `APPLE_MUSIC_ENABLED=false` was unchanged.

The exact command was:

```powershell
pnpm apple:recent -- --execute-live --confirm-live APPLE_RECENT_MVP_SAMPLE --snapshot "C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-pilot-2026-07-28T18-00-19.json" --sample --evaluation-as-of "2026-07-29T23:59:59Z"
```

The effective comparison window was the first-run 30-day window ending at the fixed evaluation
time. A later successful recurring scan begins at the later of the preceding successful
completion minus 48 hours and current time minus 30 days. Failed or incomplete runs do not
advance that timestamp.

The original 60-day frozen evidence contained 31 releases for this sample. Applying the final
30-day primary-release and bidirectional-remix scope reduced the ground truth to 10 releases.

## Mapping and per-artist results

All 10 artists reached a confirmed mapping outcome. Candidate counts in the arm columns are
source occurrences before cross-source deduplication. Arm B's two requests are incremental:
`latest-release` was fetched by Arm A and reused by Arm B.

| Artist         | Mapping                 | Original frozen | MVP scope | Arm A requests / occurrences | Arm B incremental requests / occurrences | Arm C requests / occurrences |
| -------------- | ----------------------- | --------------: | --------: | ---------------------------: | ---------------------------------------: | ---------------------------: |
| NURKO          | `evidence_confirmed`    |               4 |         2 |                        2 / 1 |                                    2 / 2 |                        2 / 1 |
| G-Space        | `existing_id_confirmed` |               4 |         1 |                        2 / 1 |                                    2 / 3 |                        2 / 0 |
| BUNT.          | `existing_id_confirmed` |               4 |         0 |                        2 / 2 |                                    2 / 2 |                        2 / 0 |
| SampliFire     | `existing_id_confirmed` |               4 |         2 |                        2 / 3 |                                    2 / 3 |                        2 / 0 |
| Vibe Chemistry | `search_confirmed`      |               4 |         0 |                        2 / 1 |                                    2 / 3 |                        2 / 0 |
| BARELY ALIVE   | `search_confirmed`      |               4 |         2 |                        2 / 2 |                                    2 / 3 |                        2 / 0 |
| Habstrakt      | `search_confirmed`      |               4 |         1 |                        2 / 1 |                                    2 / 2 |                        2 / 0 |
| MUST DIE!      | `search_confirmed`      |               3 |         2 |                        2 / 1 |                                    2 / 2 |                        2 / 0 |
| 1788-L         | `search_confirmed`      |               0 |         0 |                        2 / 0 |                                    2 / 0 |                        2 / 0 |
| 3LAU           | `search_confirmed`      |               0 |         0 |                        2 / 0 |                                    2 / 0 |                        2 / 0 |

The accepted, deduplicated candidates were:

| Artist         | Candidate                                   | Date       | Classification                     | Discovery source                               | Frozen comparison    |
| -------------- | ------------------------------------------- | ---------- | ---------------------------------- | ---------------------------------------------- | -------------------- |
| NURKO          | All Cried Out (NURKO Remix) - Single        | 2026-07-10 | `remix_by_watched_artist`          | catalog remix search, album result             | exact                |
| NURKO          | I Want You (PatFromLastYear Remix) - Single | 2026-07-17 | `remix_of_watched_artist_by_other` | `latest-release`, `singles`                    | exact                |
| G-Space        | Cross Your Mind - Single                    | 2026-07-03 | `primary_single`                   | `singles`                                      | Apple-only candidate |
| G-Space        | Regenerate (feat. Injustice) - Single       | 2026-07-15 | `primary_single`                   | `latest-release`, `singles`                    | exact                |
| BUNT.          | World Away - Single                         | 2026-07-24 | `primary_single`                   | `latest-release`, artist albums, `singles`     | Apple-only candidate |
| SampliFire     | Riddim N Dabs - Single                      | 2026-07-10 | `primary_single`                   | artist albums, `singles`                       | exact                |
| SampliFire     | Fusion - Single                             | 2026-07-24 | `primary_single`                   | `latest-release`, artist albums, `singles`     | exact                |
| Vibe Chemistry | Mate - Single                               | 2026-07-03 | `primary_single`                   | `singles`                                      | Apple-only candidate |
| Vibe Chemistry | Two Blueys - Single                         | 2026-07-24 | `primary_single`                   | `latest-release`, `singles`                    | Apple-only candidate |
| BARELY ALIVE   | 100% NO AI                                  | 2026-07-17 | `primary_album`                    | `latest-release`, artist albums, `full-albums` | exact                |
| BARELY ALIVE   | LEAVE IT ALL BEHIND - Single                | 2026-07-17 | `primary_single`                   | `singles`                                      | exact                |
| Habstrakt      | Everyday (VIP) - Single                     | 2026-07-22 | `primary_single`                   | `latest-release`, `singles`                    | exact                |
| MUST DIE!      | BLOODBATH AND BEYOND                        | 2026-07-10 | `primary_album`                    | `latest-release`, `full-albums`                | exact                |

There were no strong-probable or ambiguous release matches. Four accepted candidates were
Apple-only relative to the frozen snapshot. They are not proven false positives. The one scoped
Spotify ground-truth miss was `LOL OK (Axel Boy Remix)` for MUST DIE!, a
`remix_of_watched_artist_by_other`.

The two frozen releases labeled as EPs, `100% NO AI` and `Everyday (VIP)`, were discovered, but
the available Apple release metadata classified them as an album and a single respectively.
Discovery recall and cross-provider release-kind agreement are therefore separate measurements.

## Strategy results

### Primary releases

The scoped ground truth contained seven non-remix primary releases.

| Measurement                             |        Arm A |                               Arm B |
| --------------------------------------- | -----------: | ----------------------------------: |
| Primary-release recall                  | 6 / 7, 85.7% |                         7 / 7, 100% |
| Frozen single recall                    |   3 / 4, 75% |                         4 / 4, 100% |
| Frozen EP discovery recall              |  2 / 2, 100% |                         2 / 2, 100% |
| Frozen album recall                     |  1 / 1, 100% |                         1 / 1, 100% |
| Requests per confirmed artist           |            2 | 3 including shared `latest-release` |
| Total requests as a standalone strategy |           20 |                                  30 |
| Deduplicated eligible candidates        |            9 |                                  12 |
| Exact frozen matches                    |            7 |                                   8 |
| Provisional frozen-evidence precision   |        77.8% |                               66.7% |

Arm A found 7 of all 10 scoped releases because it also found NURKO's remix of a watched artist
by another remixer. Arm B found 8 of 10. Since all 10 artists mapped, full-sample and
mapped-artist recall are identical.

Arm B materially improved primary recall by recovering `LEAVE IT ALL BEHIND`, which was absent
from Arm A. The generic artist albums relationship did not add a unique accepted candidate that
was absent from the split views in this sample.

### Remix supplement

The scoped ground truth contained three remixes: one remix by a watched artist and two remixes of
watched artists by other remixers.

- The catalog remix search found `All Cried Out (NURKO Remix)` and classified it
  `remix_by_watched_artist`.
- `appears-on-albums` found no accepted remix.
- Ordinary primary-release views found `I Want You (PatFromLastYear Remix)` and classified it
  `remix_of_watched_artist_by_other`.
- `LOL OK (Axel Boy Remix)` was not found.
- Remix recall was 2 of 3, or 66.7%.
- Arm C alone used 20 requests, found one known remix, produced no false directional match, and
  produced no `remix_direction_uncertain` candidate.

NURKO met the bidirectional acceptance case. Both July remixes were discovered, their directions
were distinct and correct, and the watched-artist remix came from catalog search rather than
`appears-on-albums`. The June 26 EP was returned but classified `date_out_of_scope`; the June 6
single was also outside the fixed comparison window and was not admitted.

### Combined result

Arm B plus Arm C found 9 of 10 scoped releases, or 90% recall. The combined accepted set contained
13 deduplicated candidates: nine exact frozen matches and four Apple-only candidates. Provisional
frozen-evidence precision was therefore 69.2%. There were zero strong-probable matches, ambiguous
matches, and invalid directional remix matches.

These precision values measure agreement with a frozen Spotify evidence set. They do not prove
that Apple-only candidates are incorrect.

## Latest-release contribution

Eight eligible candidates appeared in `latest-release`. Every one also appeared in artist
albums, `singles`, or `full-albums`. It contributed zero unique in-window accepted candidates in
this sample.

The current implementation must remain unchanged after live execution. For the next milestone,
the measured recommendation is to test Arm B without `latest-release`. That would preserve all
observed Arm B candidates while reducing primary discovery from three to two requests per mapped
artist. This is a sample result, not proof that `latest-release` never adds value.

## Freshness, errors, and persistence

All 60 discovery first pages were fetched live with run-scoped cache identities. Historical
discovery cache rows did not satisfy current discovery. One mapping request used permitted cache
evidence. No arm followed pagination.

The run recorded three HTTP 404 responses for the supported `appears-on-albums` view. They were
nonterminal, uncached, and not retried. Artist attribution for those aggregate errors is
intentionally unavailable from sanitized telemetry. The other 65 live requests returned HTTP 200. There were no HTTP 400, 401, 403, 429, or 5xx responses.

Sixty-five normalized response-cache rows and 420 scoped candidate-evidence rows were written.
The candidate table retains accepted and rejected classifications, so its row count is not the
accepted-candidate count. There were no duplicate candidate identities within a watched-artist
scope. The normalized cache contains no artwork, preview, sharing-URL, authorization, token, or
private-key fields.

## Request evidence

| Metric                          |    Result |
| ------------------------------- | --------: |
| New Apple HTTP starts           |        68 |
| Mapping artist lookups          |         2 |
| Mapping searches                |         6 |
| `latest-release` first pages    |        10 |
| Artist albums first pages       |        10 |
| `singles` first pages           |        10 |
| `full-albums` first pages       |        10 |
| `appears-on-albums` first pages |        10 |
| Catalog remix searches          |        10 |
| Album or song detail requests   |         0 |
| Pagination requests             |         0 |
| Retries                         |         0 |
| HTTP 200                        |        65 |
| HTTP 404                        |         3 |
| Permitted mapping cache hits    |         1 |
| Minimum live-start interval     |  1,107 ms |
| Maximum concurrency             |         1 |
| Runtime                         | 74,991 ms |
| Request budget remaining        |        32 |

The historical real Apple HTTP-start total advanced from 22 to 90. The run released its lease,
left the queue at zero, and created no cooldown.

## Provisional MVP and operating projection

The provisional measured winner is Arm B plus Arm C. Arm B recovered all seven scoped primary
releases, while Arm C supplied the otherwise-missing NURKO remix. The combined strategy still
missed one known remix, so it is not production-ready.

At the currently measured request shape, Arm B plus Arm C costs five discovery requests per
mapped artist: `latest-release`, `singles`, `full-albums`, `appears-on-albums`, and one catalog
remix search. For 593 mapped artists:

- primary discovery: 1,779 starts;
- remix discovery: 1,186 starts;
- total discovery with stable mappings and no detail work: 2,965 starts, about 54.4 minutes at
  1,100 ms pacing;
- mapping refresh: zero when confirmed mappings remain reusable, or about 475 starts if the
  sample's 8-of-10 mapping-start rate repeated;
- targeted detail work: zero was measured; a one-per-artist contingency adds up to 593 starts;
- measured-shape total with sample-rate mapping refresh: about 3,440 starts and 63.1 minutes;
- adding the full one-detail-per-artist contingency raises that to about 4,033 starts and
  73.9 minutes.

The positive-heavy 10-artist sample does not establish candidate prevalence or mapping-refresh
rates for all 593 artists. The next live experiment should compare Arm B with and without
`latest-release`, and should test a more targeted way to recover the known missed remix without
adding historical pagination. A representative 25-artist sample is required before production
architecture or scheduling decisions.

## Safety and evidence classification

- Exactly the approved 10 artists were processed.
- No Spotify, iTunes, MusicBrainz, SoundCloud, or other-provider telemetry was created during the
  live interval.
- No production scanner, scheduler, feed, playlist, or runtime database was used or mutated.
- The Apple lease is released, the queue is empty, no cooldown is active, and
  `APPLE_MUSIC_ENABLED=false`.
- No credential, authorization value, private-key information, raw response, complete request or
  response URL, artwork, preview, or numeric Apple catalog identifier appears in this report.
- Recent-release MVP: implemented and credential-free tested.
- Exact 10-artist sample: live-tested.
- Provisional strategy: Arm B plus Arm C.
- Representative 25-artist test: not completed.
- Production integration and merge: not authorized.

Official operation references remain:

- [Apple catalog artist view](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-4kow5)
- [Apple catalog artist relationship](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5akdm)
- [Apple Music catalog search](https://developer.apple.com/documentation/applemusicapi/search)
