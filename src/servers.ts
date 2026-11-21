import { providerLabel, startBackends } from "./backends.ts";

await startBackends();
console.log(providerLabel());
