import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Unable to find root element with id 'root'.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
