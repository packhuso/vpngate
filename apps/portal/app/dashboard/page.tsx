import TunnelsPanel from "./tunnels-panel";
import IpsPanel from "./ips-panel";

export default function Dashboard() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Dashboard</h1>
        <p className="page-subtitle">
          จัดการ tunnel + public IPs ของคุณ
        </p>
      </header>
      <TunnelsPanel />
      <IpsPanel />
    </div>
  );
}
