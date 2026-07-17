import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("ResearchPocket could not find its application root.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    const appRoot = new URL("./", document.baseURI);
    const legacyRoot = new URL("../", document.baseURI);
    const worker = new URL("../sw.js", document.baseURI);
    void navigator.serviceWorker
      .getRegistrations()
      .then(async (registrations) => {
        await Promise.all(
          registrations
            .filter((registration) => registration.scope === legacyRoot.href)
            .map((registration) => registration.unregister()),
        );
        await navigator.serviceWorker.register(worker.href, {
          scope: appRoot.pathname,
        });
      })
      .catch(() => undefined);
  });
}
