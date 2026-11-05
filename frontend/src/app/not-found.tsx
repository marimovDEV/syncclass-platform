import Link from 'next/link';
import { Home, SearchX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/states';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh-screen max-w-xl flex-col items-center justify-center px-4">
      <EmptyState
        className="w-full"
        icon={<SearchX aria-hidden />}
        title="Sahifa topilmadi"
        description="Siz izlagan manzil mavjud emas yoki ko’chirilgan."
        action={
          <Button asChild>
            <Link href="/">
              <Home aria-hidden />
              Bosh sahifa
            </Link>
          </Button>
        }
      />
    </div>
  );
}
