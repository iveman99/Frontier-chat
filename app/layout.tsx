import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "iveman UI — Frontier Model Chat",
  description: "Chat with frontier AI models using your own AgentRouter API key.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
