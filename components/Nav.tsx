"use client";

import Link from "next/link";

export function Nav({ user }: { user: { name: string; role: string } }) {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }
  return (
    <div className="border-b border-[#232833] bg-[#0d1015]">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <span className="font-bold">X Panel</span>
          <Link href="/dashboard" className="text-sm text-gray-300 hover:text-white">
            Dashboard
          </Link>
          <Link href="/dm" className="text-sm text-gray-300 hover:text-white">
            DM Backend
          </Link>
          {user.role === "admin" && (
            <Link href="/admin" className="text-sm text-gray-300 hover:text-white">
              Admin
            </Link>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">
            {user.name} · {user.role}
          </span>
          <button className="btn btn-ghost" onClick={logout}>
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}
