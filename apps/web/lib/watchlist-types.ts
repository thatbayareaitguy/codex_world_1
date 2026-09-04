export interface WatchlistArtistViewModel {
  active: boolean;
  addedAt: string;
  id: string;
  name: string;
  providers: string[];
  source: string;
  spotifyCoverage: {
    catalogPagesCompleted: number;
    dailyScanCompletedAt: string | null;
    lastFullReconciliationAt: string | null;
    nextOffset: number;
    pagesScannedInCycle: number;
    partial: boolean;
    status: string;
  } | null;
}
