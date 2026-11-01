import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface AppInfo {
  name: string;
  version: string;
}

function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    invoke<AppInfo>("app_info").then(setInfo);
  }, []);

  return (
    <main className="container">
      <h1>Perseus</h1>
      <p>{info ? `${info.name} v${info.version}` : "Loading…"}</p>
    </main>
  );
}

export default App;
