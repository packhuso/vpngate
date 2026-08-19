import TunnelsPanel from "../tunnels-panel";

export const dynamic = "force-dynamic";

export default function TunnelsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Tunnels</h1>
        <p className="page-subtitle">
          แต่ละ tunnel = 1 VPN peer มี speed tier ของตัวเอง, ผูก/ปลด public IP ได้
        </p>
      </header>
      <TunnelsPanel />
    </div>
  );
}
