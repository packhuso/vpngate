import TunnelsPanel from "../tunnels-panel";

export const dynamic = "force-dynamic";

export default function TunnelsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <TunnelsPanel />
    </div>
  );
}
