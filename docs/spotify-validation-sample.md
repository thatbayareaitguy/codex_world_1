# Completed Spotify Validation Sample

Status: approved by the user and completed on 2026-07-20 PDT.

Selected on 2026-07-19 from local PostgreSQL data only. Every row had an active watchlist membership and a confirmed Spotify artist mapping. Previously live-tested artists were excluded.

## Validation Result

- Batch: `03290ef4-4fd3-4086-bf4a-d69379514837`.
- Scan run: `fd8086a8-2151-4733-bf5c-ea3be7e5742c`.
- Window: 2026-07-20 21:04:55 to 21:13:51 PDT (8 minutes 57 seconds).
- Scope: exactly 50 approved artists, Spotify only, one page each, and a 2026-05-21 backfill cutoff.
- Provider metrics: 102 accounted requests and 103 telemetry events. The extra event was the initial handled artist-albums failure that triggered a token refresh and retry.
- Endpoint events: 50 successful `artist_albums`, 51 successful `album`, 1 successful `oauth_token`, and 1 handled `artist_albums` request failure.
- Minimum request-start interval: 5.004 seconds. HTTP 429: 0. Playlist requests: 0.
- Results: 500 release summaries inspected, 51 releases inside the backfill, 90 candidates, 46 new canonical releases, 83 new canonical tracks, 90 evidence rows, 84 feed rows, and 1 review row.
- All 50 artists are partial because Spotify reported another catalog page after the approved one-page limit. Twenty-two artists had legitimate zero-result scans.
- Idempotency: a one-page Alison Wonderland rerun made one `artist_albums` request and created zero releases, tracks, candidates, evidence, feed rows, or review rows.

|   # | Artist                  | Internal artist ID                     |
| --: | ----------------------- | -------------------------------------- |
|   1 | 12th Planet             | `45604801-1dca-40c8-a318-5ef2684dc6b4` |
|   2 | [BORDERS]               | `4489dfbf-5abf-4546-aee9-55b20b83f49a` |
|   3 | Alison Wonderland       | `54d2713d-4baa-4ef1-9910-2819e8faeae8` |
|   4 | Andromedik              | `16a32eb4-fdea-4b09-ae56-75506ac37a31` |
|   5 | Apashe                  | `1e6a7d3d-bbdd-4284-a6e0-133e10d333e6` |
|   6 | ATLiens                 | `78f3a01b-86f7-4e1f-8199-7b6cf53add5d` |
|   7 | Au5                     | `83e761cd-f593-4f57-af25-94b62c70c893` |
|   8 | Babsy.                  | `9ec1fcde-81e1-4c59-a568-3cb65292f379` |
|   9 | Bad Computer            | `55364e5f-0688-4e3b-93e6-e8419ae58582` |
|  10 | BARELY ALIVE            | `a4bd576a-67a0-4c3e-86e9-b8ac99dcd6d1` |
|  11 | Becky Hill              | `f94c6ce7-be70-4473-9ab5-a2695884b532` |
|  12 | Bensley                 | `4f8dfed5-f52b-4abf-bda2-b7fdbe3e372e` |
|  13 | Black Tiger Sex Machine | `40202ccd-f624-45a4-a9c9-8ef0e6290f20` |
|  14 | Blunts & Blondes        | `1da3ecfd-d1bb-4d37-a1e6-33c565dc0a2b` |
|  15 | BONNIE X CLYDE          | `bbda32e9-6ae9-48b3-90ed-766600b07944` |
|  16 | BRONSON                 | `3dc1cff9-bffb-45de-8b9a-e7537b3bd12d` |
|  17 | Calcium                 | `bfece175-df0d-429f-beb9-f3a077cf94d4` |
|  18 | Champagne Drip          | `392da3aa-84a5-49a0-b47a-fc5eff1aa01f` |
|  19 | Chime                   | `6e38764a-5884-4f4b-b769-0eb00fc8c586` |
|  20 | CloZee                  | `e9c30243-aeca-43ad-a5db-a126793e1369` |
|  21 | Code: Pandorum          | `36e4a768-f1fe-45fe-9fd1-ca5dbc493328` |
|  22 | Crankdat                | `aef60229-d889-4cb4-b4b2-1dc0b366feeb` |
|  23 | Daily Bread             | `c9844a60-a76c-45be-9992-2ce35353398a` |
|  24 | Deathpact               | `75fa5f65-29cd-4d6f-a18c-dd4cbc7a0453` |
|  25 | Dirtyphonics            | `4cec261e-2a08-4fd2-8f85-a40cb9978c97` |
|  26 | DJ Snake                | `8f304749-5411-4472-8709-6324cc4f72ca` |
|  27 | Doctor P                | `25053dea-f547-4125-b3e6-3d1978028627` |
|  28 | Dodge & Fuski           | `80fd5825-e9fa-4de2-be77-d2c2dae517a4` |
|  29 | Dom Dolla               | `02cd7ec2-c2b1-4074-a8bc-55bd985d9bb5` |
|  30 | DROELOE                 | `4dd0c04c-7551-4d52-bdaa-f8a9ea4c990d` |
|  31 | Ekko & Sidetrack        | `f7a6436a-a959-4bc9-a3cf-c8af33893f6d` |
|  32 | Eli & Fur               | `b20e696f-95b8-44f6-9f3d-cb2608811772` |
|  33 | Eptic                   | `8084301f-662c-4adb-996a-3f2863f82a87` |
|  34 | Excision                | `89cb8230-15a8-442e-bac7-a7132123c686` |
|  35 | Flux Pavilion           | `fe0e88ad-f467-432f-b51f-594e3766209d` |
|  36 | Fox Stevenson           | `830525f6-6b92-4eec-890d-ce5b1ddfbd80` |
|  37 | Ganja White Night       | `6f057af0-dbfe-42f1-bcbe-de85ec589e93` |
|  38 | goddard.                | `fac431ef-a2fc-410e-8c89-52f22fe51914` |
|  39 | Hi I'm Ghost            | `09df04b8-2c43-446d-aa19-05a84da56d63` |
|  40 | ILLENIUM                | `919f2492-8a53-4728-962b-b8f46ab2cc1b` |
|  41 | INFEKT                  | `8e5e6189-acc1-4be3-9829-5dc1969f7d32` |
|  42 | it's murph              | `0f00f499-44d7-4ea5-b754-3ee0cfea52af` |
|  43 | Jkyl & Hyde             | `e927cec9-6446-41cb-97bd-fcd8ad08d425` |
|  44 | Kx5                     | `4299debb-610f-461b-aad9-e679c6bae504` |
|  45 | Mandidextrous           | `7eb1fb01-a886-47d1-b813-e29de6595fb8` |
|  46 | MUST DIE!               | `90a6a017-761f-4615-8238-1d47ebd9992f` |
|  47 | Nikita, the Wicked      | `518dcfdd-5db9-4425-b8f5-5aab3151d45f` |
|  48 | nøll                    | `cd5b8e0e-b6ba-4bc3-9ba7-72b7bb174fea` |
|  49 | PLS&TY                  | `ffd29b4b-c97f-4db0-974a-9236125c735f` |
|  50 | Tiësto                  | `fc8017f1-e2c5-4ea8-ad67-e0c1b1fb5cd3` |

## Per-Artist Result

All rows scanned one page and persisted as `partial`.

| Artist                  | Requests | Backfill releases | Candidates |
| ----------------------- | -------: | ----------------: | ---------: |
| 12th Planet             |        2 |                 0 |          0 |
| [BORDERS]               |        1 |                 0 |          0 |
| Alison Wonderland       |        2 |                 1 |          1 |
| Andromedik              |        1 |                 0 |          0 |
| Apashe                  |        1 |                 0 |          0 |
| ATLiens                 |        2 |                 1 |          7 |
| Au5                     |        2 |                 1 |          4 |
| Babsy.                  |        2 |                 1 |          1 |
| Bad Computer            |        2 |                 1 |          1 |
| BARELY ALIVE            |        6 |                 5 |         11 |
| Becky Hill              |        3 |                 2 |          3 |
| Bensley                 |        1 |                 0 |          0 |
| Black Tiger Sex Machine |        3 |                 2 |          2 |
| Blunts & Blondes        |        1 |                 0 |          0 |
| BONNIE X CLYDE          |        1 |                 0 |          0 |
| BRONSON                 |        1 |                 0 |          0 |
| Calcium                 |        3 |                 2 |          2 |
| Champagne Drip          |        1 |                 0 |          0 |
| Chime                   |        4 |                 3 |          5 |
| CloZee                  |        1 |                 0 |          0 |
| Code: Pandorum          |        1 |                 0 |          0 |
| Crankdat                |        4 |                 3 |          5 |
| Daily Bread             |        2 |                 1 |          1 |
| Deathpact               |        2 |                 1 |          1 |
| Dirtyphonics            |        1 |                 0 |          0 |
| DJ Snake                |        6 |                 5 |          5 |
| Doctor P                |        2 |                 1 |          1 |
| Dodge & Fuski           |        2 |                 1 |          1 |
| Dom Dolla               |        2 |                 1 |          2 |
| DROELOE                 |        1 |                 0 |          0 |
| Ekko & Sidetrack        |        3 |                 2 |          3 |
| Eli & Fur               |        3 |                 2 |          7 |
| Eptic                   |        3 |                 2 |          2 |
| Excision                |        1 |                 0 |          0 |
| Flux Pavilion           |        2 |                 1 |          1 |
| Fox Stevenson           |        1 |                 0 |          0 |
| Ganja White Night       |        1 |                 0 |          0 |
| goddard.                |        2 |                 1 |          1 |
| Hi I'm Ghost            |        3 |                 2 |          5 |
| ILLENIUM                |        1 |                 0 |          0 |
| INFEKT                  |        2 |                 1 |          1 |
| it's murph              |        2 |                 1 |          1 |
| Jkyl & Hyde             |        3 |                 2 |          2 |
| Kx5                     |        1 |                 0 |          0 |
| Mandidextrous           |        1 |                 0 |          0 |
| MUST DIE!               |        5 |                 4 |         13 |
| Nikita, the Wicked      |        2 |                 1 |          1 |
| nøll                    |        1 |                 0 |          0 |
| PLS&TY                  |        1 |                 0 |          0 |
| Tiësto                  |        1 |                 0 |          0 |

Do not queue another Spotify batch or begin the remaining watchlist scan without explicit user approval.
