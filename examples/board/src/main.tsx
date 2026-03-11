/**
 * This module boots the native board example into the browser root.
 * It depends on the App component and is the only browser entrypoint for the Vite app.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
