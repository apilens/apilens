// APILens brand kit logo as a lockup: the eagle and the wordmark are separate transparent
// files (no tile), so the gap between them is set here instead of baked into one image.
// Each is exported at several widths from the full-size kit artwork and chosen by srcSet,
// so the browser never has to shrink one large file (that is what made edges look jagged).
// Each file is drawn for one theme; both render and CSS shows the right one (app.css).

const WORDMARK_RATIO = 1544 / 240;
const EAGLE = [64, 96, 128, 192];
const WORDMARK = [96, 144, 192, 288, 384];

function Themed({ name, widths, w, h, alt = "" }: { name: string; widths: number[]; w: number; h: number; alt?: string }) {
  const set = (theme: string) => widths.map((x) => `/brand/${name}-${theme}-${x}.png ${x}w`).join(", ");
  const fallback = (theme: string) => `/brand/${name}-${theme}-${widths[widths.length - 1]}.png`;
  return (
    <>
      <img src={fallback("dark")} srcSet={set("dark")} sizes={`${w}px`} alt={alt} width={w} height={h} decoding="async" className="brand-art brand-art--on-dark" />
      <img src={fallback("light")} srcSet={set("light")} sizes={`${w}px`} alt="" aria-hidden="true" width={w} height={h} decoding="async" className="brand-art brand-art--on-light" />
    </>
  );
}

/**
 * - `wordmark`: the APILens text only (expanded sidebar). `height` is the text height.
 * - `icon`: the eagle only (collapsed rail).
 * - `lockup`: eagle + wordmark (auth screens). `height` is the eagle's height; the text is half of it.
 */
export function Logo({ variant = "lockup", height }: { variant?: "wordmark" | "icon" | "lockup"; height?: number }) {
  if (variant === "icon") return <Themed name="eagle" widths={EAGLE} w={32} h={31} alt="APILens" />;
  if (variant === "wordmark") {
    const h = height ?? 18;
    return <Themed name="wordmark" widths={WORDMARK} w={Math.round(h * WORDMARK_RATIO)} h={h} alt="APILens" />;
  }
  const eh = height ?? 30;
  const wh = Math.round(eh / 2);
  return (
    <span className="brand-lockup" role="img" aria-label="APILens" style={{ gap: Math.round(eh / 3) }}>
      <Themed name="eagle" widths={EAGLE} w={eh} h={Math.round(eh * 0.97)} />
      <Themed name="wordmark" widths={WORDMARK} w={Math.round(wh * WORDMARK_RATIO)} h={wh} />
    </span>
  );
}
