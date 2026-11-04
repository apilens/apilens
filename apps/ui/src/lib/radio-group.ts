// Keyboard model of a radio group (WAI-ARIA APG "Radio Group"): one Tab stop, the checked radio
// (or the first enabled one when none is checked); arrow keys move to the next or previous enabled
// radio, wrapping, and check it; Home and End go to the first and last. Pure, so it can be tested.

/** The radio index a key moves to from `index`, or null when the key is not one the group handles. */
export function radioKeyTarget(key: string, index: number, disabled: readonly boolean[]): number | null {
  const n = disabled.length;
  if (n === 0 || disabled.every(Boolean)) return null;
  const step = (from: number, dir: 1 | -1) => {
    let i = from;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (!disabled[i]) return i;
    }
    return from;
  };
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return step(index, 1);
    case "ArrowUp":
    case "ArrowLeft":
      return step(index, -1);
    case "Home":
      return step(n - 1, 1);
    case "End":
      return step(0, -1);
    default:
      return null;
  }
}

/** The radio that takes the group's Tab stop: the checked one, else the first enabled one. */
export function radioTabStop(checked: number, disabled: readonly boolean[]): number {
  if (checked >= 0 && !disabled[checked]) return checked;
  return disabled.findIndex((d) => !d);
}
