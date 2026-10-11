import { QR_QUIET_ZONE, qrCode, qrPath } from '@/server/domain/qr-code';

/**
 * A QR code drawn on the server, as an inline picture.
 *
 * Black on white whatever the palette: a phone's camera reads contrast, and a
 * code in a dark theme's colours is one it cannot find. Nothing leaves the
 * page for it — no image address, no script — because what the Security
 * screen encodes is the authenticator's setup key.
 *
 * It is drawn at three pixels a module, within 180–280: a short address is
 * not a postage stamp, and a long one (an Arabic company name is six
 * characters a letter once it is in an address) still fits a phone's width.
 */
export function QrCode({ value, label }: { readonly value: string; readonly label: string }) {
  const code = qrCode(value);
  const span = code.size + 2 * QR_QUIET_ZONE;
  const side = Math.min(280, Math.max(180, span * 3));

  return (
    <svg
      aria-label={label}
      height={side}
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${span} ${span}`}
      width={side}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#fff" height={span} width={span} />
      <path d={qrPath(code)} fill="#000" />
    </svg>
  );
}
