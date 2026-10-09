"use client";

import { useParams } from "next/navigation";
import { InviteView } from "./invite-view";

export function InviteRoute() {
  const { token } = useParams<{ token: string }>();
  return <InviteView token={decodeURIComponent(token)} />;
}
