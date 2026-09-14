import { loadLocalEnvironment } from "./local-env";
import { parseSpotifyLiveSmokeOptions, runSpotifyLiveSmoke } from "./spotify-live-smoke";

loadLocalEnvironment();

try {
  const options = parseSpotifyLiveSmokeOptions(process.argv.slice(2));
  const summary = await runSpotifyLiveSmoke(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...summary,
        note: "No Spotify data was modified.",
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Spotify live smoke test failed."}\n`,
  );
  process.exitCode = 1;
}
