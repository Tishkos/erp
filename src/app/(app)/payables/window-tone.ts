/**
 * A status box in the document window (`sapStatus`) is drawn in four tones:
 * posted/approved/matched (green), submitted (blue), rejected/cancelled/
 * reversed/exception (red), and everything else as a draft. The registers'
 * chips also say "settled" and "closed" — finished — which the window draws
 * as posted, so a received container or a fully paid application reads the
 * same in its box as in its list. Nothing new drawn.
 */
export function windowTone(chip: string): string {
  return chip === 'settled' || chip === 'closed' ? 'posted' : chip;
}
