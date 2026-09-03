import { researchUnclassifiedGenres, summarizeGenreEvidence } from "../lib/genre-evidence-store";
import { autoConfirmEligibleHighGenres } from "../lib/genre-editorial-store";
import { publicCatalog } from "../lib/public-catalog";

function numberArgument(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} requires a positive integer.`);
  return value;
}

async function main(): Promise<void> {
  const limit = numberArgument("--limit");
  const refresh = process.argv.includes("--refresh");
  const document = await researchUnclassifiedGenres({
    artists: publicCatalog.artists,
    ...(limit === undefined ? {} : { limit }),
    refresh,
    onProgress: ({ completed, total, artistName, confidence, sourceCount }) => {
      console.log(
        JSON.stringify({
          event: "showcase.genre_research.progress",
          completed,
          total,
          artistName,
          confidence,
          sourceCount,
        }),
      );
    },
  });

  console.log(
    JSON.stringify({
      event: "showcase.genre_research.complete",
      ...summarizeGenreEvidence(document),
    }),
  );
  if (process.argv.includes("--apply-high")) {
    const dataset = await autoConfirmEligibleHighGenres();
    console.log(
      JSON.stringify({
        event: "showcase.genre_research.high_applied",
        classifiedCount: dataset.classifiedCount,
        unclassifiedCount: dataset.unclassifiedCount,
      }),
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Genre research failed.");
  process.exitCode = 1;
});
