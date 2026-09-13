export type PageDataMode = "database" | "error" | "mock";

export interface InitialPageDataSource<T> {
  feedMode: PageDataMode;
  initialItems: T[];
  watchlistMode: PageDataMode;
}

export function createInitialPageDataSource<T>(
  fixtures: readonly T[],
  explicitMockMode: boolean,
): InitialPageDataSource<T> {
  if (explicitMockMode) {
    return {
      feedMode: "mock",
      initialItems: [...fixtures],
      watchlistMode: "mock",
    };
  }

  return {
    feedMode: "error",
    initialItems: [],
    watchlistMode: "error",
  };
}
