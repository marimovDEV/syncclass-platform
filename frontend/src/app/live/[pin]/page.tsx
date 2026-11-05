import { LiveRoomClient } from '@/app/live/[pin]/LiveRoomClient';

/**
 * `/live/[pin]` — jonli dars xonasi (CONTRACTS.md §10).
 *
 * AUDIT.md §G6: jonli xona holati faqat WS dan keladi, SSR da hech narsa yo'q —
 * shuning uchun sahifa `force-dynamic` (prerender urinishlari bo'lmaydi).
 */
export const dynamic = 'force-dynamic';

export default async function LiveRoomPage({ params }: { params: Promise<{ pin: string }> }) {
  const { pin } = await params;
  return <LiveRoomClient pin={pin} />;
}
