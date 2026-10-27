"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) router.replace("/dashboard");
        else router.replace("/login");
      })
      .catch(() => router.replace("/login"))
      .finally(() => setChecked(true));
  }, [router]);

  if (!checked) return <div className="p-10 text-center text-gray-400">Loading…</div>;
  return null;
}
