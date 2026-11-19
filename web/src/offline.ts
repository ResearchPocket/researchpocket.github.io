export async function registerOfflineShell(): Promise<void> {
  const worker = new URL("../sw.js", document.baseURI);
  const retiredScopes = new Set([
    new URL("/app/", window.location.origin).href,
    new URL("/ResearchPocket/", window.location.origin).href,
    new URL("/ResearchPocket/app/", window.location.origin).href,
  ]);
  const registrations = await navigator.serviceWorker.getRegistrations();
  // Worker clients are matched by their own script URL. /assets/ must be in
  // scope too, or the domain worker cannot start offline (ADR 0017).
  const registration = await navigator.serviceWorker.register(worker.href, {
    scope: new URL("./", worker).pathname,
  });
  // Keep the previous offline shell until its replacement has installed.
  const installing = registration.installing ?? registration.waiting;
  if (installing) {
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (installing.state === "activated" || installing.state === "redundant") {
          installing.removeEventListener("statechange", check);
          if (installing.state === "activated") resolve();
          else reject(new Error("The offline shell could not be installed."));
        }
      };
      installing.addEventListener("statechange", check);
      check();
    });
  }
  await Promise.all(
    registrations
      .filter((previous) => retiredScopes.has(previous.scope))
      .map((previous) => previous.unregister()),
  );
}
