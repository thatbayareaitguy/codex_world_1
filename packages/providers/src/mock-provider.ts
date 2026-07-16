import type { ProviderScanResult, TrackCandidate } from "@radar/core";
import type { DiscoveryProvider, ScanContext } from "./contracts";
import { mockResponseSchema } from "./schemas";

export class MockProvider implements DiscoveryProvider {
  readonly name = "mock" as const;

  constructor(private readonly fixture: unknown) {}

  async scan(context: ScanContext): Promise<ProviderScanResult> {
    const parsed = mockResponseSchema.parse(this.fixture);
    const validatedCandidates = parsed.candidates as TrackCandidate[];
    const candidates = validatedCandidates.filter((candidate) => {
      if (context.filter.provider && context.filter.provider !== this.name) return false;
      if (
        context.filter.artistExternalId &&
        candidate.artistExternalId !== context.filter.artistExternalId
      ) {
        return false;
      }
      return true;
    });

    return Promise.resolve({
      candidates,
      ...(parsed.nextCursor ? { nextCursor: parsed.nextCursor } : {}),
    });
  }
}
