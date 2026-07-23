import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Disable browser-native scroll restoration so a page refresh always
// starts at the top. Must run before React mounts (useEffect is too late).
history.scrollRestoration = "manual";

createRoot(document.getElementById("root")!).render(<App />);
