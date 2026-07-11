"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/terminal");
  }, [router]);
  return (
    <div className="flex items-center justify-center h-screen bg-[#0a0e17] text-white">
      <div className="text-center">
        <div className="animate-pulse text-xl font-mono">Loading Terminal...</div>
      </div>
    </div>
  );
}
