import type { FutureCatalogProvider, ScanContext } from "./contracts";

abstract class InterfaceOnlyProvider implements FutureCatalogProvider {
  abstract readonly name: "tidal";
  readonly implementationStatus = "interface_only" as const;

  scan(context: ScanContext): Promise<never> {
    void context;
    return Promise.reject(new Error(`${this.name} is a phase-two interface only`));
  }
}

export class TidalProviderContract extends InterfaceOnlyProvider {
  readonly name = "tidal" as const;
}
