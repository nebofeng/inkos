import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installAuthFetchGuard } from "./lib/auth-client";

// Session expired / logged out elsewhere → back to the login page (src/api/auth).
installAuthFetchGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
