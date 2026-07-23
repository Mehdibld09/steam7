import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Disable browser-native scroll restoration so a page refresh always
// starts at the top. Must run before React mounts (useEffect is too late).
history.scrollRestoration = "manual";

// If the app is loaded on the admin subdomain (e.g. admin.myweb.xyz),
// redirect to /admin so the admin panel opens automatically.
const hostname = window.location.hostname;
if (hostname.startsWith("admin.") && window.location.pathname === "/") {
  history.replaceState(null, "", "/admin");
}

createRoot(document.getElementById("root")!).render(<App />);
