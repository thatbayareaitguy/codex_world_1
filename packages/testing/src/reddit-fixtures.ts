export const syntheticRedditListing = {
  kind: "Listing" as const,
  data: {
    after: "t3_fixture2",
    children: [
      {
        kind: "t3" as const,
        data: {
          id: "fixture1",
          name: "t3_fixture1",
          subreddit: "EDM",
          title: "[FRESH] Lumen Field - Glass Horizon",
          selftext: "",
          is_self: false,
          url: "https://open.spotify.com/track/1234567890ABCDEFGHIJKL?si=synthetic",
          permalink: "/r/EDM/comments/fixture1/glass_horizon/",
          created_utc: 1_784_150_400,
          edited: false as const,
          link_flair_text: "New Music",
          removed_by_category: null,
          author: "must_not_be_persisted",
          score: 9_999,
        },
      },
      {
        kind: "t3" as const,
        data: {
          id: "fixture2",
          name: "t3_fixture2",
          subreddit: "dubstep",
          title: "New Music Friday - Synthetic roundup",
          selftext:
            "## Heavy\n- Oxide Echo - Static Bloom VIP [Mock Label] | [Spotify](https://open.spotify.com/track/ZYXWVUTSRQPONMLKJIHGFE)\n- Juniper Vale - Afterimage EP | https://soundcloud.com/juniper-vale/afterimage",
          is_self: true,
          url: "https://oauth.reddit.com/r/dubstep/comments/fixture2/roundup/",
          permalink: "/r/dubstep/comments/fixture2/roundup/",
          created_utc: 1_784_154_000,
          edited: false as const,
          link_flair_text: "Fresh",
          removed_by_category: null,
        },
      },
    ],
  },
};

export const syntheticDeletedRedditListing = {
  kind: "Listing" as const,
  data: { after: null, children: [] },
};
