// Tiny client-side event bus so the dashboard panels (Tunnels + Public IPs)
// stay in sync. They're separate components with their own fetched state, so a
// mutation in one (assign/move/buy/release/create/delete) must refresh the
// other — e.g. assigning an IP in IpsPanel must update the IP list shown per
// tunnel in TunnelsPanel. Any mutation calls notifyDataChanged(); every panel
// listens via onDataChanged() and refetches.
"use client";

export const DATA_CHANGED = "vpnhub:data-changed";

export function notifyDataChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DATA_CHANGED));
  }
}

/** Subscribe to data-changed; returns an unsubscribe fn (use in useEffect). */
export function onDataChanged(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DATA_CHANGED, handler);
  return () => window.removeEventListener(DATA_CHANGED, handler);
}

/** Confirm dialog before assign / unassign / move of a public IP. Warns that
 *  routing takes a short while to propagate so the change isn't instant.
 *  Returns true if the user confirmed. */
export function confirmIpChange(action: string, ip: string): boolean {
  if (typeof window === "undefined") return false;
  return window.confirm(
    `${action}\n` +
      `IP: ${ip}\n\n` +
      `⏳ เมื่อยืนยันแล้ว ระบบจะปรับเส้นทาง (route) ของ IP ให้อัตโนมัติ\n` +
      `อาจใช้เวลาสักครู่ ราว 1-2 นาที กว่าจะใช้งานได้สมบูรณ์\n` +
      `ระหว่างนั้น IP อาจ ping ไม่เจอ / ใช้งานไม่ได้ชั่วคราว — เป็นเรื่องปกติ\n\n` +
      `ต้องการดำเนินการต่อหรือไม่?`,
  );
}
