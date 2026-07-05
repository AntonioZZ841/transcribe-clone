/** Pretty-print a chord label with proper accidental glyphs. */
export function prettyLabel(label: string): string {
  return label.replace(/b(?=[0-9]|$|\/)/g, '♭').replace(/#/g, '♯');
}
