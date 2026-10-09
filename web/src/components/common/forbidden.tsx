import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./empty-state";

export function Forbidden({ message = "You don't have permission to view this page." }: { message?: string }) {
  return (
    <EmptyState
      icon={ShieldAlert}
      title="Not allowed"
      description={message}
      action={
        <Button asChild>
          <Link href="/">Back to home</Link>
        </Button>
      }
    />
  );
}
