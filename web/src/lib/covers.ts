/**
 * Page covers are stored on the page (`cover`) as a preset id from this list. Unknown ids render as
 * no cover so newer cover kinds (e.g. uploaded images) degrade gracefully on older clients.
 */
export interface CoverPreset {
  id: string;
  label: string;
  /** CSS `background` value */
  background: string;
}

export const COVER_PRESETS: readonly CoverPreset[] = [
  { id: "sunset", label: "Sunset", background: "linear-gradient(135deg, #f6d365 0%, #fda085 100%)" },
  { id: "peach", label: "Peach", background: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)" },
  { id: "rose", label: "Rose", background: "linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)" },
  { id: "lavender", label: "Lavender", background: "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)" },
  { id: "ocean", label: "Ocean", background: "linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)" },
  { id: "mint", label: "Mint", background: "linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)" },
  { id: "meadow", label: "Meadow", background: "linear-gradient(135deg, #56ab2f 0%, #a8e063 100%)" },
  { id: "dusk", label: "Dusk", background: "linear-gradient(135deg, #2c3e50 0%, #4ca1af 100%)" },
  { id: "night", label: "Night", background: "linear-gradient(135deg, #232526 0%, #414345 100%)" },
  { id: "sand", label: "Sand", background: "#e8dcc8" },
  { id: "sage", label: "Sage", background: "#cfd8c5" },
  { id: "sky", label: "Sky", background: "#cde3f5" },
  { id: "blush", label: "Blush", background: "#f3d6d6" },
  { id: "stone", label: "Stone", background: "#d7d6d2" },
  { id: "ink", label: "Ink", background: "#37352f" },
];

export function coverBackground(id: string | null | undefined): string | null {
  if (!id) return null;
  return COVER_PRESETS.find((c) => c.id === id)?.background ?? null;
}
