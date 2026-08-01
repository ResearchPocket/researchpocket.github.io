/**
 * Sends a returning owner straight to their library.
 *
 * The chooser exists to decide how to *create* a library. Someone who already
 * has one on this device has nothing to choose, so asking again is a step
 * between them and their saves.
 *
 * Two things keep this from being annoying in the other direction: it only
 * fires when a real library is present, and `?choose` opts out so the chooser
 * stays reachable for adding another library or restoring onto this device.
 */
const LIBRARY_DATABASE_PREFIX = "researchpocket";

async function openedLibraryExists(): Promise<boolean> {
  // Not universally available; without it the chooser is the safe answer.
  if (typeof indexedDB.databases !== "function") return false;
  try {
    const databases = await indexedDB.databases();
    return databases.some(
      (database) =>
        typeof database.name === "string" &&
        database.name.startsWith(LIBRARY_DATABASE_PREFIX) &&
        database.name !== `${LIBRARY_DATABASE_PREFIX}-profiles`,
    );
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.has("choose")) return;
  if (!(await openedLibraryExists())) return;
  // Replace rather than push so Back returns to wherever they came from
  // instead of bouncing through a chooser they never chose to see.
  window.location.replace("./app/");
}

void main();
