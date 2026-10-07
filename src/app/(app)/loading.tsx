import { RouteSkeleton } from '@/components/states/route-skeleton';

/**
 * What a screen shows while it is being produced.
 *
 * Every page in this application is `force-dynamic`, so there is always a
 * server round trip between the click and the content. This file sits inside
 * the `(app)` layout, so the header and navigation stay exactly where they
 * were — only the page segment is swapped for this placeholder, and then for
 * the screen.
 *
 * Two signals, for two distances: a thin bar along the top of the viewport
 * says "something is happening" from across the room; a skeleton in the shape
 * of the screen being opened — Home's figures and charts, a register, a
 * document — reserves the space it will take, so nothing jumps when it lands.
 *
 * This one covers moving between modules and opening Home. A boundary covers
 * only the folder it sits in, so every folder whose children are screens has
 * a `loading.tsx` of its own drawing the same component (`RouteSkeleton`
 * explains why).
 */
export default function Loading() {
  return <RouteSkeleton />;
}
