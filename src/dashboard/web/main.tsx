import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { HttpReviewDashboardClient } from "./api-client.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Review dashboard root element is missing");

createRoot(root).render(
  <StrictMode>
    <App client={new HttpReviewDashboardClient()} />
  </StrictMode>,
);
