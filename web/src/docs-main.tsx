import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DocsApp } from "./DocsApp.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

const rootElement = document.getElementById("docs-root");

if (!rootElement) {
  throw new Error("ResearchPocket could not find its reference root.");
}

createRoot(rootElement).render(
  <StrictMode>
    <DocsApp />
  </StrictMode>,
);
