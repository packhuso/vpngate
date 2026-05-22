import IpsPanel from "../ips-panel";

export const dynamic = "force-dynamic";

export default function IpsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <IpsPanel />
    </div>
  );
}
