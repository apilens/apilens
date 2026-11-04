// Sidebar link styles compared on /design/nav (plain data, usable from server components).
export const VARIANTS = [
  { id: "a", name: "A · Current", spec: "Neutral fill on active · outline icons, solid when active · 32px rows · 13.5px" },
  { id: "b", name: "B · Accent bar", spec: "No fill · 2px indigo bar on the left · active icon in indigo · 32px · 13.5px" },
  { id: "c", name: "C · Tinted", spec: "Soft indigo fill · indigo text and icon when active · 32px · 13.5px" },
  { id: "d", name: "D · Dense (Linear)", spec: "28px rows · 13px · 16px icons · quiet fill · most items visible" },
  { id: "e", name: "E · Roomy (Vercel)", spec: "36px rows · 14px · 20px icons · 10px corners · bolder active" },
  { id: "f", name: "F · Text first", spec: "No icons · 14px · active is bold white with a dot · calmest" },
] as const;
export type VariantId = (typeof VARIANTS)[number]["id"];
