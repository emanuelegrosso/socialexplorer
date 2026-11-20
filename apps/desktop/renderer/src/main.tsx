import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createIpcClient } from "./ipc-client";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("root element missing");
}
createRoot(container).render(
  <StrictMode>
    <App client={createIpcClient()} />
  </StrictMode>,
);
