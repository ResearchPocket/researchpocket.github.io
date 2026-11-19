import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { registerOfflineShell } from "./offline.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("ResearchPocket could not find its application root.");
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void registerOfflineShell().catch(() => undefined);
  });
}
