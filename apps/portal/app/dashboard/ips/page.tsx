import IpsPanel from "../ips-panel";

export const dynamic = "force-dynamic";

export default function IpsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <header>
        <h1 className="page-title">Public IPs</h1>
        <p className="page-subtitle">
          ซื้อ IP เก็บไว้ได้โดยไม่ต้องผูก tunnel — ค่าเช่าคิดต่อ IP / IP Block, ย้ายระหว่าง tunnel เมื่อไหร่ก็ได้
        </p>
      </header>
      <IpsPanel />
    </div>
  );
}
