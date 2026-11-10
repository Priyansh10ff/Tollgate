import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./landing/Landing";
import { Dashboard } from "./dashboard/Dashboard";
import "./base.css";

const isApp = window.location.pathname.startsWith("/app");
document.title = isApp ? "Tollgate · Dashboard" : document.title;

createRoot(document.getElementById("root")!).render(<StrictMode>{isApp ? <Dashboard /> : <Landing />}</StrictMode>);
