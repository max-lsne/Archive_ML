import { useEffect, useState } from "react";
import { api, type AppConfig } from "./api";
import { Home } from "./pages/Home";
import { ProjectPage } from "./pages/ProjectPage";

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (p: string) => {
    if (p !== window.location.pathname) window.history.pushState({}, "", p);
    setPath(p);
  };
  return [path, navigate];
}

export default function App() {
  const [path, navigate] = usePath();
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
  }, []);

  const m = path.match(/^\/p\/([A-Za-z0-9_-]+)/);
  if (m) {
    return <ProjectPage id={m[1]} live={config?.liveGeneration ?? false} onHome={() => navigate("/")} />;
  }
  return <Home config={config} onOpen={(id) => navigate(`/p/${id}`)} />;
}
