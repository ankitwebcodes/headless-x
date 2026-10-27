import type { Metadata } from "next";
import "./globals.css";
import { Protect } from "../components/Protect";

export const metadata: Metadata = {
  title: "X Panel — Composer",
  description: "Post videos to X with website-link cards",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}<Protect /></body>
    </html>
  );
}